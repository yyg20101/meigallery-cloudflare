import type {
  AdPlatformConversionEventName,
  AdPlatformSensitiveContext,
} from '@meigallery/shared'
import { ATTRIBUTION_LIMITS } from '@meigallery/shared/constants'
import { normalizeAdPlatformUserData } from '../utils/ad-platform-identifiers'

export const TIKTOK_EVENTS_API_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PIXEL_ID_PATTERN = /^[A-Z0-9]{10,30}$/
const TEST_EVENT_CODE_PATTERN = /^[A-Za-z0-9_-]{4,128}$/
const RETRYABLE_CODES = new Set([40016, 40100, 40133, 40202, 60001])
const PROPERTY_ALLOWLIST = new Set(['description', 'search_string'])

export interface TikTokEventsPayloadInput {
  pixelId: string
  eventName: AdPlatformConversionEventName
  eventId: string
  eventTime: number
  pageUrl: string
  pageReferrer?: string
  userData?: AdPlatformSensitiveContext
  properties?: Record<string, unknown>
  testEventCode?: string
}

export interface TikTokEventsApiResponse {
  code: number | null
  message: string
  requestId: string
}

export function buildTikTokEventsPayload(input: TikTokEventsPayloadInput) {
  const pixelId = String(input.pixelId || '').trim().toUpperCase()
  if (!PIXEL_ID_PATTERN.test(pixelId)) throw new Error('TIKTOK_EVENTS_PIXEL_ID_INVALID')
  const pageUrl = normalizePageUrl(input.pageUrl)
  if (!pageUrl) throw new Error('TIKTOK_EVENTS_PAGE_URL_INVALID')
  const eventTime = Math.trunc(input.eventTime)
  if (!Number.isSafeInteger(eventTime) || eventTime <= 0) throw new Error('TIKTOK_EVENTS_TIME_INVALID')
  const eventId = safeText(input.eventId, 160)
  if (!eventId) throw new Error('TIKTOK_EVENTS_EVENT_ID_INVALID')

  const normalized = normalizeAdPlatformUserData(input.userData)
  const advancedMatching = input.eventName === 'CompleteRegistration'
    ? {
        email: validSha256(input.userData?.emailSha256) ? input.userData!.emailSha256 : undefined,
        external_id: validSha256(input.userData?.externalIdSha256) ? input.userData!.externalIdSha256 : undefined,
      }
    : {}
  const user = compactObject({
    ttclid: normalized.ttclid,
    ttp: normalized.ttp,
    ip: normalized.clientIpAddress,
    user_agent: normalized.clientUserAgent,
    ...advancedMatching,
  })
  const referrer = normalizePageUrl(input.pageReferrer || '')
  const event = compactObject({
    event: input.eventName,
    event_time: eventTime,
    event_id: eventId,
    user,
    page: compactObject({ url: pageUrl, referrer: referrer || undefined }),
    properties: sanitizeProperties(input.properties || {}),
  })
  const testEventCode = safeText(input.testEventCode, 128)
  if (testEventCode && !TEST_EVENT_CODE_PATTERN.test(testEventCode)) {
    throw new Error('TIKTOK_EVENTS_TEST_CODE_INVALID')
  }

  return compactObject({
    event_source: 'web',
    event_source_id: pixelId,
    test_event_code: testEventCode || undefined,
    data: [event],
  })
}

export function tiktokEventsRequestInit(accessToken: string, payload: Record<string, unknown>): RequestInit {
  const token = safeText(accessToken, 4_096)
  if (!token) throw new Error('TIKTOK_EVENTS_ACCESS_TOKEN_MISSING')
  return {
    method: 'POST',
    headers: {
      'Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
}

export async function readTikTokEventsResponse(response: Response): Promise<TikTokEventsApiResponse> {
  try {
    const value = await response.clone().json<unknown>()
    if (!isPlainRecord(value)) return { code: null, message: '', requestId: '' }
    return {
      code: Number.isSafeInteger(value.code) ? Number(value.code) : null,
      message: safeText(value.message, 240),
      requestId: safeText(value.request_id, 160),
    }
  }
  catch {
    return { code: null, message: '', requestId: '' }
  }
}

export function isTikTokEventsSuccess(response: Response, result: TikTokEventsApiResponse) {
  return response.ok && result.code === 0
}

export function isRetryableTikTokEventsError(status: number, code: number | null) {
  return status === 429
    || status >= 500
    || (code !== null && (RETRYABLE_CODES.has(code) || (code >= 50_000 && code < 60_000)))
}

export function isTikTokCredentialError(code: number | null, status?: number) {
  return status === 401
    || status === 403
    || (code !== null && code >= 40_101 && code <= 40_105)
}

function sanitizeProperties(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!PROPERTY_ALLOWLIST.has(key)) continue
    if (typeof value === 'string') {
      const text = value.replace(/\s+/g, ' ').trim().slice(0, ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH)
      if (text) output[key] = text
    }
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
    else if (typeof value === 'boolean') output[key] = value
  }
  return output
}

function normalizePageUrl(value: string) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  }
  catch {
    return ''
  }
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === '') return false
    if (isPlainRecord(value) && Object.keys(value).length === 0) return false
    return true
  }))
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function safeText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text && text.length <= maxLength && !/\p{Cc}/u.test(text) ? text : ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
