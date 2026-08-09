const ALLOWED_API_PROXY_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'cf-connecting-ip',
  'cf-ipcountry',
  'content-type',
  'cookie',
  'idempotency-key',
  'sec-gpc',
  'user-agent',
  'x-audit-download-ticket',
  'x-audit-step-up',
  'x-forwarded-for',
  'x-real-ip',
])

const ALLOWED_API_PROXY_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-disposition',
  'content-type',
  'etag',
  'location',
  'retry-after',
  'set-cookie',
  'x-content-type-options',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
])

export function filterApiProxyRequestHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = normalizeHeaderName(name)
    const normalizedValue = value?.trim()
    if (!normalizedValue || !ALLOWED_API_PROXY_REQUEST_HEADERS.has(normalizedName)) continue
    filtered[normalizedName] = normalizedValue
  }

  return filtered
}

export function resolveTrustedApiProxyOrigin(
  headers: Record<string, string | undefined>,
  configuredSiteUrl: string,
): string {
  const origin = normalizeOrigin(readHeader(headers, 'origin'))
  if (!origin) return ''

  try {
    const originUrl = new URL(origin)
    const requestHost = readHeader(headers, 'host').trim().toLowerCase()
    if (requestHost && originUrl.host.toLowerCase() === requestHost) return origin
    return origin === normalizeOrigin(configuredSiteUrl) ? origin : ''
  }
  catch {
    return ''
  }
}

export function shouldForwardApiProxyResponseHeader(name: string): boolean {
  return ALLOWED_API_PROXY_RESPONSE_HEADERS.has(normalizeHeaderName(name))
}

export function apiProxyResponseHeaderEntries(headers: Headers): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  headers.forEach((value, name) => {
    const normalizedName = normalizeHeaderName(name)
    if (normalizedName === 'set-cookie' || !shouldForwardApiProxyResponseHeader(normalizedName)) return
    entries.push([normalizedName, value])
  })

  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const setCookies = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : [headers.get('set-cookie')].filter((value): value is string => Boolean(value))
  for (const cookie of setCookies) entries.push(['set-cookie', cookie])
  return entries
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase()
}

function readHeader(headers: Record<string, string | undefined>, target: string): string {
  const entry = Object.entries(headers).find(([name]) => normalizeHeaderName(name) === target)
  return entry?.[1] ?? ''
}

function normalizeOrigin(value: unknown): string {
  try {
    return new URL(String(value || '')).origin
  }
  catch {
    return ''
  }
}
