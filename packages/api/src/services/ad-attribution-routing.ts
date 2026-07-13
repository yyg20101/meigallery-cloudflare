import type { AdAttributionProvider } from '@meigallery/shared'

export type AdAttributionResolution = 'matched' | 'inherited' | 'none' | 'conflict'

export interface AdAttributionSignals {
  fbclid?: unknown
  ttclid?: unknown
  utmSource?: unknown
  trackingSourceSlug?: unknown
}

export interface AdAttributionRoutingResult {
  provider: AdAttributionProvider | null
  resolution: AdAttributionResolution
}

type TrackingSourceProviderRow = { ad_provider: string }

const FBCLID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const META_SOURCE_ALIASES = new Set(['facebook', 'facebook-ad', 'facebook-ads', 'facebookads', 'fb', 'instagram', 'instagram-ad', 'instagram-ads', 'meta', 'meta-ad', 'meta-ads'])
const TIKTOK_SOURCE_ALIASES = new Set(['tiktok', 'tiktok-ad', 'tiktok-ads', 'tiktokads', 'tt'])

export async function resolveAdAttributionRouting(
  db: Pick<D1Database, 'prepare'>,
  signals: AdAttributionSignals,
  inheritedProvider: AdAttributionProvider | null,
): Promise<AdAttributionRoutingResult> {
  const fbclid = normalizeSignal(signals.fbclid, 128)
  const ttclid = normalizeSignal(signals.ttclid, 1_000)
  const utmSource = normalizeSignal(signals.utmSource, 120)
  const trackingSourceSlug = normalizeSignal(signals.trackingSourceSlug, 120)
  const hasExplicitSignals = [
    signals.fbclid,
    signals.ttclid,
    signals.utmSource,
    signals.trackingSourceSlug,
  ].some(hasExplicitSignal)

  if (!hasExplicitSignals) {
    return inheritedProvider
      ? { provider: inheritedProvider, resolution: 'inherited' }
      : { provider: null, resolution: 'none' }
  }

  const providers = new Set<AdAttributionProvider>()
  if (FBCLID_PATTERN.test(fbclid)) providers.add('meta')
  if (isValidTikTokClickId(ttclid)) providers.add('tiktok')

  const aliasProvider = providerFromAlias(utmSource)
  if (aliasProvider) providers.add(aliasProvider)

  const managedProviders = await readManagedSourceProviders(db, trackingSourceSlug, utmSource)
  for (const provider of managedProviders) {
    if (provider) providers.add(provider)
  }

  if (providers.size > 1) return { provider: null, resolution: 'conflict' }
  const [provider] = providers
  return provider
    ? { provider, resolution: 'matched' }
    : { provider: null, resolution: 'none' }
}

async function readManagedSourceProviders(
  db: Pick<D1Database, 'prepare'>,
  trackingSourceSlug: string,
  utmSource: string,
): Promise<AdAttributionProvider[]> {
  if (!trackingSourceSlug && !utmSource) return []
  const rows = await db.prepare(`
    SELECT DISTINCT ad_provider
    FROM analytics_tracking_sources
    WHERE status = 'active'
      AND ((? <> '' AND slug = ?) OR (? <> '' AND utm_source = ?))
  `).bind(
    trackingSourceSlug,
    trackingSourceSlug,
    utmSource,
    utmSource,
  ).all<TrackingSourceProviderRow>()
  return rows.results
    .map(row => normalizeProvider(row.ad_provider))
    .filter((provider): provider is AdAttributionProvider => provider !== null)
}

function providerFromAlias(value: string): AdAttributionProvider | null {
  const normalized = value.toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-')
  if (META_SOURCE_ALIASES.has(normalized)) return 'meta'
  if (TIKTOK_SOURCE_ALIASES.has(normalized)) return 'tiktok'
  return null
}

function normalizeProvider(value: unknown): AdAttributionProvider | null {
  return value === 'meta' || value === 'tiktok' ? value : null
}

function normalizeSignal(value: unknown, maxLength: number) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || /\p{Cc}/u.test(raw)) return ''
  const normalized = raw.trim()
  return normalized.length <= maxLength ? normalized : ''
}

function hasExplicitSignal(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length === 0 || hasExplicitSignal(value[0])
  return typeof value === 'string' ? value.length > 0 : true
}

function isValidTikTokClickId(value: string) {
  return value.length > 0 && value.length <= 1_000 && !/\p{Cc}/u.test(value)
}
