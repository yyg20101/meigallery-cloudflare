import type { AdAttributionProvider } from '@meigallery/shared'
import {
  decryptAttributionValue,
  encryptAttributionValue,
  type AttributionCryptoKeys,
  type AttributionEncryptedEnvelope,
} from './attribution-crypto'

export const AD_ATTRIBUTION_CONTEXT_TTL_SECONDS = 30 * 24 * 60 * 60

export type AdAttributionSource = 'click_id' | 'managed_link'

export interface AdAttributionContext {
  version: 1
  contextId: string
  provider: AdAttributionProvider
  source: AdAttributionSource
  identifiers: Record<string, string>
  issuedAt: number
  expiresAt: number
}

const CONTEXT_ID_PATTERN = /^ctx_[0-9a-f]{32}$/
const AAD = {
  purpose: 'context' as const,
  provider: 'ad-attribution-context',
  subjectId: 'browser-cookie',
  revision: '1',
}
const PROVIDER_IDENTIFIERS: Record<AdAttributionProvider, ReadonlySet<string>> = {
  meta: new Set(['fbclid']),
  tiktok: new Set(['ttclid']),
  google: new Set(['gclid', 'gbraid', 'wbraid']),
}

export function createAdAttributionContext(input: {
  provider: AdAttributionProvider
  source: AdAttributionSource
  identifiers: Record<string, string>
  contextId?: string
  nowSeconds?: number
}): AdAttributionContext {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const context: AdAttributionContext = {
    version: 1,
    contextId: input.contextId ?? createContextId(),
    provider: input.provider,
    source: input.source,
    identifiers: { ...input.identifiers },
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
  }
  if (!isValidContext(context, nowSeconds, false)) throw new Error('广告归因上下文无效')
  return context
}

export async function sealAdAttributionContext(
  keys: AttributionCryptoKeys,
  context: AdAttributionContext,
): Promise<string> {
  if (!isValidContext(context, context.issuedAt, false)) throw new Error('广告归因上下文无效')
  const envelope = await encryptAttributionValue({
    keys,
    aad: AAD,
    plaintext: JSON.stringify(context),
  })
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))
}

export async function resolveTrustedAdAttributionContext(
  keys: AttributionCryptoKeys,
  encrypted: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<AdAttributionContext | null> {
  if (typeof encrypted !== 'string' || encrypted.length === 0 || encrypted.length > 12_000) return null
  try {
    const envelope = JSON.parse(new TextDecoder().decode(decodeBase64Url(encrypted))) as AttributionEncryptedEnvelope
    const plaintext = await decryptAttributionValue({ keys, aad: AAD, envelope })
    const context = JSON.parse(plaintext) as unknown
    return isValidContext(context, nowSeconds, true) ? context : null
  }
  catch {
    return null
  }
}

function isValidContext(value: unknown, nowSeconds: number, checkExpiry: boolean): value is AdAttributionContext {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'version', 'contextId', 'provider', 'source', 'identifiers', 'issuedAt', 'expiresAt',
  ])) return false
  const context = value as Partial<AdAttributionContext>
  if (context.version !== 1
    || !CONTEXT_ID_PATTERN.test(String(context.contextId || ''))
    || !isProvider(context.provider)
    || !isSource(context.source)
    || !Number.isInteger(context.issuedAt)
    || !Number.isInteger(context.expiresAt)
    || Number(context.expiresAt) - Number(context.issuedAt) !== AD_ATTRIBUTION_CONTEXT_TTL_SECONDS
    || Number(context.issuedAt) > nowSeconds
    || (checkExpiry && Number(context.expiresAt) <= nowSeconds)
    || !validIdentifiers(context.provider, context.source, context.identifiers)) return false
  return true
}

function validIdentifiers(provider: AdAttributionProvider, source: AdAttributionSource, value: unknown) {
  if (!isPlainRecord(value)) return false
  const allowed = PROVIDER_IDENTIFIERS[provider]
  const identifiers = Object.entries(value)
  return (source !== 'click_id' || identifiers.length > 0) && identifiers.every(([key, identifier]) => (
    allowed.has(key)
    && typeof identifier === 'string'
    && identifier.length > 0
    && identifier.length <= 1_000
    && !/\p{Cc}/u.test(identifier)
  ))
}

function createContextId() {
  return `ctx_${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function isProvider(value: unknown): value is AdAttributionProvider {
  return value === 'meta' || value === 'tiktok' || value === 'google'
}

function isSource(value: unknown): value is AdAttributionSource {
  return value === 'click_id' || value === 'managed_link'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: object, keys: string[]) {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('invalid base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}
