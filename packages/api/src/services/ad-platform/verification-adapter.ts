import type { AdAttributionProvider, CanonicalConversionEvent } from '@meigallery/shared'
import { googleVerificationAdapter } from './adapters/google-verification'
import { metaVerificationAdapter } from './adapters/meta-verification'
import { tiktokVerificationAdapter } from './adapters/tiktok-verification'

export interface VerificationEventBinding {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface PlatformVerificationAdapterInput {
  verificationId: string
  provider: AdAttributionProvider
  publicConfig: Record<string, string>
  eventBindings: VerificationEventBinding[]
  credential: string
  testEventCode?: string
  siteUrl: string
  fetcher?: typeof fetch
}

export interface PlatformAutomaticVerificationEvidence {
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

export interface PlatformVerificationAdapter {
  readonly provider: AdAttributionProvider
  normalizeTestEventCode(value: unknown): string | undefined | null
  verify(input: PlatformVerificationAdapterInput): Promise<PlatformAutomaticVerificationEvidence>
}

export type PlatformVerificationErrorCode =
  | 'AD_PLATFORM_VERIFICATION_INPUT_INVALID'
  | 'AD_PLATFORM_VERIFICATION_TEST_CODE_REQUIRED'
  | 'AD_PLATFORM_VERIFICATION_CREDENTIAL_REJECTED'
  | 'AD_PLATFORM_VERIFICATION_DESTINATION_REJECTED'
  | 'AD_PLATFORM_VERIFICATION_NETWORK_ERROR'
  | 'AD_PLATFORM_VERIFICATION_PROVIDER_REJECTED'

export class PlatformVerificationError extends Error {
  constructor(readonly code: PlatformVerificationErrorCode) {
    super(code)
    this.name = 'PlatformVerificationError'
  }
}

const ADAPTERS: ReadonlyMap<AdAttributionProvider, PlatformVerificationAdapter> = new Map([
  ['meta', metaVerificationAdapter],
  ['tiktok', tiktokVerificationAdapter],
  ['google', googleVerificationAdapter],
])

export function getPlatformVerificationAdapter(provider: unknown) {
  return typeof provider === 'string'
    ? ADAPTERS.get(provider as AdAttributionProvider) ?? null
    : null
}

export function requireVerificationBindings(input: PlatformVerificationAdapterInput) {
  const bindings = new Map(input.eventBindings.map(binding => [binding.canonicalEvent, binding]))
  if (bindings.size !== 2) throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
  for (const event of ['Contact', 'CompleteRegistration'] as const) {
    const binding = bindings.get(event)
    if (!binding?.enabled || !safeText(binding.browserDestination) || !safeText(binding.serverDestination)) {
      throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
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
    throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_INPUT_INVALID')
  }
}

export async function verificationEventIds(prefix: string, verificationId: string) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${prefix}\u0000${verificationId}`),
  ))
  const suffix = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  return {
    Contact: `${prefix}_contact_${suffix}`,
    CompleteRegistration: `${prefix}_registration_${suffix}`,
  }
}

export async function fetchVerification(
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
    throw new PlatformVerificationError('AD_PLATFORM_VERIFICATION_NETWORK_ERROR')
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
