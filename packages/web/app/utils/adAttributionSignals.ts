export type BrowserAdAttributionSignals = {
  fbclid: string
  ttclid: string
  gclid: string
  gbraid: string
  wbraid: string
  trackingSourceSlug: string
}

export function readBrowserAdAttributionSignals(
  query: Record<string, unknown>,
): BrowserAdAttributionSignals {
  return {
    fbclid: queryValue(query.fbclid),
    ttclid: queryValue(query.ttclid),
    gclid: queryValue(query.gclid),
    gbraid: queryValue(query.gbraid),
    wbraid: queryValue(query.wbraid),
    trackingSourceSlug: queryValue(query.mg_source),
  }
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return ''
  const normalized = raw.trim()
  return normalized.length > 1_000 ? normalized.slice(0, 1_001) : normalized
}
