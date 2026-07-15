import type { MetaServerDeliveryInput, ServerAdapterRequest, ServerDeliveryResult, ServerTrackingAdapter } from '../server-adapter'

const META_ENDPOINT = 'https://graph.facebook.com/v25.0'
const META_SIGNALS = new Set(['fbc', 'fbp'])
const CROSS_PLATFORM_SIGNALS = new Set(['ttclid', 'ttp', 'gclid', 'gbraid', 'wbraid'])

export interface MetaServerPayload {
  data: Array<{
    event_name: string
    event_time: number
    event_id: string
    action_source: 'website'
    event_source_url: string
    user_data: { fbc?: string; fbp?: string; em?: string[] }
  }>
}

export function buildMetaServerPayload(input: MetaServerDeliveryInput): MetaServerPayload {
  validateDeliveryInput(input, META_SIGNALS, CROSS_PLATFORM_SIGNALS)
  const user_data = compact({ fbc: input.matchSignals.fbc, fbp: input.matchSignals.fbp })
  if (input.hashedEmail) user_data.em = [input.hashedEmail]
  return { data: [{
    event_name: input.canonicalEvent, event_time: input.eventTime, event_id: input.externalEventId,
    action_source: 'website', event_source_url: input.pageUrl, user_data,
  }] }
}

export async function sendMetaServerEvent(input: {
  input: MetaServerDeliveryInput
  config: { pixelId?: string }
  accessToken: string
  fetcher?: typeof fetch
}): Promise<ServerDeliveryResult> {
  try {
    const payload = buildMetaServerPayload(input.input)
    if (!validId(input.config.pixelId) || !validSecret(input.accessToken)) return invalidDestination()
    const response = await (input.fetcher ?? fetch)(`${META_ENDPOINT}/${encodeURIComponent(input.config.pixelId)}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, access_token: input.accessToken }),
    })
    return classifiedResponse(response.status)
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

function validateDeliveryInput(input: MetaServerDeliveryInput, allowedSignals: Set<string>, crossPlatformSignals: Set<string>) {
  if (input.provider !== 'meta' || !validEvent(input) || !validUrl(input.pageUrl) || !validText(input.destination) || !validHash(input.hashedEmail)) throw new Error('delivery_input_invalid')
  for (const [key, value] of Object.entries(input.matchSignals)) {
    if (!validText(value)) throw new Error('delivery_input_invalid')
    if (crossPlatformSignals.has(key)) throw new Error('cross_platform_identifier')
    if (!allowedSignals.has(key)) throw new Error('delivery_input_invalid')
  }
}

function classifiedResponse(status: number): ServerDeliveryResult {
  const receipt = { status }
  if (status >= 200 && status < 300) return { classification: 'accepted', receipt }
  if (status === 401 || status === 403) return { classification: 'credential_invalid', receipt }
  if (status === 429 || status >= 500) return { classification: 'retryable', receipt }
  if (status === 400 || status === 404 || status === 422) return { classification: 'destination_invalid', receipt }
  return { classification: 'rejected', receipt }
}
function invalidDestination(): ServerDeliveryResult { return { classification: 'destination_invalid' } }
function crossPlatformInvalid(): ServerDeliveryResult { return { classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } } }
function isCrossPlatformError(error: unknown) { return error instanceof Error && error.message === 'cross_platform_identifier' }
function isInvalidDeliveryError(error: unknown) { return error instanceof Error && error.message === 'delivery_input_invalid' }
function validEvent(input: MetaServerDeliveryInput) { return input.canonicalEvent === 'Contact' || input.canonicalEvent === 'CompleteRegistration' ? Number.isSafeInteger(input.eventTime) && input.eventTime > 0 && validText(input.externalEventId) && input.externalEventId.length <= 64 : false }
function validUrl(value: string) { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) } catch { return false } }
function validHash(value: unknown) { return value === undefined || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validId(value: unknown): value is string { return validText(value) && /^[A-Za-z0-9_-]{1,160}$/.test(value) }
function validSecret(value: unknown): value is string { return validText(value) }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value) }
function compact(input: { fbc?: string; fbp?: string }) { return Object.fromEntries(Object.entries(input).filter((entry): entry is ['fbc' | 'fbp', string] => entry[1] !== undefined)) as { fbc?: string; fbp?: string; em?: string[] } }
