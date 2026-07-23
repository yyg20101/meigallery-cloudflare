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
}

export interface AdAttributionRoutingResult {
  provider: AdAttributionProvider | null
  resolution: AdAttributionResolution
  source: AdAttributionSource | null
  identifiers: Record<string, string>
}

type TrackingSourceProviderRow = { ad_provider: string }

const CLICK_ID_MAX_LENGTH = 1_000
const META_SOURCE_ALIASES = new Set(['facebook-ad', 'facebook-ads', 'facebookads', 'instagram-ad', 'instagram-ads', 'meta-ad', 'meta-ads'])
const TIKTOK_SOURCE_ALIASES = new Set(['tiktok-ad', 'tiktok-ads', 'tiktokads'])
const GOOGLE_SOURCE_ALIASES = new Set(['google-ad', 'google-ads', 'googleads', 'adwords'])

export async function resolveAdAttributionRouting(
  db: Pick<D1Database, 'prepare'>,
  signals: AdAttributionSignals,
  inheritedProvider: AdAttributionProvider | null,
): Promise<AdAttributionRoutingResult> {
  const normalized = normalizeSignals(signals)
  if (normalized.invalid) return inheritedProvider ? inherited(inheritedProvider) : none()

  const clickProviders = new Map<AdAttributionProvider, Record<string, string>>()
  addClickIdentifier(clickProviders, 'meta', 'fbclid', normalized.fbclid)
  addClickIdentifier(clickProviders, 'tiktok', 'ttclid', normalized.ttclid)
  addClickIdentifier(clickProviders, 'google', 'gclid', normalized.gclid)
  addClickIdentifier(clickProviders, 'google', 'gbraid', normalized.gbraid)
  addClickIdentifier(clickProviders, 'google', 'wbraid', normalized.wbraid)

  const managed = await resolveManagedLinkProvider(db, normalized)
  const aliasProvider = providerFromAlias(normalized.utmSource)
  const explicitProviders = new Set<AdAttributionProvider>([
    ...clickProviders.keys(),
    ...(managed ? [managed] : []),
    ...(aliasProvider ? [aliasProvider] : []),
  ])
  if (explicitProviders.size > 1) return conflict()

  const [click] = clickProviders
  if (click) return matched(click[0], 'click_id', click[1])
  if (managed) return matched(managed, 'managed_link')
  if (aliasProvider) return matched(aliasProvider, 'utm_alias')
  return inheritedProvider ? inherited(inheritedProvider) : none()
}

async function resolveManagedLinkProvider(
  db: Pick<D1Database, 'prepare'>,
  signals: ReturnType<typeof normalizeSignals>,
) {
  if (!signals.trackingSourceSlug) return null
  const row = await db.prepare(`
    SELECT ad_provider
    FROM analytics_tracking_sources
    WHERE status = 'active'
      AND channel = 'ad'
      AND slug = ?
      AND ad_provider IN ('meta', 'tiktok', 'google')
    LIMIT 1
  `).bind(signals.trackingSourceSlug).all<TrackingSourceProviderRow>()
  return normalizeProvider(row.results[0]?.ad_provider)
}

function normalizeSignals(signals: AdAttributionSignals) {
  const fbclid = normalizeOptionalSignal(signals.fbclid, 128)
  const ttclid = normalizeOptionalSignal(signals.ttclid, CLICK_ID_MAX_LENGTH)
  const gclid = normalizeOptionalSignal(signals.gclid, CLICK_ID_MAX_LENGTH)
  const gbraid = normalizeOptionalSignal(signals.gbraid, CLICK_ID_MAX_LENGTH)
  const wbraid = normalizeOptionalSignal(signals.wbraid, CLICK_ID_MAX_LENGTH)
  const utmSource = normalizeOptionalSignal(signals.utmSource, 120)
  const trackingSource = normalizeOptionalSignal(signals.trackingSourceSlug, 120)
  const trackingSourceSlug = trackingSource.provided ? normalizeSlug(trackingSource.value) : ''
  return {
    fbclid: fbclid.value,
    ttclid: ttclid.value,
    gclid: gclid.value,
    gbraid: gbraid.value,
    wbraid: wbraid.value,
    utmSource: utmSource.value,
    trackingSourceSlug,
    invalid: [
      fbclid, ttclid, gclid, gbraid, wbraid, utmSource, trackingSource,
    ].some(item => item.invalid)
      || (trackingSource.provided && !trackingSourceSlug),
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

function normalizeOptionalSignal(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === '') {
    return { value: '', provided: false, invalid: false }
  }
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) {
    return { value: '', provided: true, invalid: true }
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    return { value: '', provided: true, invalid: true }
  }
  return { value: normalized, provided: true, invalid: false }
}

function normalizeSlug(value: string) {
  return /^[a-z0-9][a-z0-9_-]{1,58}[a-z0-9]$/.test(value) ? value : ''
}

function normalizeProvider(value: unknown): AdAttributionProvider | null {
  return value === 'meta' || value === 'tiktok' || value === 'google' ? value : null
}
