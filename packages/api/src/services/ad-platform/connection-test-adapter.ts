import type { AdAttributionProvider, CanonicalConversionEvent } from '@meigallery/shared'
import { CANONICAL_CONVERSION_EVENTS } from '@meigallery/shared/constants'
import { googleConnectionTestAdapter } from './adapters/google-connection-test'
import { metaConnectionTestAdapter } from './adapters/meta-connection-test'
import { tiktokConnectionTestAdapter } from './adapters/tiktok-connection-test'

export interface ConnectionTestEventBinding {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface PlatformConnectionTestInput {
  testId: string
  provider: AdAttributionProvider
  publicConfig: Record<string, string>
  eventBindings: ConnectionTestEventBinding[]
  credential: string
  testEventCode?: string
  siteUrl: string
  fetcher?: typeof fetch
}

export interface PlatformConnectionTestResult {
  schemaVersion: 1
  provider: AdAttributionProvider
  targetValid: true
  credentialValid: true
  bindingsValid: true
  testEventsSent: number
  externalEventIds: string[]
  requestIds: string[]
  checkedAt: string
}

export interface PlatformConnectionTestAdapter {
  readonly provider: AdAttributionProvider
  normalizeTestEventCode(value: unknown): string | undefined | null
  test(input: PlatformConnectionTestInput): Promise<PlatformConnectionTestResult>
}

export type PlatformConnectionTestErrorCode =
  | 'AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID'
  | 'AD_PLATFORM_CONNECTION_TEST_CODE_REQUIRED'
  | 'AD_PLATFORM_CONNECTION_TEST_CREDENTIAL_REJECTED'
  | 'AD_PLATFORM_CONNECTION_TEST_DESTINATION_REJECTED'
  | 'AD_PLATFORM_CONNECTION_TEST_NETWORK_ERROR'
  | 'AD_PLATFORM_CONNECTION_TEST_PROVIDER_REJECTED'

export class PlatformConnectionTestError extends Error {
  constructor(readonly code: PlatformConnectionTestErrorCode) {
    super(code)
    this.name = 'PlatformConnectionTestError'
  }
}

const ADAPTERS: ReadonlyMap<AdAttributionProvider, PlatformConnectionTestAdapter> = new Map([
  ['meta', metaConnectionTestAdapter],
  ['tiktok', tiktokConnectionTestAdapter],
  ['google', googleConnectionTestAdapter],
])

export function getPlatformConnectionTestAdapter(provider: unknown) {
  return typeof provider === 'string'
    ? ADAPTERS.get(provider as AdAttributionProvider) ?? null
    : null
}

export function requireConnectionTestBindings(input: PlatformConnectionTestInput) {
  const bindings = new Map(input.eventBindings.map(binding => [binding.canonicalEvent, binding]))
  if (bindings.size !== CANONICAL_CONVERSION_EVENTS.length) {
    throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID')
  }
  for (const event of CANONICAL_CONVERSION_EVENTS) {
    const binding = bindings.get(event)
    if (!binding?.enabled || !safeText(binding.browserDestination) || !safeText(binding.serverDestination)) {
      throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID')
    }
  }
  return bindings
}

export function requireProductionSiteUrl(value: string, path: string) {
  try {
    const url = new URL(path, value)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url.toString()
  }
  catch {
    throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID')
  }
}

export async function connectionTestEventIds(prefix: string, testId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${prefix}\u0000${testId}`),
  ))
  const suffix = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  return {
    Contact: `${prefix}_contact_${suffix}`,
    CompleteRegistration: `${prefix}_registration_${suffix}`,
  }
}

export async function fetchConnectionTest(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 8_000,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  }
  catch {
    throw new PlatformConnectionTestError('AD_PLATFORM_CONNECTION_TEST_NETWORK_ERROR')
  }
  finally {
    clearTimeout(timeout)
  }
}

export function safeRequestId(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : ''
}

function safeText(value: unknown) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 1_000
    && !/\p{Cc}/u.test(value)
}
