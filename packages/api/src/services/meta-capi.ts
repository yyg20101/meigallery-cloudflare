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

export type ConversionDeliverySnapshot = {
  id: string
  channel: string
  event_name: string
  status: ConversionDeliveryStatus
  skip_reason: string
  date: string
}

type MetaCapiDeliveryRow = ConversionDeliverySnapshot & {
  conversion_action_id: string
  external_event_id: string
  error_code: string
  error_message: string
  attempt_count: number
  occurred_at: string
  path: string
  metadata: string
}

export interface MetaCapiSendResult {
  deliveryId: string
  status: ConversionDeliveryStatus
  reason?: string
  eventsReceived?: number
  traceId?: string
}

export interface TransitionDeliveryStatusInput {
  status: ConversionDeliveryStatus
  skipReason?: string
  errorCode?: string
  errorMessage?: string
}

export class MetaCapiDeliveryError extends Error {
  readonly retryable: boolean
  readonly code: string

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'MetaCapiDeliveryError'
    this.code = code
    this.retryable = retryable
  }
}

const META_GRAPH_API_VERSION = 'v25.0'
const META_CAPI_TIMEOUT_MS = 8_000
const DELIVERY_TRANSITION_MAX_ATTEMPTS = 3
const META_CAPI_ERROR_MESSAGE = 'Meta CAPI 请求失败'
const META_CAPI_TIMEOUT_MESSAGE = 'Meta CAPI 请求超时'
const META_CAPI_STATE_ERROR_CODE = 'meta_delivery_state_conflict'
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
  options: {
    testEventCode?: string
    userData?: MetaCapiUserData
    fetchFn?: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<MetaCapiSendResult> {
  const delivery = await readMetaCapiDelivery(env.DB, deliveryId)
  if (!delivery) return { deliveryId, status: 'skipped', reason: 'delivery_not_found' }
  if (delivery.status === 'sent') {
    await recordDuplicateSuppressed(env.DB, delivery)
    return { deliveryId, status: 'duplicate_suppressed', reason: 'already_sent' }
  }
  if (delivery.status !== 'pending' && delivery.status !== 'failed') {
    return { deliveryId, status: delivery.status, reason: delivery.skip_reason || 'not_pending' }
  }

  const accessToken = String(env.META_CAPI_ACCESS_TOKEN || '').trim()
  if (!accessToken) {
    const persisted = await confirmDeliveryTransition(env.DB, delivery, { status: 'skipped', skipReason: 'missing_secret' })
    if (persisted.status === 'sent') return alreadySentResult(deliveryId)
    return { deliveryId, status: 'skipped', reason: 'missing_secret' }
  }

  const pixelId = await readPixelId(env.DB)
  if (!pixelId) {
    const persisted = await confirmDeliveryTransition(env.DB, delivery, { status: 'skipped', skipReason: 'missing_pixel_id' })
    if (persisted.status === 'sent') return alreadySentResult(deliveryId)
    return { deliveryId, status: 'skipped', reason: 'missing_pixel_id' }
  }

  const payload = buildMetaCapiPayload({
    eventName: delivery.event_name,
    eventId: delivery.external_event_id,
    eventTime: toUnixSeconds(delivery.occurred_at),
    eventSourceUrl: buildEventSourceUrl(env.SITE_URL, delivery.path),
    actionSource: 'website',
    userData: options.userData,
    customData: parseMetadata(delivery.metadata),
    testEventCode: options.testEventCode,
  })

  let response: Response
  let responseBody: Record<string, unknown>
  try {
    const metaResponse = await fetchWithCombinedTimeout(
      options.fetchFn ?? globalThis.fetch,
      metaCapiEndpoint(pixelId, accessToken),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      options.signal,
      options.timeoutMs ?? META_CAPI_TIMEOUT_MS,
    )
    response = metaResponse.response
    responseBody = metaResponse.body
  } catch (error) {
    const timedOut = error instanceof MetaCapiDeliveryError && error.code === 'meta_timeout'
    const code = timedOut ? 'meta_timeout' : 'meta_network_error'
    const persisted = await confirmDeliveryTransition(env.DB, delivery, {
      status: 'failed',
      errorCode: code,
      errorMessage: META_CAPI_ERROR_MESSAGE,
    })
    if (persisted.status === 'sent') return alreadySentResult(deliveryId)
    throw new MetaCapiDeliveryError(
      code,
      timedOut ? META_CAPI_TIMEOUT_MESSAGE : META_CAPI_ERROR_MESSAGE,
      true,
    )
  }

  const eventsReceived = readEventsReceived(responseBody)
  const traceId = readTraceId(responseBody, accessToken)
  if (response.ok && eventsReceived === 1) {
    await confirmDeliveryTransition(env.DB, delivery, { status: 'sent' })
    return compactResult({ deliveryId, status: 'sent', eventsReceived, traceId })
  }

  if (response.ok) {
    const persisted = await confirmDeliveryTransition(env.DB, delivery, {
      status: 'failed',
      errorCode: 'meta_events_not_received',
      errorMessage: META_CAPI_ERROR_MESSAGE,
    })
    if (persisted.status === 'sent') return alreadySentResult(deliveryId)
    return compactResult({
      deliveryId,
      status: 'failed',
      reason: 'events_not_received',
      eventsReceived,
      traceId,
    })
  }

  const errorCode = `meta_http_${response.status}`
  const persisted = await confirmDeliveryTransition(env.DB, delivery, {
    status: 'failed',
    errorCode,
    errorMessage: META_CAPI_ERROR_MESSAGE,
  })
  if (persisted.status === 'sent') return alreadySentResult(deliveryId)
  if (classifyMetaCapiError(response.status) === 'retryable') {
    throw new MetaCapiDeliveryError(errorCode, META_CAPI_ERROR_MESSAGE, true)
  }
  return compactResult({ deliveryId, status: 'failed', reason: String(response.status), traceId })
}

export async function createMetaCapiTestDelivery(
  db: D1Database,
  input: {
    conversionId: string
    deliveryId: string
    externalEventId: string
    occurredAt: string
    date: string
    adminId: number
  },
) {
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO analytics_conversion_actions (
          id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id,
          source_channel, source_name, method_type, action_target, route_name, path,
          metadata, duplicate_of
        )
        VALUES (?, 'contact', ?, ?, ?, 'meta_test_event', ?, 'internal', 'admin_attribution',
          'meta_test_event', 'admin_attribution', 'admin_attribution_meta', '/admin/attribution/meta',
          ?, '')
      `).bind(
        input.conversionId,
        `meta-test:${input.deliveryId}`,
        input.occurredAt,
        input.date,
        `meta_test_event:${input.adminId}`,
        JSON.stringify({ test_event: true, method_type: 'meta_test_event', location: 'admin_attribution' }),
      ),
      db.prepare(`
        INSERT INTO analytics_conversion_deliveries (
          id, conversion_action_id, channel, external_event_id, event_name,
          status, skip_reason, updated_at
        )
        VALUES (?, ?, 'meta_capi', ?, 'Contact', 'pending', '', datetime('now'))
      `).bind(input.deliveryId, input.conversionId, input.externalEventId),
      db.prepare(`
        INSERT INTO analytics_conversion_delivery_daily (
          date, channel, event_name, status, skip_reason, delivery_count, updated_at
        )
        VALUES (?, 'meta_capi', 'Contact', 'pending', '', 1, datetime('now'))
        ON CONFLICT(date, channel, event_name, status, skip_reason)
        DO UPDATE SET
          delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
          updated_at = datetime('now')
      `).bind(input.date),
    ])
  } catch {
    throw new Error('Meta CAPI Test Event 创建失败')
  }
}

export async function readMetaCapiDelivery(db: D1Database, deliveryId: string) {
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

export async function transitionDeliveryStatus(
  db: D1Database,
  delivery: ConversionDeliverySnapshot,
  input: TransitionDeliveryStatusInput,
) {
  const skipReason = input.skipReason ?? ''
  const errorCode = input.errorCode ?? ''
  const errorMessage = storedErrorMessage(input.errorMessage ?? '')
  if (delivery.status === 'sent') return { changed: false }

  if (delivery.status === input.status) {
    const result = await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        skip_reason = ?,
        error_code = ?,
        error_message = ?,
        attempt_count = attempt_count + 1,
        last_attempt_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ? AND status = ? AND status <> 'sent'
    `).bind(skipReason, errorCode, errorMessage, delivery.id, delivery.status).run()
    return { changed: d1Changed(result) }
  }

  const results = await db.batch([
    db.prepare(`
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
      WHERE id = ? AND status = ? AND status <> 'sent'
    `).bind(input.status, skipReason, errorCode, errorMessage, input.status, delivery.id, delivery.status),
    deliveryDailyIncrementAfterChange(db, delivery, input.status, skipReason),
    deliveryDailyDecrementAfterChange(db, delivery),
  ])
  return { changed: d1Changed(results[0]!) }
}

export async function confirmDeliveryTransition(
  db: D1Database,
  delivery: ConversionDeliverySnapshot,
  input: TransitionDeliveryStatusInput,
  options: { allowAnyNonSent?: boolean } = {},
): Promise<ConversionDeliverySnapshot> {
  let current = delivery
  for (let attempt = 0; attempt < DELIVERY_TRANSITION_MAX_ATTEMPTS; attempt += 1) {
    if (current.status === 'sent') return current
    if (!options.allowAnyNonSent && current.status !== 'pending' && current.status !== 'failed') {
      throw stateConflictError()
    }

    const transition = await transitionDeliveryStatus(db, current, input)
    if (transition.changed) {
      return {
        ...current,
        status: input.status,
        skip_reason: input.skipReason ?? '',
      }
    }

    const refreshed = await readMetaCapiDelivery(db, current.id)
    if (!refreshed) throw stateConflictError()
    current = refreshed
  }
  if (current.status === 'sent') return current
  throw stateConflictError()
}

export async function recordDuplicateSuppressed(db: D1Database, delivery: ConversionDeliverySnapshot) {
  await db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, channel, event_name, status, skip_reason, delivery_count, updated_at
    )
    VALUES (?, ?, ?, 'duplicate_suppressed', 'already_sent', 1, datetime('now'))
    ON CONFLICT(date, channel, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(delivery.date, delivery.channel, delivery.event_name).run()
}

function deliveryDailyIncrementAfterChange(
  db: D1Database,
  delivery: ConversionDeliverySnapshot,
  status: ConversionDeliveryStatus,
  skipReason: string,
) {
  return db.prepare(`
    INSERT INTO analytics_conversion_delivery_daily (
      date, channel, event_name, status, skip_reason, delivery_count, updated_at
    )
    SELECT ?, ?, ?, ?, ?, 1, datetime('now')
    WHERE changes() = 1
    ON CONFLICT(date, channel, event_name, status, skip_reason)
    DO UPDATE SET
      delivery_count = analytics_conversion_delivery_daily.delivery_count + 1,
      updated_at = datetime('now')
  `).bind(delivery.date, delivery.channel, delivery.event_name, status, skipReason)
}

function deliveryDailyDecrementAfterChange(db: D1Database, delivery: ConversionDeliverySnapshot) {
  return db.prepare(`
    UPDATE analytics_conversion_delivery_daily
    SET
      delivery_count = MAX(delivery_count - 1, 0),
      updated_at = datetime('now')
    WHERE date = ?
      AND channel = ?
      AND event_name = ?
      AND status = ?
      AND skip_reason = ?
      AND changes() = 1
  `).bind(delivery.date, delivery.channel, delivery.event_name, delivery.status, delivery.skip_reason || '')
}

async function readPixelId(db: D1Database) {
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'facebook_pixel_id' LIMIT 1").first<{ value: string }>()
  const value = parseStoredSettingValue(row ? row.value : '', '')
  return String(value || '').trim()
}

async function fetchWithCombinedTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, timeoutMs))

  try {
    const response = await fetchFn(input, { ...init, signal: controller.signal })
    let body: Record<string, unknown> = {}
    try {
      const text = await response.text()
      const parsed = JSON.parse(text || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch (error) {
      if (timedOut) throw new MetaCapiDeliveryError('meta_timeout', META_CAPI_TIMEOUT_MESSAGE, true)
      if (!(error instanceof SyntaxError)) {
        throw new MetaCapiDeliveryError('meta_network_error', META_CAPI_ERROR_MESSAGE, true)
      }
    }
    return { response, body }
  } catch {
    if (timedOut) throw new MetaCapiDeliveryError('meta_timeout', META_CAPI_TIMEOUT_MESSAGE, true)
    throw new MetaCapiDeliveryError('meta_network_error', META_CAPI_ERROR_MESSAGE, true)
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

function readEventsReceived(body: Record<string, unknown>) {
  return typeof body.events_received === 'number' && Number.isFinite(body.events_received)
    ? body.events_received
    : undefined
}

function readTraceId(body: Record<string, unknown>, accessToken: string) {
  const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : {}
  const value = typeof body.fbtrace_id === 'string' ? body.fbtrace_id : error.fbtrace_id
  if (typeof value !== 'string') return undefined
  const traceId = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
  if (accessToken && traceId.includes(accessToken)) return undefined
  return traceId || undefined
}

function compactResult(result: MetaCapiSendResult) {
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as unknown as MetaCapiSendResult
}

function alreadySentResult(deliveryId: string): MetaCapiSendResult {
  return { deliveryId, status: 'sent', reason: 'already_sent' }
}

function stateConflictError() {
  return new MetaCapiDeliveryError(META_CAPI_STATE_ERROR_CODE, META_CAPI_ERROR_MESSAGE, true)
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

function storedErrorMessage(value: string) {
  return value === META_CAPI_ERROR_MESSAGE || value === 'Meta CAPI Queue 发送失败' ? value : ''
}

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 1) > 0
}
