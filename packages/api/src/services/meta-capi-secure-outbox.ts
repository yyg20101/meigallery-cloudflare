import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import type { MetaCapiEncryptedEnvelope } from '../utils/meta-capi-crypto'

const META_RECOVERY_STALE_MINUTES = 5
const MAX_PURGE_LIMIT = 100

export type SecureOutboxEnv = Pick<Bindings, 'DB' | 'META_CAPI_QUEUE'>

type SecureOutboxRow = {
  delivery_id: string
  schema_version: number
  key_id: string
  iv: string
  ciphertext: string
  tag: string
  expires_at: string
  status: string
  skip_reason: string
  error_code: string
  queue_enqueued_at: string | null
  queue_attempt_count: number
  updated_at: string
  date: string
  event_name: string
}

type ExpiredOutboxRow = Pick<
  SecureOutboxRow,
  'delivery_id' | 'status' | 'skip_reason' | 'error_code' | 'date' | 'event_name'
>

export function createSecureOutboxStatement(
  db: D1Database,
  input: { deliveryId: string; envelope: MetaCapiEncryptedEnvelope; expiresAt: string },
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO meta_capi_secure_outbox (
      delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now')
    WHERE EXISTS (
      SELECT 1
      FROM analytics_conversion_deliveries
      WHERE id = ? AND channel = 'meta_capi' AND status = 'pending'
    )
  `).bind(
    input.deliveryId,
    input.envelope.schemaVersion,
    input.envelope.keyId,
    input.envelope.iv,
    input.envelope.ciphertext,
    input.envelope.tag,
    input.expiresAt,
    input.deliveryId,
  )
}

export async function enqueueSecureMetaCapiDelivery(
  env: SecureOutboxEnv,
  deliveryId: string,
  options: { requireStale?: boolean } = {},
): Promise<'enqueued' | 'failed' | 'expired' | 'not_pending'> {
  if (!env.META_CAPI_QUEUE) {
    await markQueueUnavailable(env.DB, deliveryId)
    return 'failed'
  }

  const row = await readSecureOutbox(env.DB, deliveryId)
  if (!row || row.status !== 'pending' || row.queue_enqueued_at) return 'not_pending'
  if (isExpired(row.expires_at)) {
    await expireOutboxRows(env.DB, [row])
    return 'expired'
  }

  const staleCondition = options.requireStale
    ? `AND updated_at <= datetime('now', '-${META_RECOVERY_STALE_MINUTES} minutes')`
    : ''
  const claimed = await env.DB.prepare(`
    UPDATE analytics_conversion_deliveries
    SET
      queue_attempt_count = queue_attempt_count + 1,
      error_code = '',
      error_message = '',
      updated_at = datetime('now')
    WHERE id = ?
      AND channel = 'meta_capi'
      AND status = 'pending'
      AND queue_enqueued_at IS NULL
      AND queue_attempt_count = ?
      ${staleCondition}
      AND EXISTS (
        SELECT 1 FROM meta_capi_secure_outbox
        WHERE delivery_id = analytics_conversion_deliveries.id
          AND schema_version = 2
      )
  `).bind(deliveryId, row.queue_attempt_count).run()
  if (!d1Changed(claimed)) return 'not_pending'

  const message: MetaCapiQueueMessage = {
    schemaVersion: 2,
    deliveryId,
    envelope: {
      keyId: row.key_id,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      expiresAt: row.expires_at,
    },
  }

  try {
    await env.META_CAPI_QUEUE.send(message)
  } catch {
    await markQueueSendFailed(env.DB, deliveryId)
    return 'failed'
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE analytics_conversion_deliveries
        SET
          queue_enqueued_at = datetime('now'),
          error_code = '',
          error_message = '',
          updated_at = datetime('now')
        WHERE id = ?
          AND channel = 'meta_capi'
          AND status = 'pending'
          AND queue_enqueued_at IS NULL
      `).bind(deliveryId),
      secureOutboxDeleteStatement(env.DB, deliveryId),
    ])
    return 'enqueued'
  } catch {
    return 'failed'
  }
}

export async function purgeExpiredMetaCapiOutbox(
  db: D1Database,
  limit = MAX_PURGE_LIMIT,
): Promise<{ purged: number; skipped: number }> {
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : MAX_PURGE_LIMIT
  const normalizedLimit = Math.min(MAX_PURGE_LIMIT, Math.max(0, requestedLimit))
  if (normalizedLimit === 0) return { purged: 0, skipped: 0 }

  const expired = await db.prepare(`
    SELECT
      o.delivery_id,
      d.status,
      d.skip_reason,
      d.error_code,
      a.date,
      d.event_name
    FROM meta_capi_secure_outbox o
    LEFT JOIN analytics_conversion_deliveries d ON d.id = o.delivery_id
    LEFT JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
    WHERE datetime(o.expires_at) <= datetime('now')
    ORDER BY o.expires_at ASC, o.delivery_id ASC
    LIMIT ?
  `).bind(normalizedLimit).all<ExpiredOutboxRow>()

  if (expired.results.length === 0) return { purged: 0, skipped: 0 }
  const skipped = await expireOutboxRows(db, expired.results)
  return { purged: expired.results.length, skipped }
}

export async function deleteSecureMetaCapiOutbox(db: D1Database, deliveryId: string) {
  await secureOutboxDeleteStatement(db, deliveryId).run()
}

function readSecureOutbox(db: D1Database, deliveryId: string) {
  return db.prepare(`
    SELECT
      o.delivery_id,
      o.schema_version,
      o.key_id,
      o.iv,
      o.ciphertext,
      o.tag,
      o.expires_at,
      d.status,
      d.skip_reason,
      d.error_code,
      d.queue_enqueued_at,
      d.queue_attempt_count,
      d.updated_at,
      a.date,
      d.event_name
    FROM meta_capi_secure_outbox o
    JOIN analytics_conversion_deliveries d ON d.id = o.delivery_id
    JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
    WHERE o.delivery_id = ?
      AND o.schema_version = 2
      AND d.channel = 'meta_capi'
    LIMIT 1
  `).bind(deliveryId).first<SecureOutboxRow>()
}

async function expireOutboxRows(db: D1Database, rows: ExpiredOutboxRow[]) {
  const statements: D1PreparedStatement[] = []
  const transitionIndexes: number[] = []
  for (const row of rows) {
    if (isNonTerminalDelivery(row.status, row.error_code)) {
      transitionIndexes.push(statements.length)
      statements.push(db.prepare(`
        UPDATE analytics_conversion_deliveries
        SET
          status = 'skipped',
          skip_reason = 'secure_context_expired',
          error_code = '',
          error_message = '',
          attempt_count = attempt_count + 1,
          last_attempt_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ?
          AND channel = 'meta_capi'
          AND status = ?
          AND skip_reason = ?
          AND error_code = ?
          AND status <> 'sent'
          AND (
            status IN ('pending', 'attempted')
            OR (
              status = 'failed'
              AND (
                error_code IN (
                  'meta_timeout',
                  'meta_network_error',
                  'meta_delivery_state_conflict',
                  'meta_http_429'
                )
                OR error_code GLOB 'meta_http_5[0-9][0-9]'
              )
            )
          )
      `).bind(row.delivery_id, row.status, row.skip_reason || '', row.error_code || ''))
      statements.push(db.prepare(`
        INSERT INTO analytics_conversion_delivery_daily (
          date, channel, event_name, status, skip_reason, delivery_count, updated_at
        )
        SELECT ?, 'meta_capi', ?, 'skipped', 'secure_context_expired', 1, datetime('now')
        WHERE changes() = 1
        ON CONFLICT(date, channel, event_name, status, skip_reason)
        DO UPDATE SET
          delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
          updated_at = datetime('now')
      `).bind(row.date, row.event_name))
      statements.push(db.prepare(`
        UPDATE analytics_conversion_delivery_daily
        SET
          delivery_count = MAX(delivery_count - 1, 0),
          updated_at = datetime('now')
        WHERE date = ?
          AND channel = 'meta_capi'
          AND event_name = ?
          AND status = ?
          AND skip_reason = ?
          AND changes() = 1
      `).bind(row.date, row.event_name, row.status, row.skip_reason || ''))
    }
    statements.push(secureOutboxDeleteStatement(db, row.delivery_id))
  }

  const results = await db.batch(statements)
  return transitionIndexes.reduce((count, index) => count + (d1Changed(results[index]!) ? 1 : 0), 0)
}

function secureOutboxDeleteStatement(db: D1Database, deliveryId: string) {
  return db.prepare('DELETE FROM meta_capi_secure_outbox WHERE delivery_id = ?').bind(deliveryId)
}

async function markQueueUnavailable(db: D1Database, deliveryId: string) {
  try {
    await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        error_code = 'missing_queue',
        error_message = '',
        updated_at = datetime('now')
      WHERE id = ?
        AND channel = 'meta_capi'
        AND status = 'pending'
        AND queue_enqueued_at IS NULL
    `).bind(deliveryId).run()
  } catch {
    // 诊断写入失败不能改变已提交业务事实。
  }
}

async function markQueueSendFailed(db: D1Database, deliveryId: string) {
  try {
    await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        error_code = 'queue_send_failed',
        error_message = 'Meta CAPI Queue 发送失败',
        updated_at = datetime('now')
      WHERE id = ?
        AND channel = 'meta_capi'
        AND status = 'pending'
        AND queue_enqueued_at IS NULL
    `).bind(deliveryId).run()
  } catch {
    // 外部 Queue 失败后的诊断补记不能改变已提交转化的响应。
  }
}

function isExpired(value: string) {
  const expiresAt = Date.parse(value)
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now()
}

function isNonTerminalDelivery(status: string, errorCode: string) {
  if (status === 'pending' || status === 'attempted') return true
  if (status !== 'failed') return false
  return errorCode === 'meta_timeout'
    || errorCode === 'meta_network_error'
    || errorCode === 'meta_delivery_state_conflict'
    || errorCode === 'meta_http_429'
    || /^meta_http_5\d\d$/.test(errorCode)
}

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 1) > 0
}
