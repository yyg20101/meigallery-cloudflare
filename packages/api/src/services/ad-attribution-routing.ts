import type { AdAttributionProvider } from '@meigallery/shared'
import type { AdAttributionSource } from '../utils/ad-attribution-context'

export type AdAttributionResolution = 'matched' | 'inherited' | 'none' | 'conflict'

export interface AdAttributionSignals {
  fbclid?: unknown
  ttclid?: unknown
  gclid?: unknown
  gbraid?: unknown
  wbraid?: unknown
  utmSource?: unknown
  trackingSourceSlug?: unknown
  managedLinkToken?: unknown
}

export interface AdAttributionRoutingResult {
  provider: AdAttributionProvider | null
  resolution: AdAttributionResolution
  source: AdAttributionSource | null
  identifiers: Record<string, string>
}

interface ManagedLinkClaims {
  version: 1
  trackingSourceSlug: string
  provider: AdAttributionProvider
  issuedAt: number
  expiresAt: number
}

type TrackingSourceProviderRow = { ad_provider: string }

const CLICK_ID_MAX_LENGTH = 1_000
const MANAGED_LINK_TTL_SECONDS = 30 * 24 * 60 * 60
const MANAGED_LINK_PREFIX = 'meigallery:managed-ad-link:v1:'
const SIGNATURE_BYTES = 32
const META_SOURCE_ALIASES = new Set(['facebook-ad', 'facebook-ads', 'facebookads', 'instagram-ad', 'instagram-ads', 'meta-ad', 'meta-ads'])
const TIKTOK_SOURCE_ALIASES = new Set(['tiktok-ad', 'tiktok-ads', 'tiktokads'])
const GOOGLE_SOURCE_ALIASES = new Set(['google-ad', 'google-ads', 'googleads', 'adwords'])

export async function resolveAdAttributionRouting(
  db: Pick<D1Database, 'prepare'>,
  signals: AdAttributionSignals,
  inheritedProvider: AdAttributionProvider | null,
  options: { managedLinkSecret?: string; nowSeconds?: number } = {},
): Promise<AdAttributionRoutingResult> {
  const normalized = normalizeSignals(signals)

  const clickProviders = new Map<AdAttributionProvider, Record<string, string>>()
  addClickIdentifier(clickProviders, 'meta', 'fbclid', normalized.fbclid)
  addClickIdentifier(clickProviders, 'tiktok', 'ttclid', normalized.ttclid)
  addClickIdentifier(clickProviders, 'google', 'gclid', normalized.gclid)
  addClickIdentifier(clickProviders, 'google', 'gbraid', normalized.gbraid)
  addClickIdentifier(clickProviders, 'google', 'wbraid', normalized.wbraid)
  if (clickProviders.size > 1) return conflict()
  const [click] = clickProviders
  if (click) return matched(click[0], 'click_id', click[1])

  const managed = await resolveManagedLinkProvider(db, normalized, options)
  if (managed) return matched(managed, 'managed_link')

  const aliasProvider = providerFromAlias(normalized.utmSource)
  if (aliasProvider) return matched(aliasProvider, 'utm_alias')
  return inheritedProvider ? inherited(inheritedProvider) : none()
}

export async function createManagedLinkToken(
  secret: string,
  input: Pick<ManagedLinkClaims, 'trackingSourceSlug' | 'provider'> & { nowSeconds?: number },
) {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const claims: ManagedLinkClaims = {
    version: 1,
    trackingSourceSlug: normalizeSlug(input.trackingSourceSlug),
    provider: input.provider,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + MANAGED_LINK_TTL_SECONDS,
  }
  if (!isManagedLinkClaims(claims, nowSeconds)) throw new Error('广告投放链接无效')
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
  return `${payload}.${base64UrlEncode(await sign(secret, payload))}`
}

async function resolveManagedLinkProvider(
  db: Pick<D1Database, 'prepare'>,
  signals: ReturnType<typeof normalizeSignals>,
  options: { managedLinkSecret?: string; nowSeconds?: number },
) {
  if (!signals.managedLinkToken || !signals.trackingSourceSlug || !options.managedLinkSecret) return null
  const claims = await verifyManagedLinkToken(
    options.managedLinkSecret,
    signals.managedLinkToken,
    options.nowSeconds ?? Math.floor(Date.now() / 1_000),
  )
  if (!claims || claims.trackingSourceSlug !== signals.trackingSourceSlug) return null
  const row = await db.prepare(`
    SELECT ad_provider
    FROM analytics_tracking_sources
    WHERE status = 'active' AND slug = ? AND ad_provider = ?
    LIMIT 1
  `).bind(claims.trackingSourceSlug, claims.provider).all<TrackingSourceProviderRow>()
  return row.results.some(item => item.ad_provider === claims.provider) ? claims.provider : null
}

async function verifyManagedLinkToken(secret: string, token: string, nowSeconds: number): Promise<ManagedLinkClaims | null> {
  const [payload, encodedSignature, extra] = token.split('.')
  if (!payload || !encodedSignature || extra !== undefined) return null
  try {
    const received = base64UrlDecode(encodedSignature)
    const expected = await sign(secret, payload)
    if (!constantTimeMatch(expected, received)) return null
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as unknown
    return isManagedLinkClaims(claims, nowSeconds) ? claims : null
  }
  catch {
    return null
  }
}

function normalizeSignals(signals: AdAttributionSignals) {
  const fbclid = normalizeClickId(signals.fbclid, 128)
  const ttclid = normalizeClickId(signals.ttclid, CLICK_ID_MAX_LENGTH)
  const gclid = normalizeClickId(signals.gclid, CLICK_ID_MAX_LENGTH)
  const gbraid = normalizeClickId(signals.gbraid, CLICK_ID_MAX_LENGTH)
  const wbraid = normalizeClickId(signals.wbraid, CLICK_ID_MAX_LENGTH)
  const utmSource = normalizeSignal(signals.utmSource, 120)
  const trackingSourceSlug = normalizeSlug(normalizeSignal(signals.trackingSourceSlug, 120))
  const managedLinkToken = normalizeSignal(signals.managedLinkToken, 4_096)
  return {
    fbclid, ttclid, gclid, gbraid, wbraid, utmSource, trackingSourceSlug, managedLinkToken,
  }
}

function addClickIdentifier(
  providers: Map<AdAttributionProvider, Record<string, string>>,
  provider: AdAttributionProvider,
  key: string,
  value: string,
) {
  if (!value) return
  providers.set(provider, { ...(providers.get(provider) ?? {}), [key]: value })
}

function matched(provider: AdAttributionProvider, source: AdAttributionSource, identifiers: Record<string, string> = {}) {
  return { provider, resolution: 'matched' as const, source, identifiers }
}

function inherited(provider: AdAttributionProvider) {
  return { provider, resolution: 'inherited' as const, source: null, identifiers: {} }
}

function none() {
  return { provider: null, resolution: 'none' as const, source: null, identifiers: {} }
}

function conflict() {
  return { provider: null, resolution: 'conflict' as const, source: null, identifiers: {} }
}

function providerFromAlias(value: string): AdAttributionProvider | null {
  const normalized = value.toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-')
  if (META_SOURCE_ALIASES.has(normalized)) return 'meta'
  if (TIKTOK_SOURCE_ALIASES.has(normalized)) return 'tiktok'
  if (GOOGLE_SOURCE_ALIASES.has(normalized)) return 'google'
  return null
}

function normalizeClickId(value: unknown, maxLength: number) {
  return normalizeSignal(value, maxLength)
}

function normalizeSignal(value: unknown, maxLength: number) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || /\p{Cc}/u.test(raw)) return ''
  const normalized = raw.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : ''
}

function normalizeSlug(value: string) {
  return /^[a-z0-9][a-z0-9_-]{1,58}[a-z0-9]$/.test(value) ? value : ''
}

function isManagedLinkClaims(value: unknown, nowSeconds: number): value is ManagedLinkClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const claims = value as Partial<ManagedLinkClaims>
  return Object.keys(value).length === 5
    && claims.version === 1
    && normalizeSlug(String(claims.trackingSourceSlug || '')) === claims.trackingSourceSlug
    && (claims.provider === 'meta' || claims.provider === 'tiktok' || claims.provider === 'google')
    && Number.isInteger(claims.issuedAt)
    && Number.isInteger(claims.expiresAt)
    && Number(claims.issuedAt) <= nowSeconds
    && Number(claims.expiresAt) > nowSeconds
    && Number(claims.expiresAt) - Number(claims.issuedAt) === MANAGED_LINK_TTL_SECONDS
}

async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${MANAGED_LINK_PREFIX}${payload}`)))
}

function constantTimeMatch(expected: Uint8Array, received: Uint8Array) {
  let difference = expected.length === SIGNATURE_BYTES && received.length === SIGNATURE_BYTES ? 0 : 1
  for (let index = 0; index < SIGNATURE_BYTES; index += 1) difference |= (expected[index] ?? 0) ^ (received[index] ?? 0)
  return difference === 0
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('invalid base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}
