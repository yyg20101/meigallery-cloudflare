import type { MetaServerDeliveryInput, ServerAdapterRequest, ServerDeliveryResult, ServerTrackingAdapter } from '../server-adapter'
import { isCanonicalConversionEvent } from '@meigallery/shared/constants'
import { isAdExternalEventId } from '@meigallery/shared/utils'
import { META_GRAPH_API_VERSION } from '../protocol-versions'
import { isValidAdPlatformIpAddress, isValidAdPlatformUserAgent } from '../../../utils/ad-platform-identifiers'

const META_ENDPOINT = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`
const META_SIGNALS = new Set(['fbc', 'fbp'])
const CROSS_PLATFORM_SIGNALS = new Set(['ttclid', 'ttp', 'gclid', 'gbraid', 'wbraid'])
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613])
const PIXEL_ID_PATTERN = /^\d{5,20}$/
const MIN_EVENT_TIME = 946_684_800
const MAX_EVENT_TIME = 4_102_444_799

export interface MetaServerPayload {
  data: Array<{ event_name: string; event_time: number; event_id: string; action_source: 'website'; event_source_url: string; user_data: { fbc?: string; fbp?: string; em?: string[]; client_ip_address?: string; client_user_agent?: string } }>
}

export function buildMetaServerPayload(input: MetaServerDeliveryInput): MetaServerPayload {
  validateMetaDelivery(input)
  const user_data: MetaServerPayload['data'][number]['user_data'] = {}
  if (input.matchSignals.fbc) user_data.fbc = input.matchSignals.fbc
  if (input.matchSignals.fbp) user_data.fbp = input.matchSignals.fbp
  if (input.hashedEmail) user_data.em = [input.hashedEmail]
  if (input.clientIpAddress && input.clientUserAgent) {
    user_data.client_ip_address = input.clientIpAddress
    user_data.client_user_agent = input.clientUserAgent
  }
  return { data: [{ event_name: input.canonicalEvent, event_time: input.eventTime, event_id: input.externalEventId, action_source: 'website', event_source_url: input.pageUrl, user_data }] }
}

export async function sendMetaServerEvent(input: { input: MetaServerDeliveryInput; config: { pixelId?: string }; accessToken: string; fetcher?: typeof fetch }): Promise<ServerDeliveryResult> {
  try {
    const payload = buildMetaServerPayload(input.input)
    if (!validPixelId(input.config.pixelId) || !validSecret(input.accessToken)) return invalidDestination()
    const response = await (input.fetcher ?? fetch)(`${META_ENDPOINT}/${input.config.pixelId}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, access_token: input.accessToken }) })
    return classifyMetaResponse(response)
  }
  catch (error) {
    if (isCrossPlatformError(error)) return crossPlatformInvalid()
    return isInvalidDeliveryError(error) ? invalidDestination() : { classification: 'retryable' }
  }
}

export const metaServerAdapter: ServerTrackingAdapter = {
  provider: 'meta',
  async deliver(request: ServerAdapterRequest) {
    if (request.input.provider !== 'meta') return invalidDestination()
    return sendMetaServerEvent({ input: request.input, config: request.config, accessToken: request.credential, fetcher: request.fetcher })
  },
}

function validateMetaDelivery(input: MetaServerDeliveryInput) {
  if (input.provider !== 'meta' || !validDeliveryCore(input) || !validText(input.destination) || !validHash(input.hashedEmail)) throw new Error('delivery_input_invalid')
  const hasNetworkMatch = validNetworkContext(input)
  let hasMatch = Boolean(input.hashedEmail) || hasNetworkMatch
  for (const [key, value] of Object.entries(input.matchSignals)) {
    if (!validText(value)) throw new Error('delivery_input_invalid')
    if (CROSS_PLATFORM_SIGNALS.has(key)) throw new Error('cross_platform_identifier')
    if (!META_SIGNALS.has(key)) throw new Error('delivery_input_invalid')
    hasMatch = true
  }
  if (!hasMatch) throw new Error('delivery_input_invalid')
}
function validNetworkContext(input: MetaServerDeliveryInput) {
  if (input.clientIpAddress === undefined && input.clientUserAgent === undefined) return false
  if (!isValidAdPlatformIpAddress(input.clientIpAddress) || !isValidAdPlatformUserAgent(input.clientUserAgent)) throw new Error('delivery_input_invalid')
  return true
}
async function classifyMetaResponse(response: Response): Promise<ServerDeliveryResult> {
  const error = await readMetaError(response)
  const receipt = { status: response.status }
  if (response.status >= 200 && response.status < 300) return { classification: 'accepted', receipt }
  if (response.status === 401 || response.status === 403 || error.code === 190 || error.code === 102) return { classification: 'credential_invalid', receipt }
  if (response.status === 429 || response.status >= 500 || error.isTransient || error.code !== null && TRANSIENT_META_CODES.has(error.code)) return { classification: 'retryable', receipt }
  if (response.status === 400 || response.status === 404 || response.status === 422) return { classification: 'destination_invalid', receipt }
  return { classification: 'rejected', receipt }
}
async function readMetaError(response: Response) {
  try {
    const value = await response.clone().json() as { error?: { code?: unknown; error_subcode?: unknown; is_transient?: unknown } }
    const error = value.error ?? {}
    return { code: Number.isSafeInteger(error.code) ? Number(error.code) : null, subcode: Number.isSafeInteger(error.error_subcode) ? Number(error.error_subcode) : null, isTransient: error.is_transient === true }
  }
  catch { return { code: null, subcode: null, isTransient: false } }
}
function validDeliveryCore(input: MetaServerDeliveryInput) { return isCanonicalConversionEvent(input.canonicalEvent) && validEventId(input.externalEventId) && validEventTime(input.eventTime) && validUrl(input.pageUrl) }
function validEventId(value: unknown): value is string { return isAdExternalEventId(value) }
function validEventTime(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_EVENT_TIME && value <= MAX_EVENT_TIME }
function validUrl(value: string) { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password } catch { return false } }
function validHash(value: unknown) { return value === undefined || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validPixelId(value: unknown): value is string { return typeof value === 'string' && PIXEL_ID_PATTERN.test(value) }
function validSecret(value: unknown): value is string { return validText(value) }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value) }
function invalidDestination(): ServerDeliveryResult { return { classification: 'destination_invalid' } }
function crossPlatformInvalid(): ServerDeliveryResult { return { classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } } }
function isCrossPlatformError(error: unknown) { return error instanceof Error && error.message === 'cross_platform_identifier' }
function isInvalidDeliveryError(error: unknown) { return error instanceof Error && error.message === 'delivery_input_invalid' }
