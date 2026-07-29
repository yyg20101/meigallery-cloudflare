import type { ServerDeliveryResult, ServerTrackingAdapter, TikTokServerDeliveryInput } from '../server-adapter'
import { isAdExternalEventId } from '@meigallery/shared/utils'
import { isValidAdPlatformIpAddress, isValidAdPlatformUserAgent } from '../../../utils/ad-platform-identifiers'

const TIKTOK_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'
const TIKTOK_SIGNALS = new Set(['ttclid', 'ttp'])
const CROSS_PLATFORM_SIGNALS = new Set(['fbc', 'fbp', 'gclid', 'gbraid', 'wbraid'])
const RETRYABLE_CODES = new Set([40016, 40100, 40133, 40202, 60001])
const PIXEL_CODE_PATTERN = /^[A-Z0-9]{10,30}$/
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/
const MIN_EVENT_TIME = 946_684_800
const MAX_EVENT_TIME = 4_102_444_799

export interface TikTokServerPayload {
  event_source: 'web'
  event_source_id: string
  data: Array<{ event: string; event_time: number; event_id: string; user: { ttclid?: string; ttp?: string; email?: string[]; ip?: string; user_agent?: string }; page: { url: string } }>
}

export function buildTikTokServerPayload(input: TikTokServerDeliveryInput, pixelCode: string): TikTokServerPayload {
  validateTikTokDelivery(input)
  if (!validPixelCode(pixelCode)) throw new Error('delivery_input_invalid')
  const user: TikTokServerPayload['data'][number]['user'] = {}
  if (input.matchSignals.ttclid) user.ttclid = input.matchSignals.ttclid
  if (input.matchSignals.ttp) user.ttp = input.matchSignals.ttp
  if (input.hashedEmail) user.email = [input.hashedEmail]
  if (input.clientIpAddress && input.clientUserAgent) {
    user.ip = input.clientIpAddress
    user.user_agent = input.clientUserAgent
  }
  return { event_source: 'web', event_source_id: pixelCode, data: [{ event: input.canonicalEvent, event_time: input.eventTime, event_id: input.externalEventId, user, page: { url: input.pageUrl } }] }
}

export async function sendTikTokServerEvent(input: { input: TikTokServerDeliveryInput; config: { pixelCode?: string }; accessToken: string; fetcher?: typeof fetch }): Promise<ServerDeliveryResult> {
  try {
    assertNoCrossPlatformSignals(input.input.matchSignals)
    if (!validPixelCode(input.config.pixelCode) || !validSecret(input.accessToken)) return invalidDestination()
    const payload = buildTikTokServerPayload(input.input, input.config.pixelCode)
    const response = await (input.fetcher ?? fetch)(TIKTOK_ENDPOINT, { method: 'POST', headers: { 'Access-Token': input.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    return classifyTikTokResponse(response)
  }
  catch (error) {
    if (isCrossPlatformError(error)) return crossPlatformInvalid()
    return isInvalidDeliveryError(error) ? invalidDestination() : { classification: 'retryable' }
  }
}

export const tiktokServerAdapter: ServerTrackingAdapter = {
  provider: 'tiktok',
  async deliver(request) {
    if (request.input.provider !== 'tiktok') return invalidDestination()
    return sendTikTokServerEvent({ input: request.input, config: request.config, accessToken: request.credential, fetcher: request.fetcher })
  },
}

function validateTikTokDelivery(input: TikTokServerDeliveryInput) {
  if (input.provider !== 'tiktok' || !validDeliveryCore(input) || !validText(input.destination) || !validHash(input.hashedEmail)) throw new Error('delivery_input_invalid')
  const hasNetworkMatch = validNetworkContext(input)
  let hasMatch = Boolean(input.hashedEmail) || hasNetworkMatch
  for (const [key, value] of Object.entries(input.matchSignals)) {
    if (!validText(value)) throw new Error('delivery_input_invalid')
    if (CROSS_PLATFORM_SIGNALS.has(key)) throw new Error('cross_platform_identifier')
    if (!TIKTOK_SIGNALS.has(key)) throw new Error('delivery_input_invalid')
    hasMatch = true
  }
  if (!hasMatch) throw new Error('delivery_input_invalid')
}
function validNetworkContext(input: TikTokServerDeliveryInput) {
  if (input.clientIpAddress === undefined && input.clientUserAgent === undefined) return false
  if (!isValidAdPlatformIpAddress(input.clientIpAddress) || !isValidAdPlatformUserAgent(input.clientUserAgent)) throw new Error('delivery_input_invalid')
  return true
}
function assertNoCrossPlatformSignals(matchSignals: Record<string, string>) {
  if (Object.keys(matchSignals).some(key => CROSS_PLATFORM_SIGNALS.has(key))) throw new Error('cross_platform_identifier')
}
async function classifyTikTokResponse(response: Response): Promise<ServerDeliveryResult> {
  const result = await readTikTokResponse(response)
  const receipt = { status: response.status, ...(result.requestId ? { requestId: result.requestId } : {}) }
  if (response.status >= 200 && response.status < 300 && result.code === 0) return { classification: 'accepted', receipt }
  if (response.status === 401 || response.status === 403 || result.code !== null && result.code >= 40101 && result.code <= 40105) return { classification: 'credential_invalid', receipt }
  if (response.status === 429 || response.status >= 500 || result.code !== null && (RETRYABLE_CODES.has(result.code) || result.code >= 50_000 && result.code < 60_000)) return { classification: 'retryable', receipt }
  if (response.status === 400 || response.status === 404 || response.status === 422 || result.code !== null && result.code >= 40_000 && result.code < 50_000) return { classification: 'destination_invalid', receipt }
  return { classification: 'rejected', receipt }
}
async function readTikTokResponse(response: Response) {
  try {
    const value = await response.clone().json() as { code?: unknown; request_id?: unknown }
    return { code: Number.isSafeInteger(value.code) ? Number(value.code) : null, requestId: typeof value.request_id === 'string' && SAFE_REQUEST_ID_PATTERN.test(value.request_id) ? value.request_id : '' }
  }
  catch { return { code: null, requestId: '' } }
}
function validDeliveryCore(input: TikTokServerDeliveryInput) { return (input.canonicalEvent === 'Contact' || input.canonicalEvent === 'CompleteRegistration') && validEventId(input.externalEventId) && validEventTime(input.eventTime) && validUrl(input.pageUrl) }
function validEventId(value: unknown): value is string { return isAdExternalEventId(value) }
function validEventTime(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_EVENT_TIME && value <= MAX_EVENT_TIME }
function validUrl(value: string) { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password } catch { return false } }
function validHash(value: unknown) { return value === undefined || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validPixelCode(value: unknown): value is string { return typeof value === 'string' && PIXEL_CODE_PATTERN.test(value) }
function validSecret(value: unknown): value is string { return validText(value) }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value) }
function invalidDestination(): ServerDeliveryResult { return { classification: 'destination_invalid' } }
function crossPlatformInvalid(): ServerDeliveryResult { return { classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } } }
function isCrossPlatformError(error: unknown) { return error instanceof Error && error.message === 'cross_platform_identifier' }
function isInvalidDeliveryError(error: unknown) { return error instanceof Error && error.message === 'delivery_input_invalid' }
