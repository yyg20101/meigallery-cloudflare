import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import type { MetaCapiEncryptedEnvelope } from '../utils/meta-capi-crypto'
import { transitionDeliveryStatus } from './meta-capi'

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
      WHERE id = ? AND provider = 'meta' AND transport = 'server' AND status = 'pending'
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
      AND provider = 'meta'
      AND transport = 'server'
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
          AND provider = 'meta'
          AND transport = 'server'
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
  return expireOutboxRows(db, expired.results)
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
      AND d.provider = 'meta'
      AND d.transport = 'server'
    LIMIT 1
  `).bind(deliveryId).first<SecureOutboxRow>()
}

async function expireOutboxRows(db: D1Database, rows: ExpiredOutboxRow[]) {
  let purged = 0
  let skipped = 0
  for (const row of rows) {
    let canDeleteOutbox = !isNonTerminalDelivery(row.status, row.error_code)
    if (isNonTerminalDelivery(row.status, row.error_code)) {
      const transition = await transitionDeliveryStatus(db, {
        id: row.delivery_id,
        provider: 'meta',
        transport: 'server',
        event_name: row.event_name,
        status: row.status as never,
        skip_reason: row.skip_reason || '',
        error_code: row.error_code || '',
        date: row.date,
      }, {
        status: 'skipped',
        skipReason: 'secure_context_expired',
      })
      if (transition.changed) {
        skipped += 1
        canDeleteOutbox = true
      }
      else {
        const current = await readDeliveryTerminalState(db, row.delivery_id)
        canDeleteOutbox = !current || !isNonTerminalDelivery(current.status, current.error_code)
      }
    }
    if (canDeleteOutbox) {
      const deleted = await secureOutboxDeleteStatement(db, row.delivery_id).run()
      if (d1Changed(deleted)) purged += 1
    }
  }
  return { purged, skipped }
}

function readDeliveryTerminalState(db: D1Database, deliveryId: string) {
  return db.prepare(`
    SELECT status, error_code
    FROM analytics_conversion_deliveries
    WHERE id = ? AND provider = 'meta' AND transport = 'server'
    LIMIT 1
  `).bind(deliveryId).first<{ status: string; error_code: string }>()
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
        AND provider = 'meta'
        AND transport = 'server'
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
        AND provider = 'meta'
        AND transport = 'server'
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
