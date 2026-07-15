import type { ServerAdapterRequest, ServerDeliveryResult, ServerTrackingAdapter, TikTokServerDeliveryInput } from '../server-adapter'

const TIKTOK_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.2/pixel/track/'
const TIKTOK_SIGNALS = new Set(['ttclid', 'ttp'])
const CROSS_PLATFORM_SIGNALS = new Set(['fbc', 'fbp', 'gclid', 'gbraid', 'wbraid'])

export interface TikTokServerPayload {
  pixel_code: string
  event: string
  event_id: string
  timestamp: string
  context: { page: { url: string }; ad?: { callback: string }; user?: { ttp?: string; email?: string } }
}

export function buildTikTokServerPayload(input: TikTokServerDeliveryInput, pixelCode: string): TikTokServerPayload {
  validateTikTokDelivery(input)
  const user = compact({ ttp: input.matchSignals.ttp, email: input.hashedEmail })
  return {
    pixel_code: pixelCode, event: input.canonicalEvent, event_id: input.externalEventId, timestamp: new Date(input.eventTime * 1_000).toISOString(),
    context: { page: { url: input.pageUrl }, ...(input.matchSignals.ttclid ? { ad: { callback: input.matchSignals.ttclid } } : {}), ...(Object.keys(user).length ? { user } : {}) },
  }
}

export async function sendTikTokServerEvent(input: {
  input: TikTokServerDeliveryInput
  config: { pixelCode?: string }
  accessToken: string
  fetcher?: typeof fetch
}): Promise<ServerDeliveryResult> {
  try {
    if (!validId(input.config.pixelCode) || !validSecret(input.accessToken)) return invalidDestination()
    const payload = buildTikTokServerPayload(input.input, input.config.pixelCode)
    const response = await (input.fetcher ?? fetch)(TIKTOK_ENDPOINT, {
      method: 'POST', headers: { 'Access-Token': input.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (response.status >= 200 && response.status < 300 && !await successfulTikTokResponse(response)) return { classification: 'rejected', receipt: { status: response.status } }
    return classifiedResponse(response.status)
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
  if (input.provider !== 'tiktok' || !validEvent(input) || !validUrl(input.pageUrl) || !validText(input.destination) || !validHash(input.hashedEmail)) throw new Error('delivery_input_invalid')
  for (const [key, value] of Object.entries(input.matchSignals)) {
    if (!validText(value)) throw new Error('delivery_input_invalid')
    if (CROSS_PLATFORM_SIGNALS.has(key)) throw new Error('cross_platform_identifier')
    if (!TIKTOK_SIGNALS.has(key)) throw new Error('delivery_input_invalid')
  }
}
async function successfulTikTokResponse(response: Response) { try { const value = await response.clone().json() as { code?: unknown }; return value.code === undefined || value.code === 0 } catch { return true } }
function classifiedResponse(status: number): ServerDeliveryResult { const receipt = { status }; if (status >= 200 && status < 300) return { classification: 'accepted', receipt }; if (status === 401 || status === 403) return { classification: 'credential_invalid', receipt }; if (status === 429 || status >= 500) return { classification: 'retryable', receipt }; if (status === 400 || status === 404 || status === 422) return { classification: 'destination_invalid', receipt }; return { classification: 'rejected', receipt } }
function invalidDestination(): ServerDeliveryResult { return { classification: 'destination_invalid' } }
function crossPlatformInvalid(): ServerDeliveryResult { return { classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } } }
function isCrossPlatformError(error: unknown) { return error instanceof Error && error.message === 'cross_platform_identifier' }
function isInvalidDeliveryError(error: unknown) { return error instanceof Error && error.message === 'delivery_input_invalid' }
function validEvent(input: TikTokServerDeliveryInput) { return (input.canonicalEvent === 'Contact' || input.canonicalEvent === 'CompleteRegistration') && Number.isSafeInteger(input.eventTime) && input.eventTime > 0 && validText(input.externalEventId) && input.externalEventId.length <= 64 }
function validUrl(value: string) { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) } catch { return false } }
function validHash(value: unknown) { return value === undefined || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validId(value: unknown): value is string { return validText(value) && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validSecret(value: unknown): value is string { return validText(value) }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value) }
function compact(input: { ttp?: string; email?: string }) { return Object.fromEntries(Object.entries(input).filter((entry): entry is ['ttp' | 'email', string] => entry[1] !== undefined)) }
