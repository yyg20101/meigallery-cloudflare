import { META_GRAPH_API_VERSION } from '../protocol-versions'
import {
  fetchVerification,
  PlatformVerificationError,
  requireProductionSiteUrl,
  requireVerificationBindings,
  safeRequestId,
  verificationEventIds,
  type PlatformVerificationAdapter,
} from '../verification-adapter'

const PIXEL_ID_PATTERN = /^\d{5,30}$/
const TEST_EVENT_CODE_PATTERN = /^TEST\d{1,20}$/

export const metaVerificationAdapter: PlatformVerificationAdapter = {
  provider: 'meta',
  normalizeTestEventCode(value) {
    const normalized = String(value ?? '').trim().toUpperCase()
    return TEST_EVENT_CODE_PATTERN.test(normalized) ? normalized : null
  },
  async verify(input) {
    if (input.provider !== 'meta') throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
    requireVerificationBindings(input)
    const pixelId = input.publicConfig.pixelId
    const testEventCode = String(input.testEventCode || '').trim().toUpperCase()
    if (!PIXEL_ID_PATTERN.test(pixelId || '')) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_DESTINATION_REJECTED')
    if (!TEST_EVENT_CODE_PATTERN.test(testEventCode)) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_TEST_CODE_REQUIRED')
    if (!safeSecret(input.credential)) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_CREDENTIAL_REJECTED')

    const eventIds = await verificationEventIds('mav', input.verificationId)
    const eventTime = Math.floor(Date.now() / 1_000)
    const eventSourceUrl = requireProductionSiteUrl(input.siteUrl, '/meta-attribution-verification')
    const response = await fetchVerification(
      input.fetcher ?? fetch,
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pixelId}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: (['Contact', 'CompleteRegistration'] as const).map(event => ({
            event_name: event,
            event_time: eventTime,
            event_id: eventIds[event],
            event_source_url: eventSourceUrl,
            action_source: 'website',
            user_data: {
              client_ip_address: '192.0.2.1',
              client_user_agent: 'MeiGallery Attribution Verification/1.0',
            },
            custom_data: { content_category: 'attribution_connection_test' },
          })),
          test_event_code: testEventCode,
        }),
      },
    )
    const result = await readMetaResult(response)
    if (response.status === 401 || response.status === 403 || result.errorCode === 190) {
      throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_CREDENTIAL_REJECTED')
    }
    if (!response.ok || result.eventsReceived < 2) {
      throw new PlatformVerificationError(response.status >= 500 || response.status === 429
        ? 'AD_PLATFORM_VERIFICATION_NETWORK_ERROR'
        : 'AD_PLATFORM_VERIFICATION_PROVIDER_REJECTED')
    }
    return {
      schemaVersion: 1,
      provider: 'meta',
      targetValid: true,
      credentialValid: true,
      bindingsValid: true,
      testEventsSent: 2,
      externalEventIds: [eventIds.Contact, eventIds.CompleteRegistration],
      requestIds: result.requestId ? [result.requestId] : [],
      checkedAt: new Date().toISOString(),
    }
  },
}

async function readMetaResult(response: Response) {
  try {
    const value = await response.clone().json() as Record<string, unknown>
    const error = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {}
    return {
      eventsReceived: Number.isSafeInteger(value.events_received) ? Number(value.events_received) : 0,
      errorCode: Number.isSafeInteger(error.code) ? Number(error.code) : 0,
      requestId: safeRequestId(response.headers.get('x-fb-trace-id')),
    }
  }
  catch {
    return { eventsReceived: 0, errorCode: 0, requestId: '' }
  }
}

function safeSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 32_768
}
