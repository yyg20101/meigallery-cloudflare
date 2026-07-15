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
  input: { provider: AdAttributionProvider; deliveryId: string; queue?: Queue<AdPlatformQueueMessage>; requireStale?: boolean },
): Promise<'enqueued' | 'failed' | 'expired' | 'not_pending'> {
  const queue = input.queue ?? getAttributionQueue(env, input.provider)
  if (!queue) return 'failed'

  const row = await env.DB.prepare(`
    SELECT o.delivery_id, o.provider, d.status, o.expires_at, d.updated_at
    FROM attribution_outbox AS o
    JOIN attribution_deliveries AS d ON d.id = o.delivery_id AND d.provider = o.provider
    WHERE o.delivery_id = ? AND o.provider = ? AND d.transport = 'server'
    LIMIT 1
  `).bind(input.deliveryId, input.provider).first<OutboxDeliveryRow>()
  if (!row || row.provider !== input.provider || !isRecoverableStatus(row.status) || input.requireStale && !isStale(row.updated_at)) return 'not_pending'
  if (isExpired(row.expires_at)) {
    await expireAttributionOutbox(env.DB, [{ deliveryId: input.deliveryId, provider: input.provider }])
    return 'expired'
  }

  const claim = await env.DB.prepare(`
    UPDATE attribution_deliveries
    SET status = 'queued', queue_attempt_count = queue_attempt_count + 1,
      last_error_code = '', last_error_message = '', queued_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND provider = ? AND transport = 'server'
      AND status IN ('planned', 'retrying', 'queued')
      ${input.requireStale ? `AND updated_at <= datetime('now', '-${STALE_MINUTES} minutes')` : ''}
      AND EXISTS (SELECT 1 FROM attribution_outbox WHERE delivery_id = attribution_deliveries.id AND provider = attribution_deliveries.provider)
  `).bind(input.deliveryId, input.provider).run()
  if (!changed(claim)) return 'not_pending'

  const message: AdPlatformQueueMessage = { schemaVersion: 1, deliveryId: input.deliveryId, provider: input.provider }
  try {
    await queue.send(message)
    return 'enqueued'
  }
  catch {
    await env.DB.prepare(`
      UPDATE attribution_deliveries
      SET status = 'retrying', last_error_code = 'queue_send_failed', last_error_message = '', updated_at = datetime('now')
      WHERE id = ? AND provider = ? AND transport = 'server' AND status = 'queued'
    `).bind(input.deliveryId, input.provider).run()
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
      AND datetime(o.expires_at) > datetime('now')
      AND (d.status = 'planned' OR (d.status IN ('queued', 'retrying') AND d.updated_at <= datetime('now', '-${STALE_MINUTES} minutes')))
    ORDER BY o.created_at ASC, o.delivery_id ASC
    LIMIT ?
  `).bind(normalizedLimit).all<{ delivery_id: string; provider: string }>()
  return result.results.flatMap(row => isProvider(row.provider) ? [{ deliveryId: row.delivery_id, provider: row.provider }] : [])
}

export async function purgeExpiredAttributionOutbox(db: D1Database, limit = MAX_LIMIT): Promise<number> {
  const normalizedLimit = normalizeLimit(limit)
  if (normalizedLimit === 0) return 0
  const result = await db.prepare(`
    SELECT delivery_id, provider FROM attribution_outbox
    WHERE datetime(expires_at) <= datetime('now')
    ORDER BY expires_at ASC, delivery_id ASC LIMIT ?
  `).bind(normalizedLimit).all<{ delivery_id: string; provider: string }>()
  const rows = result.results.flatMap(row => isProvider(row.provider) ? [{ deliveryId: row.delivery_id, provider: row.provider }] : [])
  await expireAttributionOutbox(db, rows)
  return rows.length
}

export async function deleteAttributionOutbox(db: D1Database, deliveryId: string, provider: AdAttributionProvider) {
  await db.prepare('DELETE FROM attribution_outbox WHERE delivery_id = ? AND provider = ?').bind(deliveryId, provider).run()
}

async function expireAttributionOutbox(db: D1Database, rows: Array<{ deliveryId: string; provider: AdAttributionProvider }>) {
  if (rows.length === 0) return
  await db.batch(rows.flatMap(row => [
    db.prepare(`UPDATE attribution_deliveries SET status = 'rejected', last_error_code = 'outbox_expired', last_error_message = '', updated_at = datetime('now') WHERE id = ? AND provider = ? AND status NOT IN ('accepted', 'processed', 'rejected', 'dead_letter', 'cancelled')`).bind(row.deliveryId, row.provider),
    db.prepare('DELETE FROM attribution_outbox WHERE delivery_id = ? AND provider = ?').bind(row.deliveryId, row.provider),
  ]))
}

function isRecoverableStatus(value: string) { return value === 'planned' || value === 'queued' || value === 'retrying' }
function isProvider(value: string): value is AdAttributionProvider { return value === 'meta' || value === 'tiktok' || value === 'google' }
function isExpired(value: string) { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed <= Date.now() }
function isStale(value: string) { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed <= Date.now() - STALE_MINUTES * 60_000 }
function normalizeLimit(limit: number) { return Math.min(MAX_LIMIT, Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : MAX_LIMIT)) }
function changed(result: D1Result<unknown>) { return (result.meta?.changes ?? 0) > 0 }
