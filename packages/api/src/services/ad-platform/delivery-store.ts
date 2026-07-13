import type {
  AdPlatformProvider,
  AdPlatformTrackingMode,
  ConversionDeliveryStatus,
} from '@meigallery/shared'

const DELIVERY_LEASE_SECONDS = 60
const STORED_ERROR_MESSAGES = new Set([
  'Meta CAPI 请求失败',
  'Meta CAPI Queue 发送失败',
  'TikTok Events API 请求失败',
  'TikTok Events Queue 发送失败',
])

export type ConversionDeliverySnapshot = {
  id: string
  provider: string
  transport: string
  event_name: string
  status: ConversionDeliveryStatus
  skip_reason: string
  error_code?: string
  date: string
}

export type AdPlatformServerDeliveryRow = ConversionDeliverySnapshot & {
  conversion_action_id: string
  external_event_id: string
  error_code: string
  error_message: string
  attempt_count: number
  tracking_mode: AdPlatformTrackingMode
  connection_revision: string | null
  duplicate_suppressed_at: string | null
  encryption_key_id: string
  delivery_lease_token: string
  delivery_lease_expires_at: string | null
  created_at: string
  occurred_at: string
  path: string
  metadata: string
}

export interface TransitionDeliveryStatusInput {
  status: ConversionDeliveryStatus
  skipReason?: string
  errorCode?: string
  errorMessage?: string
}

export async function readAdPlatformServerDelivery(
  db: D1Database,
  provider: AdPlatformProvider,
  deliveryId: string,
) {
  return db.prepare(`
    SELECT
      d.id, d.conversion_action_id, d.provider, d.transport, d.external_event_id, d.event_name,
      d.status, d.skip_reason, d.error_code, d.error_message, d.attempt_count,
      d.tracking_mode, d.connection_revision, d.duplicate_suppressed_at,
      d.encryption_key_id, d.delivery_lease_token, d.delivery_lease_expires_at, d.created_at,
      a.occurred_at, a.date, a.path, a.metadata
    FROM analytics_conversion_deliveries d
    JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
    WHERE d.id = ? AND d.provider = ? AND d.transport = 'server'
    LIMIT 1
  `).bind(deliveryId, provider).first<AdPlatformServerDeliveryRow>()
}

export async function acquireAdPlatformDeliveryLease(
  db: D1Database,
  provider: AdPlatformProvider,
  deliveryId: string,
) {
  const leaseToken = randomLeaseToken()
  const result = await db.prepare(`
    UPDATE analytics_conversion_deliveries
    SET
      delivery_lease_token = ?,
      delivery_lease_expires_at = datetime('now', '+${DELIVERY_LEASE_SECONDS} seconds'),
      updated_at = datetime('now')
    WHERE id = ?
      AND provider = ?
      AND transport = 'server'
      AND status IN ('pending', 'failed')
      AND status <> 'sent'
      AND (
        delivery_lease_token = ''
        OR delivery_lease_expires_at IS NULL
        OR delivery_lease_expires_at <= datetime('now')
      )
  `).bind(leaseToken, deliveryId, provider).run()
  return d1Changed(result) ? leaseToken : null
}

export async function releaseAdPlatformDeliveryLease(
  db: D1Database,
  provider: AdPlatformProvider,
  deliveryId: string,
  leaseToken: string,
) {
  await db.prepare(`
    UPDATE analytics_conversion_deliveries
    SET delivery_lease_token = '', delivery_lease_expires_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND provider = ? AND delivery_lease_token = ?
  `).bind(deliveryId, provider, leaseToken).run()
}

export async function transitionDeliveryStatus(
  db: D1Database,
  delivery: ConversionDeliverySnapshot,
  input: TransitionDeliveryStatusInput,
  leaseToken?: string,
) {
  const skipReason = input.skipReason ?? ''
  const errorCode = input.errorCode ?? ''
  const errorMessage = sanitizeStoredErrorMessage(input.errorMessage ?? '')
  const expectedErrorCode = delivery.error_code ?? ''
  if (delivery.status === 'sent') return { changed: false }

  if (delivery.status === input.status) {
    const result = await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        skip_reason = ?, error_code = ?, error_message = ?,
        attempt_count = attempt_count + 1,
        last_attempt_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = ? AND skip_reason = ? AND error_code = ? AND status <> 'sent'
        ${deliveryTransitionLeaseFence({ leaseToken })}
    `).bind(
      skipReason,
      errorCode,
      errorMessage,
      delivery.id,
      delivery.status,
      delivery.skip_reason || '',
      expectedErrorCode,
      ...(leaseToken ? [leaseToken] : []),
    ).run()
    return { changed: d1Changed(result) }
  }

  const results = await db.batch([
    db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        status = ?, skip_reason = ?, error_code = ?, error_message = ?,
        attempt_count = attempt_count + 1,
        last_attempt_at = datetime('now'),
        sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END,
        updated_at = datetime('now')
      WHERE id = ? AND status = ? AND skip_reason = ? AND error_code = ? AND status <> 'sent'
        ${deliveryTransitionLeaseFence({ leaseToken })}
    `).bind(
      input.status,
      skipReason,
      errorCode,
      errorMessage,
      input.status,
      delivery.id,
      delivery.status,
      delivery.skip_reason || '',
      expectedErrorCode,
      ...(leaseToken ? [leaseToken] : []),
    ),
    deliveryDailyIncrementAfterChange(db, delivery, input.status, skipReason),
    deliveryDailyDecrementAfterChange(db, delivery),
  ])
  return { changed: d1Changed(results[0]!) }
}

export async function recordDuplicateSuppressed(db: D1Database, delivery: ConversionDeliverySnapshot) {
  await db.batch([
    db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET duplicate_suppressed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'sent' AND duplicate_suppressed_at IS NULL
    `).bind(delivery.id),
    db.prepare(`
      INSERT INTO analytics_conversion_delivery_daily (
        date, provider, transport, event_name, status, skip_reason, delivery_count, updated_at
      )
      SELECT ?, ?, ?, ?, 'duplicate_suppressed', 'already_sent', 1, datetime('now')
      WHERE changes() = 1
      ON CONFLICT(date, provider, transport, event_name, status, skip_reason)
      DO UPDATE SET
        delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
        updated_at = datetime('now')
    `).bind(delivery.date, delivery.provider, delivery.transport, delivery.event_name),
  ])
}

function deliveryTransitionLeaseFence({ leaseToken }: { leaseToken?: string }) {
  if (leaseToken) return 'AND delivery_lease_token = ?'
  return `AND (
    delivery_lease_token = ''
    OR delivery_lease_expires_at IS NULL
    OR delivery_lease_expires_at <= datetime('now')
  )`
}

function deliveryDailyIncrementAfterChange(
  db: D1Database,
  delivery: ConversionDeliverySnapshot,
  status: ConversionDeliveryStatus,
  skipReason: string,
) {
  return db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, provider, transport, event_name, status, skip_reason, delivery_count, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, 1, datetime('now')
    WHERE changes() = 1
    ON CONFLICT(date, provider, transport, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(delivery.date, delivery.provider, delivery.transport, delivery.event_name, status, skipReason)
}

function deliveryDailyDecrementAfterChange(db: D1Database, delivery: ConversionDeliverySnapshot) {
  return db.prepare(`
    UPDATE analytics_conversion_delivery_daily
    SET delivery_count = MAX(delivery_count - 1, 0), updated_at = datetime('now')
    WHERE date = ? AND provider = ? AND transport = ? AND event_name = ?
      AND status = ? AND skip_reason = ? AND changes() = 1
  `).bind(
    delivery.date,
    delivery.provider,
    delivery.transport,
    delivery.event_name,
    delivery.status,
    delivery.skip_reason || '',
  )
}

function sanitizeStoredErrorMessage(value: string) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return STORED_ERROR_MESSAGES.has(normalized) ? normalized : ''
}

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 1) > 0
}

function randomLeaseToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}
