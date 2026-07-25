import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { getProviderAdapter } from '../adapters/registry'
import type {
  AttributionProviderAdapter,
  ValidationEvidence,
} from '../adapters/types'
import type {
  AttributionAppEnvironment,
  CandidateValidationWorkflowPayload,
} from '../env'
import { sha256Hex } from '../security/digest'
import {
  openAttributionData,
  sealAttributionData,
  type AttributionDataEnvelope,
  type AttributionEncryptionKeys,
} from '../security/data-envelope'
import type { AttributionSigningKeys } from '../security/signed-token'
import { signAttributionToken } from '../security/signed-token'
import {
  createAttributionConnectionCommands,
} from './connection-commands'
import { readCapacityGate } from './capacity-monitor'
import { openCredential, type CredentialEnvelope } from './credential-vault'
import {
  recordCandidateSyntheticFact,
  type CanonicalFactResult,
} from './fact-service'
import {
  enqueueServerDelivery,
  type AttributionProviderQueues,
} from './secure-outbox'

export interface CandidateValidationEnvironment {
  db: D1Database
  appEnvironment: AttributionAppEnvironment
  credentialMasterKeys: AttributionEncryptionKeys
  dataEncryptionKeys: AttributionEncryptionKeys
  signingKeys: AttributionSigningKeys
  queues: AttributionProviderQueues
  workflow: Workflow<CandidateValidationWorkflowPayload>
  adapterFor?: (
    provider: AttributionProvider,
  ) => AttributionProviderAdapter
  now?: () => Date
  idFactory?: (prefix: string) => string
}

export interface StartCandidateValidationInput {
  connectionId: string
  candidateId: string
  actorId: number
  testEventCode?: string
  idempotencyKey?: string
}

export interface StartCurrentCandidateValidationInput {
  connectionId: string
  actorId: number
  testEventCode?: string
  idempotencyKey: string
}

export interface CandidateValidationStart {
  validationId: string
  status: 'queued' | 'running' | 'verified' | 'failed' | 'timed_out'
}

interface LiveCandidateValidationStart {
  validationId: string
  status: 'queued' | 'running'
  requestHash: string
}

export interface CandidateDeliveryState {
  status: 'pending' | 'accepted' | 'failed'
  accepted: number
  total: number
}

export interface CandidateBrowserEvidence {
  pairedEvents: number
  externalEventIds: string[]
}

interface ValidationSnapshot {
  validationId: string
  validationStatus: string
  validationEvidence: Record<string, unknown>
  validationCreatedAt: string
  connectionId: string
  candidateId: string
  baseActiveVersionId: string | null
  provider: AttributionProvider
  versionStatus: string
  publicConfig: Record<string, string>
  createdBy: number
  credentialEnvelope: CredentialEnvelope
  bindings: Array<{
    canonicalEvent: CanonicalConversionEvent
    enabled: boolean
    browserDestination: string
    serverDestination: string
  }>
  secretEnvelope: AttributionDataEnvelope | null
  secretExpiresAt: string | null
}

interface SnapshotRow {
  validation_id: string
  validation_status: string
  validation_evidence_json: string
  validation_created_at: string
  connection_id: string
  candidate_id: string
  base_active_version_id: string | null
  provider: string
  version_status: string
  public_config_json: string
  created_by: number
  credential_schema_version: number
  credential_key_id: string
  credential_iv: string
  credential_ciphertext: string
  credential_tag: string
  credential_fingerprint: string
  secret_key_id: string | null
  secret_iv: string | null
  secret_ciphertext: string | null
  secret_tag: string | null
  secret_expires_at: string | null
}

interface BindingRow {
  canonical_event: string
  enabled: number
  browser_destination: string
  server_destination: string
}

const VALIDATION_WINDOW_MS = 30 * 60 * 1_000
const VALIDATION_SECRET_PURPOSE = 'validation-secret'
const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const EVENTS = [
  'Contact',
  'CompleteRegistration',
] as const satisfies readonly CanonicalConversionEvent[]

export async function startCandidateValidation(
  environment: CandidateValidationEnvironment,
  input: StartCandidateValidationInput,
): Promise<CandidateValidationStart> {
  validateStartInput(input)
  const candidate = await readCandidateForStart(
    environment.db,
    input.connectionId,
    input.candidateId,
  )
  const adapter = providerAdapter(environment, candidate.provider)
  const testEventCode = adapter.normalizeTestEventCode(
    input.testEventCode,
  )
  if (testEventCode === null) {
    throw new Error('ATTRIBUTION_VALIDATION_TEST_CODE_INVALID')
  }
  const idempotencyKey = input.idempotencyKey
    ?? `candidate-validation:${await sha256Hex(input.candidateId)}`
  identifier(idempotencyKey)
  const requestHash = await candidateValidationRequestHash({
    connectionId: input.connectionId,
    candidateId: input.candidateId,
    provider: candidate.provider,
    testEventCode,
  })
  const now = trustedNow(environment.now)

  const idempotent = await readValidationByIdempotencyKey(
    environment.db,
    idempotencyKey,
  )
  if (idempotent) {
    if (
      idempotent.candidateId !== input.candidateId
      || idempotent.requestHash !== requestHash
    ) {
      throw new Error('ATTRIBUTION_VALIDATION_IDEMPOTENCY_CONFLICT')
    }
    if (
      idempotent.status !== 'queued'
      && idempotent.status !== 'running'
    ) {
      return {
        validationId: idempotent.validationId,
        status: idempotent.status,
      }
    }
    if (
      candidate.status !== 'candidate'
      && candidate.status !== 'validating'
    ) {
      throw new Error('ATTRIBUTION_VALIDATION_CANDIDATE_INVALID')
    }
    return resumeCandidateValidation(
      environment,
      input,
      {
        validationId: idempotent.validationId,
        status: idempotent.status,
        requestHash: idempotent.requestHash,
      },
      now,
      true,
      false,
    )
  }

  const existing = await readLiveValidation(
    environment.db,
    input.candidateId,
  )
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new Error('ATTRIBUTION_VALIDATION_IDEMPOTENCY_CONFLICT')
    }
    if (
      candidate.status !== 'candidate'
      && candidate.status !== 'validating'
    ) {
      throw new Error('ATTRIBUTION_VALIDATION_CANDIDATE_INVALID')
    }
    return resumeCandidateValidation(
      environment,
      input,
      existing,
      now,
      true,
      false,
    )
  }
  if (candidate.status !== 'candidate') {
    throw new Error('ATTRIBUTION_VALIDATION_CANDIDATE_INVALID')
  }

  await assertNonEssentialCapacity(environment.db, now)
  const idFactory = validationIdFactory(environment)
  const validationId = identifier(idFactory('validation'))
  const secretEnvelope = testEventCode
    ? await sealAttributionData(environment.dataEncryptionKeys, {
        purpose: VALIDATION_SECRET_PURPOSE,
        identity: validationSecretIdentity({
          validationId,
          provider: candidate.provider,
          candidateId: input.candidateId,
        }),
        plaintext: testEventCode,
      })
    : null
  const statements = [
    environment.db.prepare(`
      INSERT INTO attribution_validations (
        id, candidate_version_id, provider, status,
        evidence_json, failure_code, created_at,
        idempotency_key, request_hash
      ) VALUES (?, ?, ?, 'queued', '{}', '', ?, ?, ?)
    `).bind(
      validationId,
      input.candidateId,
      candidate.provider,
      now.toISOString(),
      idempotencyKey,
      requestHash,
    ),
  ]
  if (secretEnvelope) {
    statements.push(environment.db.prepare(`
      INSERT INTO attribution_validation_secrets (
        validation_id, key_id, iv, ciphertext, tag, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      validationId,
      secretEnvelope.keyId,
      secretEnvelope.iv,
      secretEnvelope.ciphertext,
      secretEnvelope.tag,
      new Date(now.getTime() + VALIDATION_WINDOW_MS).toISOString(),
    ))
  }
  let results: D1Result<unknown>[]
  try {
    results = await environment.db.batch(statements)
  } catch {
    const raced = await recoverRacedValidation(
      environment,
      input,
      idempotencyKey,
      requestHash,
      now,
    )
    if (raced) return raced
    throw new Error('ATTRIBUTION_VALIDATION_PERSIST_FAILED')
  }
  if (results.some(result => Number(result.meta.changes ?? 0) !== 1)) {
    const raced = await recoverRacedValidation(
      environment,
      input,
      idempotencyKey,
      requestHash,
      now,
    )
    if (raced) return raced
    throw new Error('ATTRIBUTION_VALIDATION_PERSIST_FAILED')
  }
  return resumeCandidateValidation(
    environment,
    input,
    { validationId, status: 'queued', requestHash },
    now,
    false,
    true,
  )
}

export async function startCurrentCandidateValidation(
  environment: CandidateValidationEnvironment,
  input: StartCurrentCandidateValidationInput,
): Promise<CandidateValidationStart> {
  identifier(input.connectionId)
  identifier(input.idempotencyKey)
  positiveInteger(input.actorId)

  const replay = await readConnectionValidationByIdempotencyKey(
    environment.db,
    input.connectionId,
    input.idempotencyKey,
  )
  if (replay) {
    return startCandidateValidation(environment, {
      ...input,
      candidateId: replay.candidateId,
    })
  }

  const candidate = await environment.db.prepare(`
    SELECT id
    FROM attribution_connection_versions
    WHERE connection_id = ?
      AND status IN ('candidate','validating')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).bind(input.connectionId).first<{ id: string }>()
  if (!candidate) {
    throw new Error('ATTRIBUTION_VALIDATION_CANDIDATE_INVALID')
  }
  return startCandidateValidation(environment, {
    ...input,
    candidateId: identifier(candidate.id),
  })
}

async function resumeCandidateValidation(
  environment: CandidateValidationEnvironment,
  input: StartCandidateValidationInput,
  validation: LiveCandidateValidationStart,
  now: Date,
  tolerateExistingWorkflow: boolean,
  abandonOnTransitionFailure: boolean,
): Promise<CandidateValidationStart> {
  const commands = connectionCommands(environment)
  try {
    await commands.beginCandidateValidation({
      connectionId: input.connectionId,
      candidateId: input.candidateId,
      actorId: input.actorId,
      idempotencyKey: `validation:${validation.validationId}:begin`,
    })
  } catch (error) {
    if (abandonOnTransitionFailure) {
      await abandonQueuedValidation(
        environment.db,
        validation.validationId,
        'candidate_validation_start_failed',
        now,
      )
    }
    throw error
  }
  await launchWorkflow(
    environment.workflow,
    validation.validationId,
    tolerateExistingWorkflow,
  )
  return validation
}

export async function prepareCandidateValidation(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<ValidationEvidence> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  if (
    snapshot.versionStatus !== 'validating'
    || !['queued', 'running'].includes(snapshot.validationStatus)
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_STATE_INVALID')
  }
  const adapter = providerAdapter(environment, snapshot.provider)
  const credential = await openSnapshotCredential(environment, snapshot)
  const testEventCode = await openValidationSecret(environment, snapshot)
  if (adapter.normalizeTestEventCode(testEventCode) === null) {
    throw new Error('ATTRIBUTION_VALIDATION_TEST_CODE_INVALID')
  }
  const evidence = await adapter.validateCandidate({
    provider: snapshot.provider,
    connectionId: snapshot.connectionId,
    versionId: snapshot.candidateId,
    publicConfig: snapshot.publicConfig,
    credential,
    bindings: snapshot.bindings,
    testEventCode,
  })
  const now = trustedNow(environment.now).toISOString()
  const result = await environment.db.prepare(`
    UPDATE attribution_validations
    SET status = 'running',
        evidence_json = ?,
        failure_code = '',
        started_at = COALESCE(started_at, ?)
    WHERE id = ?
      AND status IN ('queued','running')
  `).bind(
    JSON.stringify({ candidate: evidence }),
    now,
    validationId,
  ).run()
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error('ATTRIBUTION_VALIDATION_STATE_INVALID')
  }
  return evidence
}

export async function createCandidateSyntheticFacts(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<CanonicalFactResult[]> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  if (
    snapshot.validationStatus !== 'running'
    || snapshot.versionStatus !== 'validating'
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_STATE_INVALID')
  }
  await assertNonEssentialCapacity(
    environment.db,
    trustedNow(environment.now),
  )
  const facts: CanonicalFactResult[] = []
  for (const eventName of EVENTS) {
    const fact = await recordCandidateSyntheticFact({
      db: environment.db,
      signingKeys: environment.signingKeys,
      encryptionKeys: environment.dataEncryptionKeys,
      now: environment.now,
      idFactory: environment.idFactory,
    }, {
      validationId,
      connectionId: snapshot.connectionId,
      versionId: snapshot.candidateId,
      provider: snapshot.provider,
      eventName,
      occurredAt: snapshot.validationCreatedAt,
    })
    const serverDelivery = fact.deliveries.find(
      delivery => delivery.transport === 'server',
    )
    if (!serverDelivery) {
      throw new Error('ATTRIBUTION_VALIDATION_SERVER_PLAN_MISSING')
    }
    const outcome = await enqueueServerDelivery({
      db: environment.db,
      queues: environment.queues,
      now: environment.now,
    }, {
      provider: snapshot.provider,
      deliveryId: serverDelivery.id,
      mode: 'candidate_validation',
    })
    const deliveryStatus = outcome === 'enqueued'
      ? 'queued'
      : await readServerDeliveryStatus(
          environment.db,
          serverDelivery.id,
        )
    if (!isAwaitableDeliveryStatus(deliveryStatus)) {
      throw new Error('ATTRIBUTION_VALIDATION_ENQUEUE_FAILED')
    }
    facts.push(fact)
  }
  return facts
}

export async function readCandidateDeliveryState(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<CandidateDeliveryState> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  const rows = await environment.db.prepare(`
    SELECT delivery.status
    FROM attribution_facts AS fact
    INNER JOIN attribution_deliveries AS delivery
      ON delivery.fact_id = fact.id
     AND delivery.transport = 'server'
    WHERE fact.version_id = ?
      AND fact.fact_origin = 'synthetic'
      AND fact.event_id IN (?, ?)
    ORDER BY fact.event_name
  `).bind(
    snapshot.candidateId,
    validationEventId(validationId, 'Contact'),
    validationEventId(validationId, 'CompleteRegistration'),
  ).all<{ status: string }>()
  const total = rows.results.length
  const accepted = rows.results.filter(row =>
    row.status === 'accepted' || row.status === 'processed').length
  const failed = rows.results.some(row =>
    row.status === 'rejected'
    || row.status === 'dead_letter'
    || row.status === 'cancelled')
  return {
    status: failed
      ? 'failed'
      : total === EVENTS.length && accepted === total
        ? 'accepted'
        : 'pending',
    accepted,
    total,
  }
}

export async function verifyCandidateBrowserPairing(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<CandidateBrowserEvidence> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  if (snapshot.validationStatus !== 'running') {
    throw new Error('ATTRIBUTION_VALIDATION_STATE_INVALID')
  }
  const adapter = providerAdapter(environment, snapshot.provider)
  const rows = await environment.db.prepare(`
    SELECT
      browser.id AS delivery_id,
      browser.destination,
      browser.external_event_id,
      fact.event_name,
      server.external_event_id AS server_external_event_id
    FROM attribution_facts AS fact
    INNER JOIN attribution_deliveries AS browser
      ON browser.fact_id = fact.id
     AND browser.transport = 'browser'
    INNER JOIN attribution_deliveries AS server
      ON server.fact_id = fact.id
     AND server.transport = 'server'
    WHERE fact.version_id = ?
      AND fact.fact_origin = 'synthetic'
      AND fact.event_id IN (?, ?)
    ORDER BY fact.event_name
  `).bind(
    snapshot.candidateId,
    validationEventId(validationId, 'Contact'),
    validationEventId(validationId, 'CompleteRegistration'),
  ).all<{
    delivery_id: string
    destination: string
    external_event_id: string
    event_name: string
    server_external_event_id: string
  }>()
  const externalEventIds: string[] = []
  for (const row of rows.results) {
    const eventName = canonicalEvent(row.event_name)
    if (row.external_event_id !== row.server_external_event_id) {
      throw new Error('ATTRIBUTION_VALIDATION_PAIRING_INVALID')
    }
    const receiptToken = await signAttributionToken(
      environment.signingKeys.current,
      'browser-receipt',
      {
        deliveryId: row.delivery_id,
        validationId,
        issuedAt: unixSeconds(trustedNow(environment.now)),
      },
    )
    const instruction = adapter.buildBrowserInstruction({
      provider: snapshot.provider,
      connectionId: snapshot.connectionId,
      versionId: snapshot.candidateId,
      deliveryId: row.delivery_id,
      canonicalEvent: eventName,
      externalEventId: row.external_event_id,
      destination: row.destination,
      receiptToken,
    })
    if (instruction.externalEventId !== row.server_external_event_id) {
      throw new Error('ATTRIBUTION_VALIDATION_PAIRING_INVALID')
    }
    externalEventIds.push(instruction.externalEventId)
  }
  if (externalEventIds.length !== EVENTS.length) {
    throw new Error('ATTRIBUTION_VALIDATION_PAIRING_INCOMPLETE')
  }
  const evidence = {
    pairedEvents: externalEventIds.length,
    externalEventIds: [...new Set(externalEventIds)],
  }
  if (evidence.externalEventIds.length !== EVENTS.length) {
    throw new Error('ATTRIBUTION_VALIDATION_PAIRING_INVALID')
  }
  await mergeEvidence(environment.db, validationId, {
    browserPairing: evidence,
  })
  return evidence
}

export async function activateValidatedCandidate(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<void> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  const state = await readCandidateDeliveryState(environment, validationId)
  const pairing = snapshot.validationEvidence.browserPairing
  if (
    snapshot.validationStatus !== 'running'
    || snapshot.versionStatus !== 'validating'
    || state.status !== 'accepted'
    || !isBrowserPairingEvidence(pairing)
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_NOT_READY')
  }
  const commands = connectionCommands(environment)
  await commands.markCandidateReady({
    connectionId: snapshot.connectionId,
    candidateId: snapshot.candidateId,
    actorId: snapshot.createdBy,
    idempotencyKey: `validation:${validationId}:ready`,
  })
  await commands.activateCandidate({
    connectionId: snapshot.connectionId,
    candidateId: snapshot.candidateId,
    expectedBaseActiveVersionId: snapshot.baseActiveVersionId,
    actorId: snapshot.createdBy,
    idempotencyKey: `validation:${validationId}:activate`,
  })
}

export async function smokeValidatedCandidate(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<void> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  const active = await environment.db.prepare(`
    SELECT active_version_id
    FROM attribution_connections
    WHERE id = ?
  `).bind(snapshot.connectionId).first<{
    active_version_id: string | null
  }>()
  if (
    active?.active_version_id !== snapshot.candidateId
    || snapshot.versionStatus !== 'active'
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_SMOKE_FAILED')
  }
  const adapter = providerAdapter(environment, snapshot.provider)
  await adapter.validateCandidate({
    provider: snapshot.provider,
    connectionId: snapshot.connectionId,
    versionId: snapshot.candidateId,
    publicConfig: snapshot.publicConfig,
    credential: await openSnapshotCredential(environment, snapshot),
    bindings: snapshot.bindings,
  })
}

export async function completeCandidateValidation(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<void> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  const active = await environment.db.prepare(`
    SELECT active_version_id
    FROM attribution_connections
    WHERE id = ?
  `).bind(snapshot.connectionId).first<{
    active_version_id: string | null
  }>()
  if (
    active?.active_version_id !== snapshot.candidateId
    || snapshot.versionStatus !== 'active'
    || !['running', 'verified'].includes(snapshot.validationStatus)
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_COMPLETE_INVALID')
  }
  const now = trustedNow(environment.now).toISOString()
  await environment.db.prepare(`
    UPDATE attribution_validations
    SET status = 'verified',
        failure_code = '',
        completed_at = COALESCE(completed_at, ?)
    WHERE id = ?
      AND status IN ('running','verified')
  `).bind(now, validationId).run()
}

export async function failCandidateValidation(
  environment: CandidateValidationEnvironment,
  validationId: string,
  failureCode: string,
): Promise<void> {
  await finishFailedValidation(
    environment,
    validationId,
    failureCode,
    'failed',
  )
}

export async function timeoutCandidateValidation(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<void> {
  await finishFailedValidation(
    environment,
    validationId,
    'candidate_validation_timed_out',
    'timed_out',
  )
}

export async function destroyValidationSecret(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<void> {
  identifier(validationId)
  await environment.db.prepare(`
    DELETE FROM attribution_validation_secrets
    WHERE validation_id = ?
  `).bind(validationId).run()
}

export async function candidateValidationDeadlineExceeded(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<boolean> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  const deadline = snapshot.secretExpiresAt
    ? Date.parse(snapshot.secretExpiresAt)
    : Date.parse(snapshot.validationCreatedAt) + VALIDATION_WINDOW_MS
  return !Number.isFinite(deadline)
    || trustedNow(environment.now).getTime() >= deadline
}

export async function rollbackCandidateActivation(
  environment: CandidateValidationEnvironment,
  validationId: string,
): Promise<void> {
  const snapshot = await readValidationSnapshot(environment.db, validationId)
  const active = await environment.db.prepare(`
    SELECT active_version_id
    FROM attribution_connections
    WHERE id = ?
  `).bind(snapshot.connectionId).first<{
    active_version_id: string | null
  }>()
  if (active?.active_version_id !== snapshot.candidateId) return
  if (snapshot.baseActiveVersionId) {
    await connectionCommands(environment).rollbackActiveVersion({
      connectionId: snapshot.connectionId,
      targetVersionId: snapshot.baseActiveVersionId,
      expectedActiveVersionId: snapshot.candidateId,
      actorId: snapshot.createdBy,
      idempotencyKey: `validation:${validationId}:rollback`,
    })
    return
  }
  const now = trustedNow(environment.now).toISOString()
  await environment.db.batch([
    environment.db.prepare(`
      UPDATE attribution_connections
      SET active_version_id = NULL, updated_at = ?
      WHERE id = ? AND active_version_id = ?
    `).bind(now, snapshot.connectionId, snapshot.candidateId),
    environment.db.prepare(`
      UPDATE attribution_connection_versions
      SET status = 'failed',
          failure_code = 'candidate_smoke_failed'
      WHERE id = ? AND status = 'active'
    `).bind(snapshot.candidateId),
  ])
}

async function finishFailedValidation(
  environment: CandidateValidationEnvironment,
  validationId: string,
  failureCode: string,
  validationStatus: 'failed' | 'timed_out',
): Promise<void> {
  identifier(validationId)
  if (!/^[a-z0-9_]{1,120}$/.test(failureCode)) {
    throw new Error('ATTRIBUTION_VALIDATION_FAILURE_CODE_INVALID')
  }
  const now = trustedNow(environment.now).toISOString()
  await environment.db.batch([
    environment.db.prepare(`
      UPDATE attribution_validations
      SET status = ?,
          failure_code = ?,
          completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
        AND status IN ('queued','running',?)
    `).bind(
      validationStatus,
      failureCode,
      now,
      validationId,
      validationStatus,
    ),
    environment.db.prepare(`
      UPDATE attribution_connection_versions
      SET status = 'failed',
          failure_code = ?
      WHERE id = (
        SELECT candidate_version_id
        FROM attribution_validations
        WHERE id = ?
      )
        AND status IN ('candidate','validating','ready','failed')
    `).bind(failureCode, validationId),
  ])
}

async function readCandidateForStart(
  db: D1Database,
  connectionId: string,
  candidateId: string,
): Promise<{
  provider: AttributionProvider
  status: string
}> {
  const row = await db.prepare(`
    SELECT connection.provider, version.status
    FROM attribution_connections AS connection
    INNER JOIN attribution_connection_versions AS version
      ON version.id = ?
     AND version.connection_id = connection.id
     AND version.provider = connection.provider
    WHERE connection.id = ?
    LIMIT 1
  `).bind(candidateId, connectionId).first<{
    provider: string
    status: string
  }>()
  if (!row || !PROVIDERS.has(row.provider as AttributionProvider)) {
    throw new Error('ATTRIBUTION_VALIDATION_CANDIDATE_INVALID')
  }
  return {
    provider: row.provider as AttributionProvider,
    status: row.status,
  }
}

async function readLiveValidation(
  db: D1Database,
  candidateId: string,
): Promise<LiveCandidateValidationStart | null> {
  const row = await db.prepare(`
    SELECT id, status, request_hash
    FROM attribution_validations
    WHERE candidate_version_id = ?
      AND status IN ('queued','running')
    LIMIT 1
  `).bind(candidateId).first<{
    id: string
    status: 'queued' | 'running'
    request_hash: string
  }>()
  return row
    ? {
        validationId: identifier(row.id),
        status: row.status,
        requestHash: digest(row.request_hash),
      }
    : null
}

async function recoverRacedValidation(
  environment: CandidateValidationEnvironment,
  input: StartCandidateValidationInput,
  idempotencyKey: string,
  requestHash: string,
  now: Date,
): Promise<CandidateValidationStart | null> {
  const idempotent = await readValidationByIdempotencyKey(
    environment.db,
    idempotencyKey,
  )
  if (idempotent) {
    if (
      idempotent.candidateId !== input.candidateId
      || idempotent.requestHash !== requestHash
    ) {
      throw new Error('ATTRIBUTION_VALIDATION_IDEMPOTENCY_CONFLICT')
    }
    if (
      idempotent.status !== 'queued'
      && idempotent.status !== 'running'
    ) {
      return {
        validationId: idempotent.validationId,
        status: idempotent.status,
      }
    }
    return resumeCandidateValidation(
      environment,
      input,
      {
        validationId: idempotent.validationId,
        status: idempotent.status,
        requestHash: idempotent.requestHash,
      },
      now,
      true,
      false,
    )
  }
  const live = await readLiveValidation(
    environment.db,
    input.candidateId,
  )
  if (!live) return null
  if (live.requestHash !== requestHash) {
    throw new Error('ATTRIBUTION_VALIDATION_IDEMPOTENCY_CONFLICT')
  }
  return resumeCandidateValidation(
    environment,
    input,
    live,
    now,
    true,
    false,
  )
}

async function readValidationByIdempotencyKey(
  db: D1Database,
  idempotencyKey: string,
): Promise<{
  validationId: string
  candidateId: string
  status: CandidateValidationStart['status']
  requestHash: string
} | null> {
  const row = await db.prepare(`
    SELECT id, candidate_version_id, status, request_hash
    FROM attribution_validations
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(idempotencyKey).first<{
    id: string
    candidate_version_id: string
    status: CandidateValidationStart['status']
    request_hash: string
  }>()
  if (!row) return null
  return {
    validationId: identifier(row.id),
    candidateId: identifier(row.candidate_version_id),
    status: validationStatus(row.status),
    requestHash: digest(row.request_hash),
  }
}

async function readConnectionValidationByIdempotencyKey(
  db: D1Database,
  connectionId: string,
  idempotencyKey: string,
): Promise<{ candidateId: string } | null> {
  const row = await db.prepare(`
    SELECT validation.candidate_version_id
    FROM attribution_validations AS validation
    INNER JOIN attribution_connection_versions AS version
      ON version.id = validation.candidate_version_id
     AND version.connection_id = ?
    WHERE validation.idempotency_key = ?
    LIMIT 1
  `).bind(connectionId, idempotencyKey).first<{
    candidate_version_id: string
  }>()
  return row
    ? { candidateId: identifier(row.candidate_version_id) }
    : null
}

async function readValidationSnapshot(
  db: D1Database,
  validationId: string,
): Promise<ValidationSnapshot> {
  identifier(validationId)
  const row = await db.prepare(`
    SELECT
      validation.id AS validation_id,
      validation.status AS validation_status,
      validation.evidence_json AS validation_evidence_json,
      validation.created_at AS validation_created_at,
      version.connection_id,
      version.id AS candidate_id,
      version.base_active_version_id,
      version.provider,
      version.status AS version_status,
      version.public_config_json,
      version.created_by,
      credential.schema_version AS credential_schema_version,
      credential.key_id AS credential_key_id,
      credential.iv AS credential_iv,
      credential.ciphertext AS credential_ciphertext,
      credential.tag AS credential_tag,
      credential.credential_fingerprint,
      secret.key_id AS secret_key_id,
      secret.iv AS secret_iv,
      secret.ciphertext AS secret_ciphertext,
      secret.tag AS secret_tag,
      secret.expires_at AS secret_expires_at
    FROM attribution_validations AS validation
    INNER JOIN attribution_connection_versions AS version
      ON version.id = validation.candidate_version_id
     AND version.provider = validation.provider
    INNER JOIN attribution_version_credentials AS credential
      ON credential.version_id = version.id
     AND credential.provider = version.provider
    LEFT JOIN attribution_validation_secrets AS secret
      ON secret.validation_id = validation.id
    WHERE validation.id = ?
    LIMIT 1
  `).bind(validationId).first<SnapshotRow>()
  if (
    !row
    || !PROVIDERS.has(row.provider as AttributionProvider)
    || row.credential_schema_version !== 1
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_NOT_FOUND')
  }
  const bindings = await db.prepare(`
    SELECT
      canonical_event, enabled,
      browser_destination, server_destination
    FROM attribution_version_bindings
    WHERE version_id = ?
    ORDER BY canonical_event
  `).bind(row.candidate_id).all<BindingRow>()
  return {
    validationId: identifier(row.validation_id),
    validationStatus: row.validation_status,
    validationEvidence: parseRecord(row.validation_evidence_json),
    validationCreatedAt: canonicalTimestamp(row.validation_created_at),
    connectionId: identifier(row.connection_id),
    candidateId: identifier(row.candidate_id),
    baseActiveVersionId: row.base_active_version_id === null
      ? null
      : identifier(row.base_active_version_id),
    provider: row.provider as AttributionProvider,
    versionStatus: row.version_status,
    publicConfig: parseStringRecord(row.public_config_json),
    createdBy: positiveInteger(row.created_by),
    credentialEnvelope: {
      schemaVersion: 1,
      keyId: row.credential_key_id,
      iv: row.credential_iv,
      ciphertext: row.credential_ciphertext,
      tag: row.credential_tag,
      fingerprint: row.credential_fingerprint,
    },
    bindings: bindings.results.map(binding => ({
      canonicalEvent: canonicalEvent(binding.canonical_event),
      enabled: binding.enabled === 1,
      browserDestination: safeText(binding.browser_destination),
      serverDestination: safeText(binding.server_destination),
    })),
    secretEnvelope: dataEnvelope(row),
    secretExpiresAt: row.secret_expires_at,
  }
}

async function openSnapshotCredential(
  environment: CandidateValidationEnvironment,
  snapshot: ValidationSnapshot,
): Promise<string> {
  return openCredential(environment.credentialMasterKeys, {
    provider: snapshot.provider,
    versionId: snapshot.candidateId,
    envelope: snapshot.credentialEnvelope,
  })
}

async function openValidationSecret(
  environment: CandidateValidationEnvironment,
  snapshot: ValidationSnapshot,
): Promise<string | undefined> {
  if (!snapshot.secretEnvelope) return undefined
  if (
    !snapshot.secretExpiresAt
    || Date.parse(snapshot.secretExpiresAt)
      <= trustedNow(environment.now).getTime()
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_SECRET_EXPIRED')
  }
  return openAttributionData(environment.dataEncryptionKeys, {
    purpose: VALIDATION_SECRET_PURPOSE,
    identity: validationSecretIdentity({
      validationId: snapshot.validationId,
      provider: snapshot.provider,
      candidateId: snapshot.candidateId,
    }),
    envelope: snapshot.secretEnvelope,
  })
}

async function mergeEvidence(
  db: D1Database,
  validationId: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const row = await db.prepare(`
    SELECT evidence_json
    FROM attribution_validations
    WHERE id = ?
  `).bind(validationId).first<{ evidence_json: string }>()
  const current = parseRecord(row?.evidence_json ?? '{}')
  await db.prepare(`
    UPDATE attribution_validations
    SET evidence_json = ?
    WHERE id = ? AND status = 'running'
  `).bind(
    JSON.stringify({ ...current, ...evidence }),
    validationId,
  ).run()
}

async function assertNonEssentialCapacity(
  db: D1Database,
  now: Date,
): Promise<void> {
  const gate = await readCapacityGate(db, now.toISOString().slice(0, 10))
  if (gate.observed && !gate.allowNonEssential) {
    throw new Error('ATTRIBUTION_CAPACITY_NONESSENTIAL_PAUSED')
  }
}

function providerAdapter(
  environment: CandidateValidationEnvironment,
  provider: AttributionProvider,
): AttributionProviderAdapter {
  if (
    environment.appEnvironment !== 'production'
    && !environment.adapterFor
  ) {
    throw new Error('ATTRIBUTION_NONPRODUCTION_MOCK_REQUIRED')
  }
  const adapter = (environment.adapterFor ?? getProviderAdapter)(provider)
  if (adapter.provider !== provider) {
    throw new Error('ATTRIBUTION_VALIDATION_PROVIDER_MISMATCH')
  }
  return adapter
}

function connectionCommands(
  environment: CandidateValidationEnvironment,
) {
  return createAttributionConnectionCommands({
    db: environment.db,
    credentialKeys: environment.credentialMasterKeys,
    now: environment.now,
    idFactory: environment.idFactory,
  })
}

async function launchWorkflow(
  workflow: Workflow<CandidateValidationWorkflowPayload>,
  validationId: string,
  tolerateExisting: boolean,
): Promise<void> {
  try {
    await workflow.createBatch([{
      id: `candidate-validation-${validationId}`,
      params: { validationId },
      retention: {
        successRetention: '3 days',
        errorRetention: '3 days',
      },
    }])
  } catch (error) {
    if (!tolerateExisting) throw error
    try {
      await (
        await workflow.get(`candidate-validation-${validationId}`)
      ).status()
    } catch {
      throw error
    }
  }
}

async function abandonQueuedValidation(
  db: D1Database,
  validationId: string,
  failureCode: string,
  now: Date,
): Promise<void> {
  await db.batch([
    db.prepare(`
      UPDATE attribution_validations
      SET status = 'failed',
          failure_code = ?,
          completed_at = ?
      WHERE id = ? AND status = 'queued'
    `).bind(failureCode, now.toISOString(), validationId),
    db.prepare(`
      DELETE FROM attribution_validation_secrets
      WHERE validation_id = ?
    `).bind(validationId),
  ])
}

async function readServerDeliveryStatus(
  db: D1Database,
  deliveryId: string,
): Promise<string | null> {
  const row = await db.prepare(`
    SELECT status
    FROM attribution_deliveries
    WHERE id = ? AND transport = 'server'
    LIMIT 1
  `).bind(deliveryId).first<{ status: string }>()
  return row?.status ?? null
}

function isAwaitableDeliveryStatus(
  status: string | null,
): boolean {
  return status !== null
    && ['queued', 'retrying', 'accepted', 'processed'].includes(status)
}

function validationSecretIdentity(input: {
  validationId: string
  provider: AttributionProvider
  candidateId: string
}): string {
  return [
    input.validationId,
    input.provider,
    input.candidateId,
  ].join(':')
}

function dataEnvelope(row: SnapshotRow): AttributionDataEnvelope | null {
  const values = [
    row.secret_key_id,
    row.secret_iv,
    row.secret_ciphertext,
    row.secret_tag,
  ]
  if (values.every(value => value === null)) return null
  if (!values.every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('ATTRIBUTION_VALIDATION_SECRET_INVALID')
  }
  return {
    schemaVersion: 1,
    keyId: row.secret_key_id!,
    iv: row.secret_iv!,
    ciphertext: row.secret_ciphertext!,
    tag: row.secret_tag!,
  }
}

function validationEventId(
  validationId: string,
  event: CanonicalConversionEvent,
): string {
  return `validation:${validationId}:${event}`
}

function validateStartInput(input: StartCandidateValidationInput): void {
  identifier(input.connectionId)
  identifier(input.candidateId)
  positiveInteger(input.actorId)
  if (input.idempotencyKey !== undefined) {
    identifier(input.idempotencyKey)
  }
}

async function candidateValidationRequestHash(input: {
  connectionId: string
  candidateId: string
  provider: AttributionProvider
  testEventCode: string | undefined
}): Promise<string> {
  return sha256Hex(JSON.stringify([
    'candidate-validation-request',
    1,
    input.connectionId,
    input.candidateId,
    input.provider,
    input.testEventCode ?? null,
  ]))
}

function validationStatus(
  value: unknown,
): CandidateValidationStart['status'] {
  if (
    value === 'queued'
    || value === 'running'
    || value === 'verified'
    || value === 'failed'
    || value === 'timed_out'
  ) {
    return value
  }
  throw new Error('ATTRIBUTION_VALIDATION_STATE_INVALID')
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('ATTRIBUTION_VALIDATION_REQUEST_HASH_INVALID')
  }
  return value
}

function validationIdFactory(
  environment: CandidateValidationEnvironment,
): (prefix: string) => string {
  return environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
}

function canonicalEvent(value: unknown): CanonicalConversionEvent {
  if (value !== 'Contact' && value !== 'CompleteRegistration') {
    throw new Error('ATTRIBUTION_VALIDATION_EVENT_INVALID')
  }
  return value
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9:_-]{1,240}$/.test(value)
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_IDENTIFIER_INVALID')
  }
  return value
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('ATTRIBUTION_VALIDATION_INTEGER_INVALID')
  }
  return Number(value)
}

function safeText(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || /\p{Cc}/u.test(value)
  ) {
    throw new Error('ATTRIBUTION_VALIDATION_TEXT_INVALID')
  }
  return value
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('ATTRIBUTION_VALIDATION_TIMESTAMP_INVALID')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('ATTRIBUTION_VALIDATION_TIMESTAMP_INVALID')
  }
  return parsed.toISOString()
}

function trustedNow(now?: () => Date): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) {
    throw new Error('ATTRIBUTION_VALIDATION_NOW_INVALID')
  }
  return value
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1_000)
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ATTRIBUTION_VALIDATION_JSON_INVALID')
  }
  return parsed as Record<string, unknown>
}

function parseStringRecord(value: string): Record<string, string> {
  const parsed = parseRecord(value)
  if (!Object.values(parsed).every(item => typeof item === 'string')) {
    throw new Error('ATTRIBUTION_VALIDATION_JSON_INVALID')
  }
  return parsed as Record<string, string>
}

function isBrowserPairingEvidence(
  value: unknown,
): value is CandidateBrowserEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const evidence = value as Record<string, unknown>
  return evidence.pairedEvents === EVENTS.length
    && Array.isArray(evidence.externalEventIds)
    && evidence.externalEventIds.length === EVENTS.length
    && evidence.externalEventIds.every(item =>
      typeof item === 'string' && item.length > 0)
}
