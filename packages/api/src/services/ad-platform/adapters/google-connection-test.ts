import { sendGoogleServerEvent } from './google-server'
import {
  PlatformConnectionTestError,
  connectionTestEventIds,
  requireConnectionTestBindings,
  requireProductionSiteUrl,
  type PlatformConnectionTestAdapter,
} from '../connection-test-adapter'

const EVENT_ID_PREFIX = 'mg3_'

export const googleConnectionTestAdapter: PlatformConnectionTestAdapter = {
  provider: 'google',
  normalizeTestEventCode(value) {
    return value === undefined || value === null || value === '' ? undefined : null
  },
  async test(input) {
    if (input.provider !== 'google') throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID')
    const bindings = requireConnectionTestBindings(input)
    const pageUrl = requireProductionSiteUrl(input.siteUrl, '/attribution-test/google')
    const ids = await connectionTestEventIds('gav', input.testId)
    const externalEventIds = await Promise.all((['Contact', 'CompleteRegistration'] as const).map(event => googleEventId(ids[event])))
    const hashedEmail = await sha256Hex('attribution-test@example.invalid')
    const requestIds: string[] = []

    for (const [index, event] of (['Contact', 'CompleteRegistration'] as const).entries()) {
      const binding = bindings.get(event)!
      const result = await sendGoogleServerEvent({
        input: {
          provider: 'google',
          canonicalEvent: event,
          externalEventId: externalEventIds[index]!,
          eventTime: Math.floor(Date.now() / 1_000),
          pageUrl,
          destination: binding.serverDestination,
          matchSignals: {},
          hashedEmail,
          validateOnly: true,
        },
        config: input.publicConfig,
        serviceAccount: input.credential,
        fetcher: input.fetcher,
      })
      if (result.classification !== 'accepted' && result.classification !== 'processed') {
        if (result.classification === 'credential_invalid') {
          throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_CREDENTIAL_REJECTED')
        }
        if (result.classification === 'retryable') {
          throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_NETWORK_ERROR')
        }
        throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_DESTINATION_REJECTED')
      }
      if (result.receipt?.requestId) requestIds.push(result.receipt.requestId)
    }

    return {
      schemaVersion: 1,
      provider: 'google',
      targetValid: true,
      credentialValid: true,
      bindingsValid: true,
      testEventsSent: 0,
      externalEventIds,
      requestIds,
      checkedAt: new Date().toISOString(),
    }
  },
}

async function googleEventId(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return EVENT_ID_PREFIX + base64Url(digest)
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64Url(value: Uint8Array) {
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}
