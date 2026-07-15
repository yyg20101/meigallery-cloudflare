import type { AdAttributionProvider, AdPlatformQueueMessage } from '@meigallery/shared'

const STALE_MINUTES = 5
const MAX_LIMIT = 100

export type AttributionQueueEnv = {
  DB: D1Database
  AD_META_QUEUE?: Queue<AdPlatformQueueMessage>
  AD_TIKTOK_QUEUE?: Queue<AdPlatformQueueMessage>
  AD_GOOGLE_QUEUE?: Queue<AdPlatformQueueMessage>
}

type OutboxDeliveryRow = {
  delivery_id: string
  provider: string
  status: string
  attempt_count: number
  queue_attempt_count: number
  expires_at: string
  updated_at: string
}

const PROVIDER_QUEUES: Readonly<Record<AdAttributionProvider, keyof Omit<AttributionQueueEnv, 'DB'>>> = {
  meta: 'AD_META_QUEUE',
  tiktok: 'AD_TIKTOK_QUEUE',
  google: 'AD_GOOGLE_QUEUE',
}

export function getAttributionQueue(env: AttributionQueueEnv, provider: AdAttributionProvider): Queue<AdPlatformQueueMessage> | undefined {
  return env[PROVIDER_QUEUES[provider]]
}

export async function enqueueAttributionDelivery(
  env: AttributionQueueEnv,
  input: { provider: AdAttributionProvider; deliveryId: string; queue?: Queue<AdPlatformQueueMessage> },
): Promise<'enqueued' | 'failed' | 'expired' | 'not_pending'> {
  const queue = input.queue ?? getAttributionQueue(env, input.provider)
  if (!queue) return 'failed'

  const row = await readOutboxDelivery(env.DB, input.deliveryId, input.provider)
  if (!row || row.provider !== input.provider || !recoverable(row)) return 'not_pending'
  if (invalidOrExpired(row.expires_at)) {
    const expired = await expireAttributionOutbox(env.DB, [row])
    return expired > 0 ? 'expired' : 'not_pending'
  }

  const queueToken = row.queue_attempt_count + 1
  const claim = await env.DB.prepare(`
    UPDATE attribution_deliveries
    SET status = 'queued', queue_attempt_count = ?, last_error_code = '', last_error_message = '',
      queued_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND provider = ? AND transport = 'server'
      AND status = ? AND queue_attempt_count = ? AND updated_at = ?
      AND EXISTS (
        SELECT 1 FROM attribution_outbox
        WHERE delivery_id = attribution_deliveries.id AND provider = attribution_deliveries.provider
      )
  `).bind(queueToken, input.deliveryId, input.provider, row.status, row.queue_attempt_count, row.updated_at).run()
  if (!changed(claim)) return 'not_pending'

  const message: AdPlatformQueueMessage = { schemaVersion: 1, deliveryId: input.deliveryId, provider: input.provider }
  try {
    await queue.send(message)
    return 'enqueued'
  }
  catch {
    try {
      await env.DB.prepare(`
        UPDATE attribution_deliveries
        SET status = 'retrying', last_error_code = 'queue_send_failed', last_error_message = '', updated_at = datetime('now')
        WHERE id = ? AND provider = ? AND transport = 'server'
          AND status = 'queued' AND queue_attempt_count = ?
      `).bind(input.deliveryId, input.provider, queueToken).run()
    }
    catch {
      // Fact 与 Outbox 已提交，诊断失败由恢复 Cron 接管。
    }
    return 'failed'
  }
}

export async function listRecoverableAttributionOutbox(db: D1Database, limit = MAX_LIMIT): Promise<Array<{ deliveryId: string; provider: AdAttributionProvider }>> {
  const normalizedLimit = normalizeLimit(limit)
  if (normalizedLimit === 0) return []
  const result = await db.prepare(`
    SELECT o.delivery_id, o.provider
    FROM attribution_outbox AS o
    JOIN attribution_deliveries AS d ON d.id = o.delivery_id AND d.provider = o.provider
    WHERE d.transport = 'server'
      AND datetime(o.expires_at) IS NOT NULL
      AND datetime(o.expires_at) > datetime('now')
      AND (
        d.status = 'planned'
        OR (d.status IN ('queued', 'retrying') AND d.updated_at <= datetime('now', '-${STALE_MINUTES} minutes'))
      )
    ORDER BY o.created_at ASC, o.delivery_id ASC
    LIMIT ?
  `).bind(normalizedLimit).all<{ delivery_id: string; provider: string }>()
  return result.results.flatMap(row => isProvider(row.provider) ? [{ deliveryId: row.delivery_id, provider: row.provider }] : [])
}

export async function purgeExpiredAttributionOutbox(db: D1Database, limit = MAX_LIMIT): Promise<number> {
  const normalizedLimit = normalizeLimit(limit)
  if (normalizedLimit === 0) return 0
  const result = await db.prepare(`
    SELECT o.delivery_id, o.provider, d.status, d.attempt_count, d.queue_attempt_count, o.expires_at, d.updated_at
    FROM attribution_outbox AS o
    JOIN attribution_deliveries AS d ON d.id = o.delivery_id AND d.provider = o.provider
    WHERE datetime(o.expires_at) IS NULL OR datetime(o.expires_at) <= datetime('now')
    ORDER BY o.expires_at ASC, o.delivery_id ASC
    LIMIT ?
  `).bind(normalizedLimit).all<OutboxDeliveryRow>()
  return expireAttributionOutbox(db, result.results.filter(validOutboxRow))
}

export async function deleteAttributionOutbox(db: D1Database, deliveryId: string, provider: AdAttributionProvider) {
  await db.prepare('DELETE FROM attribution_outbox WHERE delivery_id = ? AND provider = ?').bind(deliveryId, provider).run()
}

async function readOutboxDelivery(db: D1Database, deliveryId: string, provider: AdAttributionProvider) {
  return db.prepare(`
    SELECT o.delivery_id, o.provider, d.status, d.attempt_count, d.queue_attempt_count, o.expires_at, d.updated_at
    FROM attribution_outbox AS o
    JOIN attribution_deliveries AS d ON d.id = o.delivery_id AND d.provider = o.provider
    WHERE o.delivery_id = ? AND o.provider = ? AND d.transport = 'server'
    LIMIT 1
  `).bind(deliveryId, provider).first<OutboxDeliveryRow>()
}

async function expireAttributionOutbox(db: D1Database, rows: OutboxDeliveryRow[]) {
  let purged = 0
  for (const row of rows) {
    if (!isProvider(row.provider)) continue
    if (terminal(row.status)) {
      const deleted = await db.prepare(`
        DELETE FROM attribution_outbox
        WHERE delivery_id = ? AND provider = ?
          AND EXISTS (
            SELECT 1 FROM attribution_deliveries
            WHERE id = ? AND provider = ? AND status = ?
              AND attempt_count = ? AND queue_attempt_count = ?
          )
      `).bind(row.delivery_id, row.provider, row.delivery_id, row.provider, row.status, row.attempt_count, row.queue_attempt_count).run()
      if (changed(deleted)) purged += 1
      continue
    }
    const results = await db.batch([
      db.prepare(`
        UPDATE attribution_deliveries
        SET status = 'rejected', last_error_code = ?, last_error_message = '', updated_at = datetime('now')
        WHERE id = ? AND provider = ? AND transport = 'server'
          AND status = ? AND attempt_count = ? AND queue_attempt_count = ? AND updated_at = ?
          AND status IN ('planned', 'queued', 'retrying')
      `).bind(expiryErrorCode(row.expires_at), row.delivery_id, row.provider, row.status, row.attempt_count, row.queue_attempt_count, row.updated_at),
      db.prepare(`
        DELETE FROM attribution_outbox
        WHERE delivery_id = ? AND provider = ?
          AND EXISTS (
            SELECT 1 FROM attribution_deliveries
            WHERE id = ? AND provider = ? AND status = 'rejected'
              AND attempt_count = ? AND queue_attempt_count = ?
          )
      `).bind(row.delivery_id, row.provider, row.delivery_id, row.provider, row.attempt_count, row.queue_attempt_count),
    ])
    if (changed(results[1])) purged += 1
  }
  return purged
}

function recoverable(row: OutboxDeliveryRow) {
  return row.status === 'planned' || ((row.status === 'queued' || row.status === 'retrying') && stale(row.updated_at))
}
function terminal(status: string) { return status === 'accepted' || status === 'processed' || status === 'rejected' || status === 'dead_letter' || status === 'cancelled' }
function validOutboxRow(row: OutboxDeliveryRow) { return isProvider(row.provider) }
function isProvider(value: string): value is AdAttributionProvider { return value === 'meta' || value === 'tiktok' || value === 'google' }
function invalidOrExpired(value: string) { const parsed = Date.parse(value); return !Number.isFinite(parsed) || parsed <= Date.now() }
function expiryErrorCode(value: string) { return Number.isFinite(Date.parse(value)) ? 'outbox_expired' : 'outbox_invalid' }
function stale(value: string) { const parsed = Date.parse(normalizeSqlDate(value)); return Number.isFinite(parsed) && parsed <= Date.now() - STALE_MINUTES * 60_000 }
function normalizeSqlDate(value: string) { return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value }
function normalizeLimit(limit: number) { return Math.min(MAX_LIMIT, Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : MAX_LIMIT)) }
function changed(result: D1Result<unknown> | undefined) { return (result?.meta?.changes ?? 0) > 0 }
