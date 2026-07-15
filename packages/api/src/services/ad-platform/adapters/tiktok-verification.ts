import {
  fetchVerification,
  PlatformVerificationError,
  requireProductionSiteUrl,
  requireVerificationBindings,
  safeRequestId,
  verificationEventIds,
  type PlatformVerificationAdapter,
} from '../verification-adapter'

const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'
const PIXEL_CODE_PATTERN = /^[A-Z0-9]{10,30}$/
const TEST_EVENT_CODE_PATTERN = /^[A-Za-z0-9_-]{4,128}$/

export const tiktokVerificationAdapter: PlatformVerificationAdapter = {
  provider: 'tiktok',
  normalizeTestEventCode(value) {
    const normalized = String(value ?? '').trim()
    return TEST_EVENT_CODE_PATTERN.test(normalized) ? normalized : null
  },
  async verify(input) {
    if (input.provider !== 'tiktok') throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
    requireVerificationBindings(input)
    const pixelCode = input.publicConfig.pixelCode
    const testEventCode = String(input.testEventCode || '').trim()
    if (!PIXEL_CODE_PATTERN.test(pixelCode || '')) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_DESTINATION_REJECTED')
    if (!TEST_EVENT_CODE_PATTERN.test(testEventCode)) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_TEST_CODE_REQUIRED')
    if (!safeSecret(input.credential)) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_CREDENTIAL_REJECTED')

    const eventIds = await verificationEventIds('ttv', input.verificationId)
    const eventTime = Math.floor(Date.now() / 1_000)
    const pageUrl = requireProductionSiteUrl(input.siteUrl, '/tiktok-attribution-verification')
    const response = await fetchVerification(input.fetcher ?? fetch, ENDPOINT, {
      method: 'POST',
      headers: { 'Access-Token': input.credential, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_source: 'web',
        event_source_id: pixelCode,
        test_event_code: testEventCode,
        data: (['Contact', 'CompleteRegistration'] as const).map(event => ({
          event,
          event_time: eventTime,
          event_id: eventIds[event],
          user: {
            ip: '192.0.2.1',
            user_agent: 'MeiGallery Attribution Verification/1.0',
          },
          page: { url: pageUrl },
          properties: { description: 'attribution_connection_test' },
        })),
      }),
    })
    const result = await readTikTokResult(response)
    if (response.status === 401 || response.status === 403 || result.code >= 40_101 && result.code <= 40_105) {
      throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_CREDENTIAL_REJECTED')
    }
    if (!response.ok || result.code !== 0) {
      throw new PlatformVerificationError(response.status >= 500 || response.status === 429
        ? 'AD_PLATFORM_VERIFICATION_NETWORK_ERROR'
        : 'AD_PLATFORM_VERIFICATION_PROVIDER_REJECTED')
    }
    return {
      schemaVersion: 1,
      provider: 'tiktok',
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

async function readTikTokResult(response: Response) {
  try {
    const value = await response.clone().json() as Record<string, unknown>
    return {
      code: Number.isSafeInteger(value.code) ? Number(value.code) : -1,
      requestId: safeRequestId(value.request_id),
    }
  }
  catch {
    return { code: -1, requestId: '' }
  }
}

function safeSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 32_768
}
