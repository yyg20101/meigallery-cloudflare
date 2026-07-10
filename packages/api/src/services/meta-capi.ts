import type { ConversionDeliveryStatus, MetaCapiUserData } from '@meigallery/shared'
import { ATTRIBUTION_LIMITS } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import { normalizeMetaCapiUserData } from '../utils/meta-browser-identifiers'
import { parseStoredSettingValue } from '../utils/stored-setting-value'

type MetaCapiEnv = Pick<Bindings, 'DB' | 'SITE_URL' | 'APP_ENV' | 'META_CAPI_ACCESS_TOKEN' | 'META_CAPI_TEST_EVENT_CODE'>

type MetaCapiPayloadInput = {
  eventName: string
  eventId: string
  eventTime: number
  eventSourceUrl: string
  actionSource: 'website'
  userData?: MetaCapiUserData
  customData?: Record<string, unknown>
  testEventCode?: string
}

type MetaCapiDeliveryRow = {
  id: string
  conversion_action_id: string
  channel: string
  external_event_id: string
  event_name: string
  status: ConversionDeliveryStatus
  skip_reason: string
  error_code: string
  error_message: string
  attempt_count: number
  occurred_at: string
  date: string
  path: string
  metadata: string
}

export interface MetaCapiSendResult {
  deliveryId: string
  status: ConversionDeliveryStatus
  reason?: string
}

const META_GRAPH_API_VERSION = 'v25.0'
const CUSTOM_DATA_ALLOWLIST = new Set([
  'method_type',
  'action_type',
  'location',
  'content_name',
  'content_category',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
])

export function buildMetaCapiPayload(input: MetaCapiPayloadInput) {
  const userData = normalizeMetaCapiUserData(input.userData)
  const event: Record<string, unknown> = {
    event_name: input.eventName,
    event_time: input.eventTime,
    event_id: input.eventId,
    event_source_url: input.eventSourceUrl,
    action_source: input.actionSource,
    user_data: compactObject({
      fbp: userData.fbp,
      fbc: userData.fbc,
      client_ip_address: userData.clientIpAddress,
      client_user_agent: userData.clientUserAgent,
    }),
    custom_data: sanitizeCustomData(input.customData || {}),
  }
  const payload: Record<string, unknown> = { data: [event] }
  if (input.testEventCode) payload.test_event_code = input.testEventCode
  return payload
}

export function classifyMetaCapiError(status: number): 'retryable' | 'permanent' {
  if (status === 429 || status >= 500) return 'retryable'
  return 'permanent'
}

export async function sendMetaCapiEvent(
  env: MetaCapiEnv,
  deliveryId: string,
  options: { testEventCode?: string; userData?: MetaCapiUserData } = {},
): Promise<MetaCapiSendResult> {
  const delivery = await readDelivery(env.DB, deliveryId)
  if (!delivery) return { deliveryId, status: 'skipped', reason: 'delivery_not_found' }
  if (delivery.status === 'sent') {
    return { deliveryId, status: 'duplicate_suppressed', reason: 'already_sent' }
  }
  if (delivery.status !== 'pending' && delivery.status !== 'failed') {
    return { deliveryId, status: delivery.status, reason: delivery.skip_reason || 'not_pending' }
  }

  const accessToken = String(env.META_CAPI_ACCESS_TOKEN || '').trim()
  if (!accessToken) {
    await markDelivery(env.DB, delivery, 'skipped', 'missing_secret')
    return { deliveryId, status: 'skipped', reason: 'missing_secret' }
  }

  const pixelId = await readPixelId(env.DB)
  if (!pixelId) {
    await markDelivery(env.DB, delivery, 'skipped', 'missing_pixel_id')
    return { deliveryId, status: 'skipped', reason: 'missing_pixel_id' }
  }

  const metadata = parseMetadata(delivery.metadata)
  const payload = buildMetaCapiPayload({
    eventName: delivery.event_name,
    eventId: delivery.external_event_id,
    eventTime: toUnixSeconds(delivery.occurred_at),
    eventSourceUrl: buildEventSourceUrl(env.SITE_URL, delivery.path),
    actionSource: 'website',
    userData: options.userData,
    customData: metadata,
    testEventCode: options.testEventCode,
  })

  const response = await fetch(metaCapiEndpoint(pixelId, accessToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (response.ok) {
    await markDelivery(env.DB, delivery, 'sent')
    return { deliveryId, status: 'sent' }
  }

  const errorMessage = await safeResponseText(response)
  const retryType = classifyMetaCapiError(response.status)
  await markDelivery(env.DB, delivery, 'failed', '', String(response.status), errorMessage)
  if (retryType === 'retryable') {
    throw new Error(`Meta CAPI retryable ${response.status}`)
  }
  return { deliveryId, status: 'failed', reason: String(response.status) }
}

async function readDelivery(db: D1Database, deliveryId: string) {
  return db.prepare(`
    SELECT
      d.id, d.conversion_action_id, d.channel, d.external_event_id, d.event_name,
      d.status, d.skip_reason, d.error_code, d.error_message, d.attempt_count,
      a.occurred_at, a.date, a.path, a.metadata
    FROM analytics_conversion_deliveries d
    JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
    WHERE d.id = ?
      AND d.channel = 'meta_capi'
    LIMIT 1
  `).bind(deliveryId).first<MetaCapiDeliveryRow>()
}

async function readPixelId(db: D1Database) {
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'facebook_pixel_id' LIMIT 1").first<{ value: string }>()
  const value = parseStoredSettingValue(row ? row.value : '', '')
  return String(value || '').trim()
}

async function markDelivery(
  db: D1Database,
  delivery: MetaCapiDeliveryRow,
  status: ConversionDeliveryStatus,
  skipReason = '',
  errorCode = '',
  errorMessage = '',
) {
  await db.prepare(`
    UPDATE analytics_conversion_deliveries
    SET
      status = ?,
      skip_reason = ?,
      error_code = ?,
      error_message = ?,
      attempt_count = attempt_count + 1,
      last_attempt_at = datetime('now'),
      sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    status,
    skipReason,
    errorCode,
    truncateError(errorMessage),
    status,
    delivery.id,
  ).run()
  await upsertDeliveryDaily(db, {
    date: delivery.date,
    channel: delivery.channel,
    eventName: delivery.event_name,
    status,
    skipReason,
  })
}

async function upsertDeliveryDaily(
  db: D1Database,
  input: { date: string; channel: string; eventName: string; status: ConversionDeliveryStatus; skipReason: string },
) {
  await db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, channel, event_name, status, skip_reason, delivery_count, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(date, channel, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(
    input.date,
    input.channel,
    input.eventName,
    input.status,
    input.skipReason,
  ).run()
}

function sanitizeCustomData(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!CUSTOM_DATA_ALLOWLIST.has(key)) continue
    if (typeof value === 'string') {
      const text = value.replace(/\s+/g, ' ').trim().slice(0, ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH)
      if (text) output[key] = text
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value
    } else if (typeof value === 'boolean') {
      output[key] = value
    }
  }
  return output
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ''))
}

function parseMetadata(value: string) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toUnixSeconds(value: string) {
  const timestamp = new Date(value).getTime()
  return Math.floor((Number.isFinite(timestamp) ? timestamp : Date.now()) / 1000)
}

function buildEventSourceUrl(siteUrl: string | undefined, path: string) {
  const base = String(siteUrl || 'https://616618.xyz').trim() || 'https://616618.xyz'
  try {
    const baseUrl = new URL(base)
    const url = new URL(path || '/', baseUrl)
    if (url.origin !== baseUrl.origin) return `${baseUrl.origin}/`
    return `${baseUrl.origin}${url.pathname}`
  } catch {
    return base
  }
}

function metaCapiEndpoint(pixelId: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events`)
  url.searchParams.set('access_token', accessToken)
  return url.toString()
}

async function safeResponseText(response: Response) {
  try {
    return truncateError(await response.text())
  } catch {
    return ''
  }
}

function truncateError(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, ATTRIBUTION_LIMITS.DELIVERY_ERROR_MAX_LENGTH)
}
