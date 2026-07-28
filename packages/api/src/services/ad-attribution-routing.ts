import type { AdAttributionProvider } from '@meigallery/shared'
import { ATTRIBUTION_LIMITS } from '@meigallery/shared/constants'
import type { AdAttributionSource } from '../utils/ad-attribution-context'

export type AdAttributionResolution = 'matched' | 'inherited' | 'none' | 'conflict'

export interface AdAttributionSignals {
  fbclid?: unknown
  ttclid?: unknown
  gclid?: unknown
  gbraid?: unknown
  wbraid?: unknown
  trackingSourceSlug?: unknown
}

export interface AdAttributionRoutingResult {
  provider: AdAttributionProvider | null
  resolution: AdAttributionResolution
  source: AdAttributionSource | null
  identifiers: Record<string, string>
}

type TrackingSourceProviderRow = { ad_provider: string }

export interface AdAttributionSourceInput {
  clickIdentifiers: Partial<Record<
    AdAttributionProvider,
    Record<string, string>
  >>
  managedProvider: AdAttributionProvider | null
  inheritedProvider: AdAttributionProvider | null
}

export async function resolveAdAttributionRouting(
  db: Pick<D1Database, 'prepare'>,
  signals: AdAttributionSignals,
  inheritedProvider: AdAttributionProvider | null,
): Promise<AdAttributionRoutingResult> {
  const normalized = normalizeSignals(signals)
  const managedProvider = await resolveManagedLinkProvider(db, normalized)
  const clickIdentifiers = buildClickIdentifiers(normalized)
  const hasValidClickSignal = Object.values(clickIdentifiers).some(Boolean)

  if (!hasValidClickSignal && !managedProvider && normalized.hasInvalidSignal) {
    return conflict()
  }
  if (!hasValidClickSignal
    && !managedProvider
    && normalized.trackingSourceProvided) {
    return conflict()
  }

  return resolveAdAttributionSource({
    clickIdentifiers,
    managedProvider,
    inheritedProvider,
  })
}

export function resolveAdAttributionSource(
  input: AdAttributionSourceInput,
): AdAttributionRoutingResult {
  const clickProviders = Object.entries(input.clickIdentifiers)
    .filter((entry): entry is [
      AdAttributionProvider,
      Record<string, string>,
    ] => Boolean(entry[1] && Object.keys(entry[1]).length > 0))
  const explicitProviders = new Set<AdAttributionProvider>([
    ...clickProviders.map(([provider]) => provider),
    ...(input.managedProvider ? [input.managedProvider] : []),
  ])
  if (explicitProviders.size > 1) return conflict()

  const click = clickProviders[0]
  if (click) return matched(click[0], 'click_id', click[1])
  if (input.managedProvider) {
    return matched(input.managedProvider, 'managed_link')
  }
  return input.inheritedProvider
    ? inherited(input.inheritedProvider)
    : none()
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
  const fbclid = normalizeOptionalSignal(signals.fbclid, ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
  const ttclid = normalizeOptionalSignal(signals.ttclid, ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
  const gclid = normalizeOptionalSignal(signals.gclid, ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
  const gbraid = normalizeOptionalSignal(signals.gbraid, ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
  const wbraid = normalizeOptionalSignal(signals.wbraid, ATTRIBUTION_LIMITS.CLICK_ID_MAX_LENGTH)
  const trackingSource = normalizeOptionalSignal(signals.trackingSourceSlug, 120)
  const trackingSourceSlug = trackingSource.provided ? normalizeSlug(trackingSource.value) : ''
  return {
    fbclid: fbclid.value,
    ttclid: ttclid.value,
    gclid: gclid.value,
    gbraid: gbraid.value,
    wbraid: wbraid.value,
    trackingSourceSlug,
    trackingSourceProvided: trackingSource.provided,
    hasInvalidSignal: [
      fbclid, ttclid, gclid, gbraid, wbraid, trackingSource,
    ].some(item => item.invalid)
      || (trackingSource.provided && !trackingSourceSlug),
  }
}

function buildClickIdentifiers(
  signals: ReturnType<typeof normalizeSignals>,
): AdAttributionSourceInput['clickIdentifiers'] {
  return {
    ...(signals.fbclid ? { meta: { fbclid: signals.fbclid } } : {}),
    ...(signals.ttclid ? { tiktok: { ttclid: signals.ttclid } } : {}),
    ...(
      signals.gclid || signals.gbraid || signals.wbraid
        ? {
            google: Object.fromEntries(Object.entries({
              gclid: signals.gclid,
              gbraid: signals.gbraid,
              wbraid: signals.wbraid,
            }).filter((entry): entry is [string, string] => Boolean(entry[1]))),
          }
        : {}
    ),
  }
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
