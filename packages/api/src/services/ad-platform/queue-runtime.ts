import type { AdAttributionProvider, AdPlatformQueueMessage, CanonicalConversionEvent } from '@meigallery/shared'
import { decryptAttributionValue, loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import { readAttributionCredential } from './credential-vault'
import { deleteAttributionOutbox } from './secure-outbox'
import { deliverServerEvent, type ServerDeliveryInput, type ServerDeliveryResult } from './server-adapter'

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
type DeliveryRow = {
  delivery_id: string; delivery_provider: string; status: string; attempt_count: number; fact_id: string; canonical_event: string; fact_provider: string | null
  connection_id: string; connection_provider: string; public_config_json: string; connection_revision: string; credential_revision: string; destination: string
  outbox_provider: string | null; schema_version: number | null; key_id: string | null; iv: string | null; ciphertext: string | null; tag: string | null; expires_at: string | null
}
type DecryptedPayload = { canonicalEvent: CanonicalConversionEvent; externalEventId: string; eventTime: number; pageUrl: string; destination: string; matchSignals: Record<string, string>; hashedEmail?: string }
type Dependencies = {
  deliver?: (request: Parameters<typeof deliverServerEvent>[0]) => Promise<ServerDeliveryResult>
  readCredential?: typeof readAttributionCredential
}

export async function handleAttributionQueueBatch(batch: MessageBatch<AdPlatformQueueMessage>, env: QueueEnv, dependencies: Dependencies = {}) {
  const expectedProvider = QUEUE_PROVIDERS[batch.queue]
  const isDlq = batch.queue.endsWith('-dlq')
  for (const message of batch.messages as unknown as QueueMessage[]) {
    try {
      if (!expectedProvider) {
        const row = await readDelivery(env.DB, message.body)
        await recordIncident(env.DB, row, 'queue_unregistered', batch.queue)
        message.ack()
        continue
      }
      const body = parseQueueMessage(message.body)
      const row = await readDelivery(env.DB, body)
      if (!body || body.provider !== expectedProvider || !row || !consistent(row, expectedProvider)) {
        await recordIncident(env.DB, row, 'queue_provider_mismatch', batch.queue)
        message.ack()
        continue
      }
      if (isDlq) {
        await markDeadLetter(env.DB, row, batch.queue)
        message.ack()
        continue
      }
      if (terminal(row.status)) {
        await deleteAttributionOutbox(env.DB, row.delivery_id, expectedProvider)
        message.ack()
        continue
      }
      const claimed = await claimLease(env.DB, row, message.attempts)
      if (!claimed) {
        message.ack()
        continue
      }
      const result = await deliver(row, env, dependencies)
      if (result.classification === 'retryable') {
        await env.DB.prepare("UPDATE attribution_deliveries SET status = 'retrying', last_error_code = 'retryable', last_error_message = '', updated_at = datetime('now') WHERE id = ? AND provider = ?").bind(row.delivery_id, expectedProvider).run()
        message.retry()
        continue
      }
      const finalStatus = result.classification === 'accepted' || result.classification === 'processed' ? result.classification : 'rejected'
      await finalizeDelivery(env.DB, row, finalStatus, result, batch.queue)
      message.ack()
    }
    catch {
      try { message.retry() } catch { /* Queue 操作失败不泄露投递数据。 */ }
    }
  }
}

function parseQueueMessage(value: unknown): AdPlatformQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3 || record.schemaVersion !== 1 || typeof record.deliveryId !== 'string' || !identifier(record.deliveryId) || !isProvider(record.provider)) return null
  return { schemaVersion: 1, deliveryId: record.deliveryId, provider: record.provider }
}

async function readDelivery(db: D1Database, body: unknown): Promise<DeliveryRow | null> {
  const deliveryId = body && typeof body === 'object' && typeof (body as Record<string, unknown>).deliveryId === 'string' ? (body as Record<string, string>).deliveryId : ''
  if (!identifier(deliveryId)) return null
  return db.prepare(`
    SELECT d.id AS delivery_id, d.provider AS delivery_provider, d.status, d.attempt_count, d.fact_id, f.canonical_event, f.attribution_provider AS fact_provider,
      c.id AS connection_id, c.provider AS connection_provider, c.public_config_json, c.connection_revision, c.credential_revision, d.destination,
      o.provider AS outbox_provider, o.schema_version, o.key_id, o.iv, o.ciphertext, o.tag, o.expires_at
    FROM attribution_deliveries AS d
    JOIN attribution_conversion_facts AS f ON f.id = d.fact_id
    JOIN attribution_platform_connections AS c ON c.id = d.connection_id
    LEFT JOIN attribution_outbox AS o ON o.delivery_id = d.id
    WHERE d.id = ? AND d.transport = 'server' LIMIT 1
  `).bind(deliveryId).first<DeliveryRow>()
}

function consistent(row: DeliveryRow, provider: AdAttributionProvider) {
  return row.delivery_provider === provider && row.fact_provider === provider && row.connection_provider === provider && row.outbox_provider === provider
}

async function claimLease(db: D1Database, row: DeliveryRow, attempts: number) {
  const queueAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1
  const result = await db.prepare(`
    UPDATE attribution_deliveries
    SET status = 'retrying', attempt_count = attempt_count + 1, last_error_code = '', last_error_message = '', updated_at = datetime('now')
    WHERE id = ? AND provider = ? AND transport = 'server'
      AND (status = 'queued' OR (status = 'retrying' AND (attempt_count < ? OR updated_at <= datetime('now', '-5 minutes'))))
  `).bind(row.delivery_id, row.delivery_provider, queueAttempts).run()
  return (result.meta?.changes ?? 0) > 0
}

async function deliver(row: DeliveryRow, env: QueueEnv, dependencies: Dependencies): Promise<ServerDeliveryResult> {
  if (!row.schema_version || row.schema_version !== 1 || !row.key_id || !row.iv || !row.ciphertext || !row.tag || !row.expires_at || Date.parse(row.expires_at) <= Date.now()) {
    return { classification: 'rejected' }
  }
  try {
    const plaintext = await decryptAttributionValue({
      keys: await loadAttributionCryptoKeys(env),
      aad: { purpose: 'outbox', provider: row.delivery_provider, subjectId: row.fact_id, revision: row.connection_revision },
      envelope: { schemaVersion: 1, keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag },
    })
    const payload = parsePayload(plaintext, row)
    if (!payload) return { classification: 'rejected' }
    const config = parseConfig(row.public_config_json)
    if (!config) return { classification: 'destination_invalid' }
    const credential = await (dependencies.readCredential ?? readAttributionCredential)(env, {
      connectionId: row.connection_id, provider: row.delivery_provider as AdAttributionProvider,
      credentialType: row.delivery_provider === 'google' ? 'service_account_json' : 'access_token', credentialRevision: row.credential_revision,
    })
    return (dependencies.deliver ?? deliverServerEvent)({ input: { ...payload, provider: row.delivery_provider, validateOnly: false } as ServerDeliveryInput, config, credential })
  }
  catch {
    return { classification: 'credential_invalid' }
  }
}

function parsePayload(plaintext: string, row: DeliveryRow): DecryptedPayload | null {
  try {
    const value = JSON.parse(plaintext) as Record<string, unknown>
    if ((value.canonicalEvent !== 'Contact' && value.canonicalEvent !== 'CompleteRegistration') || !identifier(value.externalEventId) || !Number.isSafeInteger(value.eventTime) || !validUrl(value.pageUrl) || typeof value.destination !== 'string' || value.destination !== row.destination || !plainSignals(value.matchSignals)) return null
    if (value.hashedEmail !== undefined && (typeof value.hashedEmail !== 'string' || !/^[a-f0-9]{64}$/.test(value.hashedEmail))) return null
    return value as DecryptedPayload
  } catch { return null }
}
function parseConfig(value: string): Record<string, string> | null { try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed as Record<string, unknown>).every(item => typeof item === 'string') ? parsed as Record<string, string> : null } catch { return null } }
function plainSignals(value: unknown): value is Record<string, string> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.entries(value as Record<string, unknown>).every(([key, item]) => identifier(key) && typeof item === 'string' && item.length > 0 && item.length <= 1_000) }

async function finalizeDelivery(db: D1Database, row: DeliveryRow, status: 'accepted' | 'processed' | 'rejected', result: ServerDeliveryResult, queue: string) {
  await db.batch([
    db.prepare(`UPDATE attribution_deliveries SET status = ?, last_error_code = ?, last_error_message = '', accepted_at = CASE WHEN ? = 'accepted' THEN datetime('now') ELSE accepted_at END, processed_at = CASE WHEN ? = 'processed' THEN datetime('now') ELSE processed_at END, updated_at = datetime('now') WHERE id = ? AND provider = ?`).bind(status, status === 'rejected' ? result.classification : '', status, status, row.delivery_id, row.delivery_provider),
    db.prepare('DELETE FROM attribution_outbox WHERE delivery_id = ? AND provider = ?').bind(row.delivery_id, row.delivery_provider),
    receiptStatement(db, row, status, result),
    ...(result.incident ? [incidentStatement(db, row, result.incident.code, queue)] : []),
  ])
}
async function markDeadLetter(db: D1Database, row: DeliveryRow, queue: string) {
  await db.batch([
    db.prepare("UPDATE attribution_deliveries SET status = 'dead_letter', last_error_code = 'queue_dead_letter', last_error_message = '', updated_at = datetime('now') WHERE id = ? AND provider = ? AND status NOT IN ('accepted', 'processed', 'rejected', 'cancelled')").bind(row.delivery_id, row.delivery_provider),
    db.prepare('DELETE FROM attribution_outbox WHERE delivery_id = ? AND provider = ?').bind(row.delivery_id, row.delivery_provider),
    incidentStatement(db, row, 'queue_dead_letter', queue),
  ])
}
async function recordIncident(db: D1Database, row: DeliveryRow | null, code: string, queue: string) { if (row) await incidentStatement(db, row, code, queue).run() }
function receiptStatement(db: D1Database, row: DeliveryRow, status: string, result: ServerDeliveryResult) {
  const receipt = { status: result.receipt?.status, requestId: safeRequestId(result.receipt?.requestId) }
  return db.prepare("INSERT INTO attribution_provider_receipts (id, delivery_id, provider, receipt_type, status, receipt_json, received_at) VALUES (?, ?, ?, 'server_delivery', ?, ?, datetime('now'))").bind(crypto.randomUUID(), row.delivery_id, row.delivery_provider, status, JSON.stringify(receipt))
}
function incidentStatement(db: D1Database, row: DeliveryRow, code: string, queue: string) {
  return db.prepare("INSERT INTO attribution_incidents (id, connection_id, provider, status, severity, trigger_code, summary, evidence_json, opened_at) VALUES (?, ?, ?, 'open', 'critical', ?, '广告归因异步投递被安全终止', ?, datetime('now'))").bind(crypto.randomUUID(), row.connection_id, row.delivery_provider, code, JSON.stringify({ queue }))
}
function terminal(status: string) { return status === 'accepted' || status === 'processed' || status === 'rejected' || status === 'dead_letter' || status === 'cancelled' }
function isProvider(value: unknown): value is AdAttributionProvider { return value === 'meta' || value === 'tiktok' || value === 'google' }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validUrl(value: unknown) { try { const url = new URL(String(value)); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) } catch { return false } }
function safeRequestId(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : undefined }
