import type {
  AdPlatformConversionEventName,
  ConversionDeliveryStatus,
} from '@meigallery/shared'
import { ACTIVE_AD_PLATFORM_CONVERSION_EVENTS, ATTRIBUTION_LIMITS } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import { normalizeAdPlatformUserData } from '../utils/ad-platform-identifiers'
import type { MetaCapiSensitiveContext } from '../utils/meta-capi-crypto'
import { requireVerifiedMetaConnection } from './meta-connection'
import { metaEventsEndpoint, metaGraphRequestInit, readMetaEventsResponse } from './meta-graph'
import {
  createMetaIncidentTrigger,
  openMetaCapiIncidentSafely,
} from './meta-capi-circuit-breaker'
import {
  acquireAdPlatformDeliveryLease,
  readAdPlatformServerDelivery,
  recordDuplicateSuppressed,
  releaseAdPlatformDeliveryLease,
  transitionDeliveryStatus,
  type AdPlatformServerDeliveryRow,
  type ConversionDeliverySnapshot,
  type TransitionDeliveryStatusInput,
} from './ad-platform/delivery-store'

type MetaCapiEnv = Pick<
  Bindings,
  'DB' | 'SITE_URL' | 'APP_ENV' | 'META_CAPI_ACCESS_TOKEN' | 'RELEASE_COMMIT'
>

export type MetaCapiPayloadInput = {
  eventName: AdPlatformConversionEventName
  eventId: string
  eventTime: number
  eventSourceUrl: string
  actionSource: 'website'
  userData?: MetaCapiSensitiveContext
  customData?: Record<string, unknown>
}

export type MetaCapiDeliveryRow = AdPlatformServerDeliveryRow

export interface MetaCapiSendResult {
  deliveryId: string
  status: ConversionDeliveryStatus
  reason?: string
  eventsReceived?: number
}

export type ConfirmedDeliveryTransition = ConversionDeliverySnapshot & {
  transitionChanged: boolean
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

const META_CAPI_TIMEOUT_MS = 8_000
const DELIVERY_TRANSITION_MAX_ATTEMPTS = 3
const META_CAPI_ERROR_MESSAGE = 'Meta CAPI 请求失败'
const META_CAPI_TIMEOUT_MESSAGE = 'Meta CAPI 请求超时'
const META_CAPI_STATE_ERROR_CODE = 'meta_delivery_state_conflict'
const ACTIVE_META_EVENT_NAMES = new Set<string>(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS)
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
  const userData = normalizeAdPlatformUserData(input.userData)
  const enhancedMatching = input.eventName === 'CompleteRegistration'
    ? {
        em: validSha256(input.userData?.emailSha256) ? [input.userData!.emailSha256!] : undefined,
        external_id: validSha256(input.userData?.externalIdSha256) ? [input.userData!.externalIdSha256!] : undefined,
      }
    : {}
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
      ...enhancedMatching,
    }),
    custom_data: sanitizeCustomData(input.customData || {}),
  }
  const payload: Record<string, unknown> = { data: [event] }
  return payload
}

export function classifyMetaCapiError(status: number): 'retryable' | 'permanent' {
  if (status === 429 || status >= 500) return 'retryable'
  return 'permanent'
}

export function isRetryableMetaCapiErrorCode(errorCode: string) {
  return errorCode === 'meta_timeout'
    || errorCode === 'meta_network_error'
    || errorCode === 'meta_delivery_state_conflict'
    || errorCode === 'meta_http_429'
    || /^meta_http_5\d\d$/.test(errorCode)
}

export async function sendMetaCapiEvent(
  env: MetaCapiEnv,
  deliveryId: string,
  options: {
    userData?: MetaCapiSensitiveContext
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
  if (delivery.status === 'failed' && !isRetryableMetaCapiErrorCode(delivery.error_code)) {
    return { deliveryId, status: 'failed', reason: delivery.error_code || 'not_pending' }
  }
  if (!isActiveMetaEventName(delivery.event_name)) {
    const persisted = await confirmDeliveryTransition(env.DB, delivery, {
      status: 'skipped',
      skipReason: 'unsupported_event',
    })
    const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
    if (competingSent) return competingSent
    return { deliveryId, status: 'skipped', reason: 'unsupported_event' }
  }

  let connection: Awaited<ReturnType<typeof requireVerifiedMetaConnection>>
  try {
    connection = await requireVerifiedMetaConnection(env)
  }
  catch {
    const persisted = await confirmDeliveryTransition(env.DB, delivery, {
      status: 'skipped',
      skipReason: 'connection_unverified',
    })
    const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
    if (competingSent) return competingSent
    return { deliveryId, status: 'skipped', reason: 'connection_unverified' }
  }
  if (delivery.tracking_mode !== connection.trackingMode
    || delivery.connection_revision !== connection.revision) {
    const persisted = await confirmDeliveryTransition(env.DB, delivery, {
      status: 'skipped',
      skipReason: 'connection_unverified',
    })
    const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
    if (competingSent) return competingSent
    return { deliveryId, status: 'skipped', reason: 'connection_unverified' }
  }
  const accessToken = String(env.META_CAPI_ACCESS_TOKEN || '').trim()

  const leaseToken = await acquireMetaCapiDeliveryLease(env.DB, deliveryId)
  if (!leaseToken) {
    const current = await readMetaCapiDelivery(env.DB, deliveryId)
    if (current?.status === 'sent') {
      await recordDuplicateSuppressed(env.DB, current)
      return { deliveryId, status: 'duplicate_suppressed', reason: 'already_sent' }
    }
    return {
      deliveryId,
      status: current?.status ?? delivery.status,
      reason: 'delivery_lease_active',
    }
  }

  try {
    const payload = buildMetaCapiPayload({
      eventName: delivery.event_name,
      eventId: delivery.external_event_id,
      eventTime: toUnixSeconds(delivery.occurred_at),
      eventSourceUrl: buildEventSourceUrl(env.SITE_URL, delivery.path),
      actionSource: 'website',
      userData: options.userData,
      customData: parseMetadata(delivery.metadata),
    })

    let response: Response
    let eventsReceived: number | undefined
    try {
      const metaResponse = await fetchWithCombinedTimeout(
        options.fetchFn ?? globalThis.fetch,
        metaEventsEndpoint(connection.pixelId),
        metaGraphRequestInit(accessToken, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        options.signal,
        options.timeoutMs ?? META_CAPI_TIMEOUT_MS,
        [
          accessToken,
          ...Object.values(options.userData || {}).filter((value): value is string => typeof value === 'string'),
        ],
      )
      response = metaResponse.response
      eventsReceived = metaResponse.eventsReceived
    } catch (error) {
      const timedOut = error instanceof MetaCapiDeliveryError && error.code === 'meta_timeout'
      const code = timedOut ? 'meta_timeout' : 'meta_network_error'
      const persisted = await confirmDeliveryTransition(env.DB, delivery, {
        status: 'failed',
        errorCode: code,
        errorMessage: META_CAPI_ERROR_MESSAGE,
      }, leaseToken)
      const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
      if (competingSent) return competingSent
      throw new MetaCapiDeliveryError(
        code,
        timedOut ? META_CAPI_TIMEOUT_MESSAGE : META_CAPI_ERROR_MESSAGE,
        true,
      )
    }

    if (response.ok && eventsReceived === 1) {
      const persisted = await confirmDeliveryTransition(env.DB, delivery, { status: 'sent' }, leaseToken)
      const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
      if (competingSent) return competingSent
      return compactResult({ deliveryId, status: 'sent', eventsReceived })
    }

    if (response.ok) {
      const persisted = await confirmDeliveryTransition(env.DB, delivery, {
        status: 'failed',
        errorCode: 'meta_events_not_received',
        errorMessage: META_CAPI_ERROR_MESSAGE,
      }, leaseToken)
      const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
      if (competingSent) return competingSent
      return compactResult({
        deliveryId,
        status: 'failed',
        reason: 'events_not_received',
        eventsReceived,
      })
    }

    const errorCode = `meta_http_${response.status}`
    if (response.status === 401 || response.status === 403) {
      await openMetaCapiIncidentSafely(env, createMetaIncidentTrigger('meta_permission_denied', {
        failedCount: 1,
      }))
    }
    const persisted = await confirmDeliveryTransition(env.DB, delivery, {
      status: 'failed',
      errorCode,
      errorMessage: META_CAPI_ERROR_MESSAGE,
    }, leaseToken)
    const competingSent = await recordCompetingSent(env.DB, persisted, deliveryId)
    if (competingSent) return competingSent
    if (classifyMetaCapiError(response.status) === 'retryable') {
      throw new MetaCapiDeliveryError(errorCode, META_CAPI_ERROR_MESSAGE, true)
    }
    return compactResult({ deliveryId, status: 'failed', reason: String(response.status) })
  }
  finally {
    await releaseMetaCapiDeliveryLease(env.DB, deliveryId, leaseToken)
  }
}

export async function acquireMetaCapiDeliveryLease(db: D1Database, deliveryId: string) {
  return acquireAdPlatformDeliveryLease(db, 'meta', deliveryId)
}

export async function releaseMetaCapiDeliveryLease(
  db: D1Database,
  deliveryId: string,
  leaseToken: string,
) {
  await releaseAdPlatformDeliveryLease(db, 'meta', deliveryId, leaseToken)
}

function isActiveMetaEventName(value: string): value is AdPlatformConversionEventName {
  return ACTIVE_META_EVENT_NAMES.has(value)
}

export async function readMetaCapiDelivery(db: D1Database, deliveryId: string) {
  return readAdPlatformServerDelivery(db, 'meta', deliveryId)
}

export async function confirmDeliveryTransition(
  db: D1Database,
  delivery: ConversionDeliverySnapshot,
  input: TransitionDeliveryStatusInput,
  leaseToken?: string,
): Promise<ConfirmedDeliveryTransition> {
  let current = delivery
  for (let attempt = 0; attempt < DELIVERY_TRANSITION_MAX_ATTEMPTS; attempt += 1) {
    if (current.status === 'sent') return { ...current, transitionChanged: false }
    if (current.status !== 'pending'
      && (current.status !== 'failed' || !isRetryableMetaCapiErrorCode(current.error_code ?? ''))) {
      throw stateConflictError()
    }

    const transition = await transitionDeliveryStatus(db, current, input, leaseToken)
    if (transition.changed) {
      return {
        ...current,
        status: input.status,
        skip_reason: input.skipReason ?? '',
        transitionChanged: true,
      }
    }

    const refreshed = await readMetaCapiDelivery(db, current.id)
    if (!refreshed) throw stateConflictError()
    current = refreshed
  }
  if (current.status === 'sent') return { ...current, transitionChanged: false }
  throw stateConflictError()
}

async function fetchWithCombinedTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  sensitiveValues: readonly string[],
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
    const { eventsReceived } = await readMetaEventsResponse(response, sensitiveValues)
    return { response, eventsReceived }
  } catch {
    if (timedOut) throw new MetaCapiDeliveryError('meta_timeout', META_CAPI_TIMEOUT_MESSAGE, true)
    throw new MetaCapiDeliveryError('meta_network_error', META_CAPI_ERROR_MESSAGE, true)
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

function compactResult(result: MetaCapiSendResult) {
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as unknown as MetaCapiSendResult
}

function alreadySentResult(deliveryId: string): MetaCapiSendResult {
  return { deliveryId, status: 'sent', reason: 'already_sent' }
}

async function recordCompetingSent(
  db: D1Database,
  delivery: ConfirmedDeliveryTransition,
  deliveryId: string,
) {
  if (delivery.status !== 'sent' || delivery.transitionChanged) return undefined
  await recordDuplicateSuppressed(db, delivery)
  return alreadySentResult(deliveryId)
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

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
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
  const base = String(siteUrl || '').trim()
  if (!base) return ''
  try {
    const baseUrl = new URL(base)
    const url = new URL(path || '/', baseUrl)
    if (url.origin !== baseUrl.origin) return `${baseUrl.origin}/`
    return `${baseUrl.origin}${url.pathname}`
  } catch {
    return base
  }
}
