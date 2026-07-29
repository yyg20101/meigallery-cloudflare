import type { GoogleServerDeliveryInput, ServerDeliveryResult, ServerTrackingAdapter } from '../server-adapter'
import { isCanonicalConversionEvent } from '@meigallery/shared/constants'
import { isAdExternalEventId } from '@meigallery/shared/utils'
import { getGoogleAccessToken, GoogleAuthError, parseGoogleServiceAccount } from './google-auth'

const GOOGLE_EVENTS_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest'
const GOOGLE_SIGNALS = new Set(['gclid', 'gbraid', 'wbraid'])
const CROSS_PLATFORM_SIGNALS = new Set(['fbc', 'fbp', 'ttclid', 'ttp'])
const ACCOUNT_ID_PATTERN = /^\d{1,20}$/
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const MIN_EVENT_TIME = 946_684_800
const MAX_EVENT_TIME = 4_102_444_799

export interface GoogleServerConfig { customerId?: string; loginCustomerId?: string; cloudProjectId?: string }
export interface GoogleServerRequest {
  validateOnly: boolean
  encoding?: 'HEX'
  destinations: Array<{ operatingAccount: { accountType: 'GOOGLE_ADS'; accountId: string }; loginAccount?: { accountType: 'GOOGLE_ADS'; accountId: string }; productDestinationId: string }>
  events: Array<{ eventTimestamp: string; transactionId: string; eventSource: 'WEB'; adIdentifiers: Record<string, string>; userData?: { userIdentifiers: Array<{ emailAddress: string }> } }>
}

export function buildGoogleServerRequest(input: GoogleServerDeliveryInput, config: GoogleServerConfig): GoogleServerRequest {
  validateGoogleDelivery(input)
  if (!validAccountId(config.customerId) || !validProjectId(config.cloudProjectId) || config.loginCustomerId !== undefined && !validAccountId(config.loginCustomerId)) throw new Error('destination_invalid')
  const event = {
    eventTimestamp: new Date(input.eventTime * 1_000).toISOString(), transactionId: input.externalEventId, eventSource: 'WEB' as const,
    adIdentifiers: compact(input.matchSignals), ...(input.hashedEmail ? { userData: { userIdentifiers: [{ emailAddress: input.hashedEmail }] } } : {}),
  }
  return {
    validateOnly: input.validateOnly, ...(input.hashedEmail ? { encoding: 'HEX' as const } : {}),
    destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: config.customerId }, ...(config.loginCustomerId ? { loginAccount: { accountType: 'GOOGLE_ADS' as const, accountId: config.loginCustomerId } } : {}), productDestinationId: input.destination }],
    events: [event],
  }
}

export async function sendGoogleServerEvent(input: {
  input: GoogleServerDeliveryInput
  config: GoogleServerConfig
  serviceAccount: string
  fetcher?: typeof fetch
}): Promise<ServerDeliveryResult> {
  try {
    const request = buildGoogleServerRequest(input.input, input.config)
    const accessToken = await getGoogleAccessToken({ credential: parseGoogleServiceAccount(input.serviceAccount), fetcher: input.fetcher })
    const response = await (input.fetcher ?? fetch)(GOOGLE_EVENTS_ENDPOINT, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'x-goog-user-project': input.config.cloudProjectId! }, body: JSON.stringify(request),
    })
    return await classifiedResponse(response)
  }
  catch (error) {
    if (isCrossPlatformError(error)) return crossPlatformInvalid()
    if (error instanceof GoogleAuthError) return { classification: error.classification }
    return error instanceof Error && error.message === 'destination_invalid' ? { classification: 'destination_invalid' } : { classification: 'retryable' }
  }
}

export const googleServerAdapter: ServerTrackingAdapter = {
  provider: 'google',
  async deliver(request) {
    if (request.input.provider !== 'google') return { classification: 'destination_invalid' }
    return sendGoogleServerEvent({ input: request.input, config: request.config, serviceAccount: request.credential, fetcher: request.fetcher })
  },
}

function validateGoogleDelivery(input: GoogleServerDeliveryInput) {
  if (input.provider !== 'google' || typeof input.validateOnly !== 'boolean' || !validEvent(input) || !validUrl(input.pageUrl) || !validAccountId(input.destination) || !validHash(input.hashedEmail)) throw new Error('destination_invalid')
  let hasMatch = Boolean(input.hashedEmail)
  for (const [key, value] of Object.entries(input.matchSignals)) {
    if (!validText(value)) throw new Error('destination_invalid')
    if (CROSS_PLATFORM_SIGNALS.has(key)) throw new Error('cross_platform_identifier')
    if (!GOOGLE_SIGNALS.has(key)) throw new Error('destination_invalid')
    hasMatch = true
  }
  if (!hasMatch) throw new Error('destination_invalid')
}
async function classifiedResponse(response: Response): Promise<ServerDeliveryResult> {
  const receipt = { status: response.status, ...await responseRequestId(response) }
  if (response.status >= 200 && response.status < 300) return { classification: receipt.requestId ? 'accepted' : 'retryable', receipt }
  if (response.status === 401 || response.status === 403) return { classification: 'credential_invalid', receipt }
  if (response.status === 429 || response.status >= 500) return { classification: 'retryable', receipt }
  if (response.status === 400 || response.status === 404 || response.status === 422) return { classification: 'destination_invalid', receipt }
  return { classification: 'rejected', receipt }
}
async function responseRequestId(response: Response) { try { const value = await response.clone().json() as { requestId?: unknown }; return typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.requestId) ? { requestId: value.requestId } : {} } catch { return {} } }
function compact(input: Record<string, string>) { return Object.fromEntries(Object.entries(input).filter(([key]) => GOOGLE_SIGNALS.has(key))) }
function crossPlatformInvalid(): ServerDeliveryResult { return { classification: 'destination_invalid', incident: { code: 'cross_platform_identifier', severity: 'critical' } } }
function isCrossPlatformError(error: unknown) { return error instanceof Error && error.message === 'cross_platform_identifier' }
function validEvent(input: GoogleServerDeliveryInput) { return isCanonicalConversionEvent(input.canonicalEvent) && typeof input.eventTime === 'number' && Number.isSafeInteger(input.eventTime) && input.eventTime >= MIN_EVENT_TIME && input.eventTime <= MAX_EVENT_TIME && isAdExternalEventId(input.externalEventId) }
function validUrl(value: string) { try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password } catch { return false } }
function validHash(value: unknown) { return value === undefined || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validAccountId(value: unknown): value is string { return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value) }
function validProjectId(value: unknown): value is string { return typeof value === 'string' && GCP_PROJECT_ID_PATTERN.test(value) }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value) }
