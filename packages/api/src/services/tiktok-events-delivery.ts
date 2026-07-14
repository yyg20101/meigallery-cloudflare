import type {
  AdPlatformConversionEventName,
  AdPlatformSensitiveContext,
  ConversionDeliveryStatus,
} from '@meigallery/shared'
import { ACTIVE_AD_PLATFORM_CONVERSION_EVENTS } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import {
  acquireAdPlatformDeliveryLease,
  readAdPlatformServerDelivery,
  recordDuplicateSuppressed,
  releaseAdPlatformDeliveryLease,
  transitionDeliveryStatus,
  type AdPlatformServerDeliveryRow,
  type TransitionDeliveryStatusInput,
} from './ad-platform/delivery-store'
import { isRetryableAdPlatformDeliveryErrorCode } from './ad-platform/delivery-errors'
import { requireVerifiedTikTokConnection } from './tiktok-connection'
import {
  buildTikTokEventsPayload,
  isRetryableTikTokEventsError,
  isTikTokCredentialError,
  isTikTokEventsSuccess,
  readTikTokEventsResponse,
  TIKTOK_EVENTS_API_ENDPOINT,
  tiktokEventsRequestInit,
} from './tiktok-events'

const DELIVERY_TIMEOUT_MS = 8_000
const TRANSITION_MAX_ATTEMPTS = 3
const TIKTOK_ERROR_MESSAGE = 'TikTok Events API 请求失败'
const ACTIVE_EVENT_NAMES = new Set<string>(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS)

type TikTokEventsEnv = Pick<
  Bindings,
  'DB' | 'SITE_URL' | 'APP_ENV' | 'TIKTOK_EVENTS_ACCESS_TOKEN'
>

export interface TikTokEventsSendResult {
  deliveryId: string
  status: ConversionDeliveryStatus
  reason?: string
  requestId?: string
}

export class TikTokEventsDeliveryError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, retryable: boolean) {
    super(TIKTOK_ERROR_MESSAGE)
    this.name = 'TikTokEventsDeliveryError'
    this.code = code
    this.retryable = retryable
  }
}

export async function sendTikTokEventsDelivery(
  env: TikTokEventsEnv,
  deliveryId: string,
  options: {
    userData?: AdPlatformSensitiveContext
    fetchFn?: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<TikTokEventsSendResult> {
  const delivery = await readAdPlatformServerDelivery(env.DB, 'tiktok', deliveryId)
  if (!delivery) return { deliveryId, status: 'skipped', reason: 'delivery_not_found' }
  if (delivery.status === 'sent') {
    await recordDuplicateSuppressed(env.DB, delivery)
    return { deliveryId, status: 'duplicate_suppressed', reason: 'already_sent' }
  }
  if (delivery.status !== 'pending' && delivery.status !== 'failed') {
    return { deliveryId, status: delivery.status, reason: delivery.skip_reason || 'not_pending' }
  }
  if (delivery.status === 'failed' && !isRetryableAdPlatformDeliveryErrorCode(delivery.error_code)) {
    return { deliveryId, status: 'failed', reason: delivery.error_code || 'not_pending' }
  }
  if (!isActiveEventName(delivery.event_name)) {
    return persistTerminalResult(env.DB, delivery, {
      status: 'skipped',
      skipReason: 'unsupported_event',
    })
  }

  let connection: Awaited<ReturnType<typeof requireVerifiedTikTokConnection>>
  try {
    connection = await requireVerifiedTikTokConnection(env)
  }
  catch {
    return persistTerminalResult(env.DB, delivery, {
      status: 'skipped',
      skipReason: 'connection_unverified',
    })
  }
  if (delivery.tracking_mode !== connection.trackingMode
    || delivery.connection_revision !== connection.revision) {
    return persistTerminalResult(env.DB, delivery, {
      status: 'skipped',
      skipReason: 'connection_unverified',
    })
  }

  const leaseToken = await acquireAdPlatformDeliveryLease(env.DB, 'tiktok', deliveryId)
  if (!leaseToken) {
    const current = await readAdPlatformServerDelivery(env.DB, 'tiktok', deliveryId)
    if (current?.status === 'sent') {
      await recordDuplicateSuppressed(env.DB, current)
      return { deliveryId, status: 'duplicate_suppressed', reason: 'already_sent' }
    }
    return { deliveryId, status: current?.status ?? delivery.status, reason: 'delivery_lease_active' }
  }

  try {
    let requestInit: RequestInit
    try {
      const payload = buildTikTokEventsPayload({
        pixelId: connection.pixelId,
        eventName: delivery.event_name,
        eventId: delivery.external_event_id,
        eventTime: toUnixSeconds(delivery.occurred_at),
        pageUrl: buildEventSourceUrl(env.SITE_URL, delivery.path),
        userData: options.userData,
      })
      requestInit = tiktokEventsRequestInit(connection.accessToken, payload)
    }
    catch {
      await confirmTransition(env.DB, delivery, {
        status: 'failed', errorCode: 'tiktok_payload_invalid', errorMessage: TIKTOK_ERROR_MESSAGE,
      }, leaseToken)
      return { deliveryId, status: 'failed', reason: 'tiktok_payload_invalid' }
    }

    let response: Response
    try {
      response = await fetchWithTimeout(
        options.fetchFn ?? globalThis.fetch,
        TIKTOK_EVENTS_API_ENDPOINT,
        requestInit,
        options.signal,
        options.timeoutMs ?? DELIVERY_TIMEOUT_MS,
      )
    }
    catch (error) {
      const timedOut = error instanceof TikTokEventsDeliveryError && error.code === 'tiktok_timeout'
      const code = timedOut ? 'tiktok_timeout' : 'tiktok_network_error'
      await confirmTransition(env.DB, delivery, {
        status: 'failed', errorCode: code, errorMessage: TIKTOK_ERROR_MESSAGE,
      }, leaseToken)
      throw new TikTokEventsDeliveryError(code, true)
    }

    const result = await readTikTokEventsResponse(response)
    if (isTikTokEventsSuccess(response, result)) {
      const persisted = await confirmTransition(env.DB, delivery, { status: 'sent' }, leaseToken)
      if (persisted.status === 'sent' && !persisted.transitionChanged) {
        await recordDuplicateSuppressed(env.DB, persisted)
        return { deliveryId, status: 'sent', reason: 'already_sent' }
      }
      return compactResult({ deliveryId, status: 'sent', requestId: result.requestId })
    }

    const errorCode = result.code === null
      ? `tiktok_http_${response.status}`
      : `tiktok_code_${result.code}`
    const retryable = isRetryableTikTokEventsError(response.status, result.code)
    await confirmTransition(env.DB, delivery, {
      status: 'failed', errorCode, errorMessage: TIKTOK_ERROR_MESSAGE,
    }, leaseToken)
    if (isTikTokCredentialError(result.code, response.status)) await invalidateTikTokVerification(env.DB)
    if (retryable) throw new TikTokEventsDeliveryError(errorCode, true)
    return compactResult({ deliveryId, status: 'failed', reason: errorCode, requestId: result.requestId })
  }
  finally {
    await releaseAdPlatformDeliveryLease(env.DB, 'tiktok', deliveryId, leaseToken)
  }
}

async function persistTerminalResult(
  db: D1Database,
  delivery: AdPlatformServerDeliveryRow,
  input: TransitionDeliveryStatusInput,
) {
  const persisted = await confirmTransition(db, delivery, input)
  if (persisted.status === 'sent' && !persisted.transitionChanged) {
    await recordDuplicateSuppressed(db, persisted)
    return { deliveryId: delivery.id, status: 'sent' as const, reason: 'already_sent' }
  }
  return {
    deliveryId: delivery.id,
    status: input.status,
    reason: input.skipReason || input.errorCode,
  }
}

async function confirmTransition(
  db: D1Database,
  delivery: AdPlatformServerDeliveryRow,
  input: TransitionDeliveryStatusInput,
  leaseToken?: string,
) {
  let current = delivery
  for (let attempt = 0; attempt < TRANSITION_MAX_ATTEMPTS; attempt += 1) {
    if (current.status === 'sent') return { ...current, transitionChanged: false }
    if (current.status !== 'pending'
      && (current.status !== 'failed' || !isRetryableAdPlatformDeliveryErrorCode(current.error_code))) {
      throw new TikTokEventsDeliveryError('tiktok_delivery_state_conflict', true)
    }
    const transition = await transitionDeliveryStatus(db, current, input, leaseToken)
    if (transition.changed) {
      return {
        ...current,
        status: input.status,
        skip_reason: input.skipReason ?? '',
        error_code: input.errorCode ?? '',
        transitionChanged: true,
      }
    }
    const refreshed = await readAdPlatformServerDelivery(db, 'tiktok', current.id)
    if (!refreshed) throw new TikTokEventsDeliveryError('tiktok_delivery_state_conflict', true)
    current = refreshed
  }
  if (current.status === 'sent') return { ...current, transitionChanged: false }
  throw new TikTokEventsDeliveryError('tiktok_delivery_state_conflict', true)
}

async function fetchWithTimeout(
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
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, timeoutMs))
  try {
    return await fetchFn(input, { ...init, signal: controller.signal })
  }
  catch {
    throw new TikTokEventsDeliveryError(timedOut ? 'tiktok_timeout' : 'tiktok_network_error', true)
  }
  finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

async function invalidateTikTokVerification(db: D1Database) {
  try {
    await db.batch([
      db.prepare(`
        UPDATE tiktok_connection_verifications
        SET invalidated_at = datetime('now'), invalidation_reason = 'credential_rejected', updated_at = datetime('now')
        WHERE environment = 'production' AND invalidated_at IS NULL
      `),
      db.prepare(`
        UPDATE ad_platform_connections
        SET revision = NULL, server_enabled = 0, rollout_percentage = 0, updated_at = datetime('now')
        WHERE provider = 'tiktok'
      `),
    ])
  }
  catch {
    // 远端凭证错误已经写入 delivery；连接失效补记失败不覆盖原始结果。
  }
}

function isActiveEventName(value: string): value is AdPlatformConversionEventName {
  return ACTIVE_EVENT_NAMES.has(value)
}

function toUnixSeconds(value: string) {
  const timestamp = new Date(value).getTime()
  return Math.floor((Number.isFinite(timestamp) ? timestamp : Date.now()) / 1_000)
}

function buildEventSourceUrl(siteUrl: string | undefined, path: string) {
  const base = String(siteUrl || '').trim()
  if (!base) throw new Error('TIKTOK_SITE_URL_INVALID')
  try {
    const baseUrl = new URL(base)
    const url = new URL(path || '/', baseUrl)
    if (url.origin !== baseUrl.origin) return `${baseUrl.origin}/`
    return `${baseUrl.origin}${url.pathname}`
  }
  catch {
    throw new Error('TIKTOK_SITE_URL_INVALID')
  }
}

function compactResult(result: TikTokEventsSendResult) {
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as unknown as TikTokEventsSendResult
}
