import type { AdAttributionProvider, AdPlatformQueueMessage, CanonicalConversionEvent } from '@meigallery/shared'
import { decryptAttributionValue, loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import { CredentialVaultError, readAttributionCredential } from './credential-vault'
import { deleteAttributionOutbox } from './secure-outbox'
import { deliverServerEvent, type ServerDeliveryInput, type ServerDeliveryResult } from './server-adapter'

const LEASE_STALE_MINUTES = 5
const PERMANENT_CREDENTIAL_ERRORS = new Set([
  'ATTRIBUTION_CREDENTIAL_INPUT_INVALID',
  'ATTRIBUTION_CREDENTIAL_CONNECTION_NOT_FOUND',
  'ATTRIBUTION_CREDENTIAL_NOT_FOUND',
  'ATTRIBUTION_CREDENTIAL_DECRYPT_FAILED',
  'ATTRIBUTION_CREDENTIAL_CRYPTO_UNAVAILABLE',
])

export const QUEUE_PROVIDERS: Readonly<Record<string, AdAttributionProvider>> = {
  'meigallery-ad-meta': 'meta',
  'meigallery-ad-meta-dlq': 'meta',
  'meigallery-ad-tiktok': 'tiktok',
  'meigallery-ad-tiktok-dlq': 'tiktok',
  'meigallery-ad-google': 'google',
  'meigallery-ad-google-dlq': 'google',
}

type QueueEnv = {
  DB: D1Database
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
}
type QueueMessage = { body: unknown; attempts: number; ack(): void; retry(): void }
export type AttributionDeliveryQueueRow = {
  delivery_id: string
  delivery_provider: string
  status: string
  attempt_count: number
  updated_at: string
  fact_id: string
  canonical_event: string
  fact_provider: string | null
  connection_id: string
  connection_provider: string
  public_config_json: string
  connection_revision: string
  credential_revision: string
  destination: string
  outbox_provider: string | null
  schema_version: number | null
  key_id: string | null
  iv: string | null
  ciphertext: string | null
  tag: string | null
  expires_at: string | null
}
type DecryptedPayload = {
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  eventTime: number
  pageUrl: string
  destination: string
  matchSignals: Record<string, string>
  hashedEmail?: string
}
type DeliveryOutcome = { result: ServerDeliveryResult; errorCode?: string }
type Dependencies = {
  deliver?: (request: Parameters<typeof deliverServerEvent>[0]) => Promise<ServerDeliveryResult>
  readCredential?: typeof readAttributionCredential
  readDelivery?: (db: D1Database, deliveryId: string) => Promise<AttributionDeliveryQueueRow | null>
}

export async function handleAttributionQueueBatch(batch: MessageBatch<AdPlatformQueueMessage>, env: QueueEnv, dependencies: Dependencies = {}) {
  const expectedProvider = QUEUE_PROVIDERS[batch.queue]
  for (const message of batch.messages as unknown as QueueMessage[]) {
    try {
      if (!expectedProvider) {
        const row = await readLocatedDelivery(env.DB, message.body, dependencies)
        await recordIncident(env.DB, row, 'queue_unregistered', batch.queue)
        safeAck(message)
        continue
      }

      const body = parseQueueMessage(message.body)
      if (!body) {
        const row = await readLocatedDelivery(env.DB, message.body, dependencies)
        await recordIncident(env.DB, row, 'queue_message_invalid', batch.queue)
        safeAck(message)
        continue
      }

      const row = await (dependencies.readDelivery ?? readDelivery)(env.DB, body.deliveryId)
      if (body.provider !== expectedProvider || !row || !consistent(row, expectedProvider)) {
        await recordIncident(env.DB, row, 'queue_provider_mismatch', batch.queue)
        safeAck(message)
        continue
      }

      if (terminal(row.status)) {
        await deleteAttributionOutbox(env.DB, row.delivery_id, expectedProvider)
        safeAck(message)
        continue
      }

      const isDlq = batch.queue.endsWith('-dlq')
      if (isDlq) {
        await markDeadLetter(env.DB, row, batch.queue)
        safeAck(message)
        continue
      }

      const token = await claimLease(env.DB, row, message.attempts)
      if (token === null) {
        safeAck(message)
        continue
      }

      const outcome = await deliver(row, env, dependencies)
      if (outcome.result.classification === 'retryable') {
        const retained = await markRetryable(env.DB, row, token)
        if (retained) safeRetry(message)
        else safeAck(message)
        continue
      }

      const finalStatus = outcome.result.classification === 'accepted' || outcome.result.classification === 'processed'
        ? outcome.result.classification
        : 'rejected'
      await finalizeDelivery(env.DB, row, token, finalStatus, outcome, batch.queue)
      safeAck(message)
    }
    catch {
      safeRetry(message)
    }
  }
}

async function readLocatedDelivery(db: D1Database, value: unknown, dependencies: Dependencies) {
  const deliveryId = locateDeliveryId(value)
  return deliveryId ? (dependencies.readDelivery ?? readDelivery)(db, deliveryId) : null
}

function parseQueueMessage(value: unknown): AdPlatformQueueMessage | null {
  if (!isPlainRecord(value)) return null
  const fields = Reflect.ownKeys(value)
  if (fields.length !== 3 || !fields.every(field => typeof field === 'string')) return null
  const schemaVersion = ownDataProperty(value, 'schemaVersion')
  const deliveryId = ownDataProperty(value, 'deliveryId')
  const provider = ownDataProperty(value, 'provider')
  if (schemaVersion !== 1 || !identifier(deliveryId) || !isProvider(provider)) return null
  return { schemaVersion: 1, deliveryId, provider }
}

function locateDeliveryId(value: unknown) {
  if (!isPlainRecord(value)) return ''
  const deliveryId = ownDataProperty(value, 'deliveryId')
  return identifier(deliveryId) ? deliveryId : ''
}

async function readDelivery(db: D1Database, deliveryId: string): Promise<AttributionDeliveryQueueRow | null> {
  return db.prepare(`
    SELECT d.id AS delivery_id, d.provider AS delivery_provider, d.status, d.attempt_count, d.updated_at,
      d.fact_id, f.canonical_event, f.attribution_provider AS fact_provider,
      c.id AS connection_id, c.provider AS connection_provider, c.public_config_json,
      c.connection_revision, c.credential_revision, d.destination,
      o.provider AS outbox_provider, o.schema_version, o.key_id, o.iv, o.ciphertext, o.tag, o.expires_at
    FROM attribution_deliveries AS d
    JOIN attribution_conversion_facts AS f ON f.id = d.fact_id
    JOIN attribution_platform_connections AS c ON c.id = d.connection_id
    LEFT JOIN attribution_outbox AS o ON o.delivery_id = d.id
    WHERE d.id = ? AND d.transport = 'server'
    LIMIT 1
  `).bind(deliveryId).first<AttributionDeliveryQueueRow>()
}

function consistent(row: AttributionDeliveryQueueRow, provider: AdAttributionProvider) {
  return row.delivery_provider === provider
    && row.fact_provider === provider
    && row.connection_provider === provider
    && (terminal(row.status) ? row.outbox_provider === null || row.outbox_provider === provider : row.outbox_provider === provider)
}

async function claimLease(db: D1Database, row: AttributionDeliveryQueueRow, attempts: number) {
  const queueAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1
  const retryEligible = row.status === 'retrying'
    && (row.attempt_count < queueAttempts || stale(row.updated_at))
  if (row.status !== 'queued' && !retryEligible) return null

  const token = row.attempt_count + 1
  const result = await db.prepare(`
    UPDATE attribution_deliveries
    SET status = 'retrying', attempt_count = ?, last_error_code = '', last_error_message = '', updated_at = datetime('now')
    WHERE id = ? AND provider = ? AND transport = 'server'
      AND status = ? AND attempt_count = ? AND updated_at = ?
  `).bind(token, row.delivery_id, row.delivery_provider, row.status, row.attempt_count, row.updated_at).run()
  return changed(result) ? token : null
}

async function markRetryable(db: D1Database, row: AttributionDeliveryQueueRow, token: number) {
  const result = await db.prepare(`
    UPDATE attribution_deliveries
    SET last_error_code = 'retryable', last_error_message = '', updated_at = datetime('now')
    WHERE id = ? AND provider = ? AND transport = 'server'
      AND status = 'retrying' AND attempt_count = ?
  `).bind(row.delivery_id, row.delivery_provider, token).run()
  return changed(result)
}

async function deliver(row: AttributionDeliveryQueueRow, env: QueueEnv, dependencies: Dependencies): Promise<DeliveryOutcome> {
  const expiry = parseExpiry(row.expires_at)
  if (!validEnvelope(row)) return { result: { classification: 'rejected' }, errorCode: 'outbox_invalid' }
  if (expiry === null) return { result: { classification: 'rejected' }, errorCode: 'outbox_invalid' }
  if (expiry <= Date.now()) return { result: { classification: 'rejected' }, errorCode: 'outbox_expired' }

  let keys: Awaited<ReturnType<typeof loadAttributionCryptoKeys>>
  try {
    keys = await loadAttributionCryptoKeys(env)
  }
  catch {
    return { result: { classification: 'retryable' } }
  }

  let plaintext: string
  try {
    plaintext = await decryptAttributionValue({
      keys,
      aad: { purpose: 'outbox', provider: row.delivery_provider, subjectId: row.fact_id, revision: row.connection_revision },
      envelope: { schemaVersion: 1, keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag },
    })
  }
  catch {
    return { result: { classification: 'rejected' }, errorCode: 'outbox_invalid' }
  }

  const payload = parsePayload(plaintext, row)
  if (!payload) return { result: { classification: 'rejected' }, errorCode: 'outbox_invalid' }
  const config = parseConfig(row.public_config_json)
  if (!config) return { result: { classification: 'destination_invalid' } }

  let credential: string
  try {
    credential = await (dependencies.readCredential ?? readAttributionCredential)(env, {
      connectionId: row.connection_id,
      provider: row.delivery_provider as AdAttributionProvider,
      credentialType: row.delivery_provider === 'google' ? 'service_account_json' : 'access_token',
      credentialRevision: row.credential_revision,
    })
  }
  catch (error) {
    return permanentCredentialError(error)
      ? { result: { classification: 'credential_invalid' } }
      : { result: { classification: 'retryable' } }
  }

  try {
    const result = await (dependencies.deliver ?? deliverServerEvent)({
      input: { ...payload, provider: row.delivery_provider, validateOnly: false } as ServerDeliveryInput,
      config,
      credential,
    })
    return { result }
  }
  catch {
    return { result: { classification: 'retryable' } }
  }
}

function parsePayload(plaintext: string, row: AttributionDeliveryQueueRow): DecryptedPayload | null {
  try {
    const value = JSON.parse(plaintext) as Record<string, unknown>
    if ((value.canonicalEvent !== 'Contact' && value.canonicalEvent !== 'CompleteRegistration')
      || !identifier(value.externalEventId)
      || !Number.isSafeInteger(value.eventTime)
      || !validUrl(value.pageUrl)
      || typeof value.destination !== 'string'
      || value.destination !== row.destination
      || !plainSignals(value.matchSignals)) return null
    if (value.hashedEmail !== undefined && (typeof value.hashedEmail !== 'string' || !/^[a-f0-9]{64}$/.test(value.hashedEmail))) return null
    return value as DecryptedPayload
  }
  catch {
    return null
  }
}

function parseConfig(value: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isPlainRecord(parsed) && Object.values(parsed).every(item => typeof item === 'string')
      ? parsed as Record<string, string>
      : null
  }
  catch {
    return null
  }
}

function plainSignals(value: unknown): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.entries(value).every(([key, item]) => identifier(key) && typeof item === 'string' && item.length > 0 && item.length <= 1_000)
}

async function finalizeDelivery(
  db: D1Database,
  row: AttributionDeliveryQueueRow,
  token: number,
  status: 'accepted' | 'processed' | 'rejected',
  outcome: DeliveryOutcome,
  queue: string,
) {
  const errorCode = status === 'rejected' ? outcome.errorCode ?? outcome.result.classification : ''
  const fence = `finalize:${crypto.randomUUID()}`
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = ?, last_error_code = ?, last_error_message = '',
        accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE accepted_at END,
        processed_at = CASE WHEN ? = 'processed' THEN datetime('now') ELSE processed_at END,
        updated_at = datetime('now')
      WHERE id = ? AND provider = ? AND transport = 'server'
        AND status = 'retrying' AND attempt_count = ?
    `).bind(status, fence, status, status, row.delivery_id, row.delivery_provider, token),
    db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id = ? AND provider = ?
        AND EXISTS (
          SELECT 1 FROM attribution_deliveries
          WHERE id = ? AND provider = ? AND status = ? AND attempt_count = ? AND last_error_code = ?
        )
    `).bind(row.delivery_id, row.delivery_provider, row.delivery_id, row.delivery_provider, status, token, fence),
    receiptStatement(db, row, token, status, fence, outcome.result),
    ...(outcome.result.incident ? [incidentStatement(db, row, outcome.result.incident.code, queue, status, token, fence)] : []),
    db.prepare(`
      UPDATE attribution_deliveries
      SET last_error_code = ?
      WHERE id = ? AND provider = ? AND status = ? AND attempt_count = ? AND last_error_code = ?
    `).bind(errorCode, row.delivery_id, row.delivery_provider, status, token, fence),
  ])
  return changed(results[0])
}

async function markDeadLetter(db: D1Database, row: AttributionDeliveryQueueRow, queue: string) {
  const token = row.attempt_count + 1
  const fence = `dead_letter:${crypto.randomUUID()}`
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'dead_letter', attempt_count = ?, last_error_code = ?, last_error_message = '', updated_at = datetime('now')
      WHERE id = ? AND provider = ? AND transport = 'server'
        AND status = ? AND attempt_count = ? AND updated_at = ?
    `).bind(token, fence, row.delivery_id, row.delivery_provider, row.status, row.attempt_count, row.updated_at),
    db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id = ? AND provider = ?
        AND EXISTS (
          SELECT 1 FROM attribution_deliveries
          WHERE id = ? AND provider = ? AND status = 'dead_letter' AND attempt_count = ? AND last_error_code = ?
        )
    `).bind(row.delivery_id, row.delivery_provider, row.delivery_id, row.delivery_provider, token, fence),
    incidentStatement(db, row, 'queue_dead_letter', queue, 'dead_letter', token, fence),
    db.prepare(`
      UPDATE attribution_deliveries
      SET last_error_code = 'queue_dead_letter'
      WHERE id = ? AND provider = ? AND status = 'dead_letter' AND attempt_count = ? AND last_error_code = ?
    `).bind(row.delivery_id, row.delivery_provider, token, fence),
  ])
  return changed(results[0])
}

async function recordIncident(db: D1Database, row: AttributionDeliveryQueueRow | null, code: string, queue: string) {
  if (!row || !isProvider(row.delivery_provider)) return
  await db.prepare(`
    INSERT INTO attribution_incidents (
      id, connection_id, provider, status, severity, trigger_code, summary, evidence_json, opened_at
    ) VALUES (?, ?, ?, 'open', 'critical', ?, '广告归因异步投递被安全终止', ?, datetime('now'))
  `).bind(crypto.randomUUID(), row.connection_id, row.delivery_provider, code, JSON.stringify({ queue })).run()
}

function receiptStatement(db: D1Database, row: AttributionDeliveryQueueRow, token: number, status: string, fence: string, result: ServerDeliveryResult) {
  const receipt = { status: result.receipt?.status, requestId: safeRequestId(result.receipt?.requestId) }
  return db.prepare(`
    INSERT INTO attribution_provider_receipts (
      id, delivery_id, provider, receipt_type, status, receipt_json, received_at
    )
    SELECT ?, ?, ?, 'server_delivery', ?, ?, datetime('now')
    WHERE EXISTS (
      SELECT 1 FROM attribution_deliveries
      WHERE id = ? AND provider = ? AND status = ? AND attempt_count = ? AND last_error_code = ?
    )
  `).bind(crypto.randomUUID(), row.delivery_id, row.delivery_provider, status, JSON.stringify(receipt), row.delivery_id, row.delivery_provider, status, token, fence)
}

function incidentStatement(db: D1Database, row: AttributionDeliveryQueueRow, code: string, queue: string, status: string, token: number, fence: string) {
  return db.prepare(`
    INSERT INTO attribution_incidents (
      id, connection_id, provider, status, severity, trigger_code, summary, evidence_json, opened_at
    )
    SELECT ?, ?, ?, 'open', 'critical', ?, '广告归因异步投递被安全终止', ?, datetime('now')
    WHERE EXISTS (
      SELECT 1 FROM attribution_deliveries
      WHERE id = ? AND provider = ? AND status = ? AND attempt_count = ? AND last_error_code = ?
    )
  `).bind(crypto.randomUUID(), row.connection_id, row.delivery_provider, code, JSON.stringify({ queue }), row.delivery_id, row.delivery_provider, status, token, fence)
}

function validEnvelope(row: AttributionDeliveryQueueRow): row is AttributionDeliveryQueueRow & { key_id: string; iv: string; ciphertext: string; tag: string; expires_at: string } {
  return row.schema_version === 1
    && typeof row.key_id === 'string' && row.key_id.length > 0
    && typeof row.iv === 'string' && row.iv.length > 0
    && typeof row.ciphertext === 'string' && row.ciphertext.length > 0
    && typeof row.tag === 'string' && row.tag.length > 0
    && typeof row.expires_at === 'string' && row.expires_at.length > 0
}

function permanentCredentialError(error: unknown) {
  return error instanceof CredentialVaultError && PERMANENT_CREDENTIAL_ERRORS.has(error.code)
}

function parseExpiry(value: string | null) {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stale(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) && parsed <= Date.now() - LEASE_STALE_MINUTES * 60_000
}

function terminal(status: string) {
  return status === 'accepted' || status === 'processed' || status === 'rejected' || status === 'dead_letter' || status === 'cancelled'
}
function isProvider(value: unknown): value is AdAttributionProvider { return value === 'meta' || value === 'tiktok' || value === 'google' }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validUrl(value: unknown) { try { const url = new URL(String(value)); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) } catch { return false } }
function safeRequestId(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : undefined }
function changed(result: D1Result<unknown> | undefined) { return (result?.meta?.changes ?? 0) > 0 }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) }
function ownDataProperty(value: object, key: string) { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined }
function safeAck(message: QueueMessage) { try { message.ack() } catch { /* 单条消息确认失败不阻塞同批次。 */ } }
function safeRetry(message: QueueMessage) { try { message.retry() } catch { /* 单条消息重试失败不泄露投递数据。 */ } }
