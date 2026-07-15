import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { AdAttributionProvider } from '@meigallery/shared'
import { readAttributionConnectionSnapshot } from '../services/ad-platform/connections'
import { readAttributionCredential } from '../services/ad-platform/credential-vault'
import {
  getPlatformVerificationAdapter,
  PlatformVerificationError,
  type PlatformAutomaticVerificationEvidence,
} from '../services/ad-platform/verification-adapter'
import {
  decryptAttributionValue,
  encryptAttributionValue,
  loadAttributionCryptoKeys,
  type AttributionEncryptedEnvelope,
} from '../utils/attribution-crypto'

const VERIFICATION_STATUSES = new Set([
  'queued', 'running', 'awaiting_human_evidence', 'verified', 'failed', 'timed_out', 'invalidated',
])

export interface AdPlatformVerificationWorkflowParams {
  verificationId: string
}

export interface AdPlatformVerificationEnv {
  DB: D1Database
  APP_ENV: string
  SITE_URL?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
  AD_PLATFORM_VERIFICATION_WORKFLOW: Workflow<AdPlatformVerificationWorkflowParams>
}

export interface StartPlatformVerificationInput {
  provider: AdAttributionProvider
  actorId: number
  testEventCode?: string
  reverify?: boolean
}

type VerificationRow = {
  id: string
  connection_id: string
  provider: string
  connection_revision: string
  credential_revision: string
  attempt: number
  status: string
  evidence_json: string
  started_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

type StoredVerificationState = {
  schemaVersion: 1
  verificationInput?: AttributionEncryptedEnvelope
  automatic?: PlatformAutomaticVerificationEvidence
  human?: { confirmed: true; reference?: string; confirmedAt: string }
  failureCode?: string
}

export class AdPlatformVerificationWorkflow extends WorkflowEntrypoint<
  AdPlatformVerificationEnv,
  AdPlatformVerificationWorkflowParams
> {
  async run(event: Readonly<WorkflowEvent<AdPlatformVerificationWorkflowParams>>, step: WorkflowStep) {
    const verificationId = validIdentifier(event.payload.verificationId) ? event.payload.verificationId : ''
    if (!verificationId) return { status: 'failed', code: 'AD_PLATFORM_VERIFICATION_INPUT_INVALID' }

    let automatic: PlatformAutomaticVerificationEvidence
    try {
      automatic = await step.do('执行平台自动验证', {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '30 seconds',
      }, async () => this.runAutomaticVerification(verificationId))
    }
    catch (error) {
      const code = verificationFailureCode(error)
      await step.do('清理失败验证输入', async () => {
        await failVerification(this.env.DB, verificationId, code)
        return { status: 'failed', code }
      })
      return { status: 'failed', code }
    }

    let evidenceEvent: Awaited<ReturnType<WorkflowStep['waitForEvent']>>
    try {
      evidenceEvent = await step.waitForEvent('等待人工平台证据', {
        type: 'human-evidence',
        timeout: '24 hours',
      })
    }
    catch {
      await step.do('标记验证超时', async () => {
        await completeVerification(this.env.DB, verificationId, 'timed_out', {
          schemaVersion: 1,
          automatic,
          failureCode: 'AD_PLATFORM_VERIFICATION_EVIDENCE_TIMEOUT',
        })
        return { status: 'timed_out' }
      })
      return { status: 'timed_out' }
    }

    const submittedEvidence = parseHumanEvidence(evidenceEvent.payload)
    if (!submittedEvidence) {
      await step.do('拒绝无效人工证据', async () => {
        await completeVerification(this.env.DB, verificationId, 'failed', {
          schemaVersion: 1,
          automatic,
          failureCode: 'AD_PLATFORM_VERIFICATION_EVIDENCE_INVALID',
        })
        return { status: 'failed' }
      })
      return { status: 'failed', code: 'AD_PLATFORM_VERIFICATION_EVIDENCE_INVALID' }
    }

    return step.do('完成连接验证', async () => {
      const status = await finalizeVerified(this.env.DB, verificationId, {
        schemaVersion: 1,
        automatic,
        human: submittedEvidence.human,
      }, submittedEvidence.actorId)
      return { status }
    })
  }

  private async runAutomaticVerification(verificationId: string) {
    const row = await readVerificationRow(this.env.DB, verificationId)
    if (!row || !validProvider(row.provider)) {
      throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
    }
    const adapter = getPlatformVerificationAdapter(row.provider)
    if (!adapter) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
    const provider = adapter.provider
    const snapshot = await readAttributionConnectionSnapshot(this.env.DB, provider)
    if (snapshot.state !== 'ready'
      || snapshot.connection.id !== row.connection_id
      || snapshot.connection.connectionRevision !== row.connection_revision
      || snapshot.connection.credentialRevision !== row.credential_revision) {
      throw new Error('AD_PLATFORM_VERIFICATION_REVISION_INVALID')
    }
    const stored = parseStoredState(row.evidence_json)
    const testEventCode = stored.verificationInput
      ? await decryptVerificationInput(this.env, row, stored.verificationInput)
      : undefined
    const credential = await readAttributionCredential(this.env, {
      connectionId: row.connection_id,
      provider,
      credentialType: snapshot.credential.type,
      credentialRevision: row.credential_revision,
    })
    const running = await this.env.DB.prepare(`
      UPDATE attribution_verifications
      SET status = 'running', updated_at = datetime('now')
      WHERE id = ? AND status IN ('queued', 'running')
    `).bind(verificationId).run()
    if (!d1Changed(running)) throw new Error('AD_PLATFORM_VERIFICATION_REVISION_INVALID')
    const automatic = await adapter.verify({
      verificationId,
      provider,
      publicConfig: snapshot.connection.publicConfig,
      eventBindings: [...snapshot.bindings.entries()].map(([canonicalEvent, binding]) => ({
        canonicalEvent,
        ...binding,
      })),
      credential,
      testEventCode,
      siteUrl: String(this.env.SITE_URL || ''),
    })
    const awaiting = await this.env.DB.prepare(`
      UPDATE attribution_verifications
      SET status = 'awaiting_human_evidence', evidence_json = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'running'
        AND connection_revision = ? AND credential_revision = ?
        AND EXISTS (
          SELECT 1 FROM attribution_platform_connections connection
          WHERE connection.id = attribution_verifications.connection_id
            AND connection.provider = attribution_verifications.provider
            AND connection.connection_revision = attribution_verifications.connection_revision
            AND connection.credential_revision = attribution_verifications.credential_revision
        )
    `).bind(
      JSON.stringify({ schemaVersion: 1, automatic } satisfies StoredVerificationState),
      verificationId,
      row.connection_revision,
      row.credential_revision,
    ).run()
    if (!d1Changed(awaiting)) throw new Error('AD_PLATFORM_VERIFICATION_REVISION_INVALID')
    return automatic
  }
}

export async function startPlatformVerification(
  env: AdPlatformVerificationEnv,
  input: StartPlatformVerificationInput,
) {
  validateStartInput(env, input)
  const snapshot = await readAttributionConnectionSnapshot(env.DB, input.provider)
  if (snapshot.state !== 'ready') throw new Error('AD_PLATFORM_CONNECTION_INVALID')
  if (snapshot.connection.mode !== 'production') throw new Error('AD_PLATFORM_VERIFICATION_PRODUCTION_MODE_REQUIRED')

  const current = await readLatestCurrentVerification(env.DB, snapshot.connection.id, input.provider, snapshot.connection.connectionRevision, snapshot.connection.credentialRevision)
  if (!input.reverify && current) {
    if (current.status === 'queued' || current.status === 'running' || current.status === 'awaiting_human_evidence') {
      await ensureWorkflow(env, current.id)
    }
    return serializeVerification(current)
  }
  const attempt = current ? current.attempt + 1 : await nextVerificationAttempt(env.DB, snapshot.connection.id, input.provider)
  const verificationId = await createWorkflowId({
    provider: input.provider,
    connectionId: snapshot.connection.id,
    connectionRevision: snapshot.connection.connectionRevision,
    credentialRevision: snapshot.connection.credentialRevision,
    attempt,
  })
  const stored = await createStoredVerificationInput(env, input, verificationId, snapshot.connection.connectionRevision)
  const startedAt = new Date().toISOString()
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO attribution_verifications (
        id, connection_id, provider, connection_revision, credential_revision,
        attempt, status, evidence_json, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, datetime('now'))
    `).bind(
      verificationId,
      snapshot.connection.id,
      input.provider,
      snapshot.connection.connectionRevision,
      snapshot.connection.credentialRevision,
      attempt,
      JSON.stringify(stored),
      startedAt,
    ),
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      )
      SELECT ?, ?, ?, 'ad_platform_verification', ?, '{}', ?
      WHERE changes() = 1
    `).bind(
      crypto.randomUUID(),
      input.actorId,
      input.reverify ? 'restart_ad_platform_verification' : 'start_ad_platform_verification',
      verificationId,
      JSON.stringify({
        provider: input.provider,
        connectionRevision: snapshot.connection.connectionRevision,
        credentialRevision: snapshot.connection.credentialRevision,
        attempt,
      }),
    ),
  ])
  if (!results[0] || !d1Changed(results[0])) {
    const existing = await readVerificationRow(env.DB, verificationId)
    if (!existing) throw new Error('AD_PLATFORM_VERIFICATION_CONFLICT')
    await ensureWorkflow(env, verificationId)
    return serializeVerification(existing)
  }
  await ensureWorkflow(env, verificationId)
  const created = await readVerificationRow(env.DB, verificationId)
  if (!created) throw new Error('AD_PLATFORM_VERIFICATION_CREATE_FAILED')
  return serializeVerification(created)
}

export async function getPlatformVerification(
  db: D1Database,
  provider: AdAttributionProvider,
  verificationId?: string,
) {
  const row = verificationId
    ? await readVerificationRow(db, verificationId)
    : await db.prepare(`
      SELECT verification.*
      FROM attribution_verifications AS verification
      JOIN attribution_platform_connections AS connection
        ON connection.id = verification.connection_id
        AND connection.provider = verification.provider
        AND connection.connection_revision = verification.connection_revision
        AND connection.credential_revision = verification.credential_revision
      WHERE verification.provider = ?
      ORDER BY verification.attempt DESC, verification.created_at DESC LIMIT 1
    `).bind(provider).first<VerificationRow>()
  if (!row || row.provider !== provider) return null
  return serializeVerification(row)
}

export async function submitPlatformVerificationEvidence(
  env: AdPlatformVerificationEnv,
  input: { provider: AdAttributionProvider; verificationId: string; actorId: number; reference?: string },
) {
  if (!Number.isSafeInteger(input.actorId) || input.actorId <= 0) {
    throw new Error('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
  }
  const row = await readVerificationRow(env.DB, input.verificationId)
  if (!row || row.provider !== input.provider) throw new Error('AD_PLATFORM_VERIFICATION_NOT_FOUND')
  if (row.status !== 'awaiting_human_evidence') throw new Error('AD_PLATFORM_VERIFICATION_EVIDENCE_NOT_EXPECTED')
  const reference = normalizeEvidenceReference(input.reference)
  const instance = await env.AD_PLATFORM_VERIFICATION_WORKFLOW.get(input.verificationId)
  await instance.sendEvent({
    type: 'human-evidence',
    payload: { confirmed: true, actorId: input.actorId, ...(reference ? { reference } : {}) },
  })
  return serializeVerification(row)
}

export async function createWorkflowId(input: {
  provider: AdAttributionProvider
  connectionId: string
  connectionRevision: string
  credentialRevision: string
  attempt: number
}) {
  const logical = [
    'verify', input.provider, input.connectionId,
    input.connectionRevision, input.credentialRevision, String(input.attempt),
  ].join(':')
  if (logical.length <= 100 && validIdentifier(logical)) return logical
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(logical)))
  return `verify:${input.provider}:${base64Url(digest)}`
}

async function ensureWorkflow(env: AdPlatformVerificationEnv, verificationId: string) {
  try {
    const created = await env.AD_PLATFORM_VERIFICATION_WORKFLOW.createBatch([{
      id: verificationId,
      params: { verificationId },
      retention: { successRetention: '3 days', errorRetention: '3 days' },
    }])
    if (created.length > 0) return created[0]
    return env.AD_PLATFORM_VERIFICATION_WORKFLOW.get(verificationId)
  }
  catch {
    try {
      return await env.AD_PLATFORM_VERIFICATION_WORKFLOW.get(verificationId)
    }
    catch {
      await failVerification(env.DB, verificationId, 'AD_PLATFORM_VERIFICATION_WORKFLOW_UNAVAILABLE')
      throw new Error('AD_PLATFORM_VERIFICATION_WORKFLOW_UNAVAILABLE')
    }
  }
}

async function createStoredVerificationInput(
  env: AdPlatformVerificationEnv,
  input: StartPlatformVerificationInput,
  verificationId: string,
  connectionRevision: string,
): Promise<StoredVerificationState> {
  const adapter = getPlatformVerificationAdapter(input.provider)
  if (!adapter) throw new Error('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
  const code = adapter.normalizeTestEventCode(input.testEventCode)
  if (code === null) throw new Error('AD_PLATFORM_VERIFICATION_TEST_CODE_INVALID')
  if (code === undefined) return { schemaVersion: 1 }
  try {
    const keys = await loadAttributionCryptoKeys(env)
    return {
      schemaVersion: 1,
      verificationInput: await encryptAttributionValue({
        keys,
        aad: {
          purpose: 'verification_input',
          provider: input.provider,
          subjectId: verificationId,
          revision: connectionRevision,
        },
        plaintext: code,
      }),
    }
  }
  catch {
    throw new Error('AD_PLATFORM_VERIFICATION_CRYPTO_UNAVAILABLE')
  }
}

async function decryptVerificationInput(
  env: AdPlatformVerificationEnv,
  row: VerificationRow,
  envelope: AttributionEncryptedEnvelope,
) {
  try {
    const keys = await loadAttributionCryptoKeys(env)
    return await decryptAttributionValue({
      keys,
      aad: {
        purpose: 'verification_input',
        provider: row.provider,
        subjectId: row.id,
        revision: row.connection_revision,
      },
      envelope,
    })
  }
  catch {
    throw new Error('AD_PLATFORM_VERIFICATION_INPUT_UNREADABLE')
  }
}

async function failVerification(db: D1Database, verificationId: string, failureCode: string) {
  await completeVerification(db, verificationId, 'failed', {
    schemaVersion: 1,
    failureCode,
  })
}

async function completeVerification(
  db: D1Database,
  verificationId: string,
  status: 'failed' | 'timed_out',
  state: StoredVerificationState,
) {
  await db.prepare(`
    UPDATE attribution_verifications
    SET status = ?, evidence_json = ?, completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status IN ('queued', 'running', 'awaiting_human_evidence')
  `).bind(status, JSON.stringify(state), verificationId).run()
}

async function finalizeVerified(
  db: D1Database,
  verificationId: string,
  state: StoredVerificationState,
  actorId: number,
) {
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_verifications
      SET status = 'verified', evidence_json = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_human_evidence' AND EXISTS (
        SELECT 1 FROM attribution_platform_connections connection
        WHERE connection.id = attribution_verifications.connection_id
          AND connection.provider = attribution_verifications.provider
          AND connection.connection_revision = attribution_verifications.connection_revision
          AND connection.credential_revision = attribution_verifications.credential_revision
      )
    `).bind(JSON.stringify(state), verificationId),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      )
      SELECT ?, ?, 'confirm_ad_platform_verification', 'ad_platform_verification', ?, '{}', ?
      WHERE changes() = 1
    `).bind(
      crypto.randomUUID(),
      actorId,
      verificationId,
      JSON.stringify({ status: 'verified' }),
    ),
  ])
  if (results[0] && d1Changed(results[0])) return 'verified' as const
  await db.batch([
    db.prepare(`
      UPDATE attribution_verifications
      SET status = 'invalidated', evidence_json = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_human_evidence'
    `).bind(JSON.stringify({
      ...state,
      failureCode: 'AD_PLATFORM_VERIFICATION_REVISION_INVALID',
    }), verificationId),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value
      )
      SELECT ?, ?, 'confirm_ad_platform_verification', 'ad_platform_verification', ?, '{}', ?
      WHERE changes() = 1
    `).bind(
      crypto.randomUUID(),
      actorId,
      verificationId,
      JSON.stringify({ status: 'invalidated', reason: 'connection_revision_changed' }),
    ),
  ])
  return 'invalidated' as const
}

function readVerificationRow(db: D1Database, verificationId: string) {
  return db.prepare('SELECT * FROM attribution_verifications WHERE id = ? LIMIT 1')
    .bind(verificationId)
    .first<VerificationRow>()
}

function readLatestCurrentVerification(
  db: D1Database,
  connectionId: string,
  provider: AdAttributionProvider,
  connectionRevision: string,
  credentialRevision: string,
) {
  return db.prepare(`
    SELECT * FROM attribution_verifications
    WHERE connection_id = ? AND provider = ? AND connection_revision = ? AND credential_revision = ?
    ORDER BY attempt DESC LIMIT 1
  `).bind(connectionId, provider, connectionRevision, credentialRevision).first<VerificationRow>()
}

async function nextVerificationAttempt(db: D1Database, connectionId: string, provider: AdAttributionProvider) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
    FROM attribution_verifications WHERE connection_id = ? AND provider = ?
  `).bind(connectionId, provider).first<{ attempt: number }>()
  return Number.isSafeInteger(row?.attempt) && Number(row?.attempt) > 0 ? Number(row!.attempt) : 1
}

function serializeVerification(row: VerificationRow) {
  const state = parseStoredState(row.evidence_json)
  return {
    id: row.id,
    provider: row.provider,
    connectionRevision: row.connection_revision,
    credentialRevision: row.credential_revision,
    attempt: row.attempt,
    status: VERIFICATION_STATUSES.has(row.status) ? row.status : 'failed',
    evidence: {
      ...(state.automatic ? { automatic: state.automatic } : {}),
      ...(state.human ? { human: state.human } : {}),
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    },
    startedAt: row.started_at,
    completedAt: row.completed_at || '',
    updatedAt: row.updated_at,
  }
}

function parseStoredState(value: string): StoredVerificationState {
  try {
    const parsed = JSON.parse(value) as StoredVerificationState
    return parsed && parsed.schemaVersion === 1 ? parsed : { schemaVersion: 1 }
  }
  catch {
    return { schemaVersion: 1 }
  }
}

function parseHumanEvidence(value: unknown): { human: NonNullable<StoredVerificationState['human']>; actorId: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.confirmed !== true || !Number.isSafeInteger(record.actorId) || Number(record.actorId) <= 0) return null
  const reference = normalizeEvidenceReference(record.reference)
  return {
    actorId: Number(record.actorId),
    human: {
      confirmed: true,
      ...(reference ? { reference } : {}),
      confirmedAt: new Date().toISOString(),
    },
  }
}

function normalizeEvidenceReference(value: unknown) {
  const normalized = String(value ?? '').trim()
  return normalized.length <= 240 && !/\p{Cc}/u.test(normalized) ? normalized : ''
}

function validateStartInput(env: AdPlatformVerificationEnv, input: StartPlatformVerificationInput) {
  if (env.APP_ENV !== 'production') throw new Error('AD_PLATFORM_VERIFICATION_PRODUCTION_ONLY')
  if (!validProvider(input.provider) || !Number.isSafeInteger(input.actorId) || input.actorId <= 0) {
    throw new Error('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
  }
  if (!env.AD_PLATFORM_VERIFICATION_WORKFLOW) throw new Error('AD_PLATFORM_VERIFICATION_WORKFLOW_UNAVAILABLE')
}

function verificationFailureCode(error: unknown) {
  if (error instanceof PlatformVerificationError) return error.code
  const value = error instanceof Error ? error.message : ''
  return /^AD_PLATFORM_[A-Z0-9_]{1,100}$/.test(value)
    ? value
    : 'AD_PLATFORM_VERIFICATION_FAILED'
}

function validProvider(value: unknown): value is AdAttributionProvider {
  return getPlatformVerificationAdapter(value) !== null
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value)
}

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 0) === 1
}

function base64Url(value: Uint8Array) {
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}
