const ALLOWED_API_PROXY_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'cf-connecting-ip',
  'content-type',
  'cookie',
  'user-agent',
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

export function shouldForwardApiProxyResponseHeader(name: string): boolean {
  return ALLOWED_API_PROXY_RESPONSE_HEADERS.has(normalizeHeaderName(name))
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase()
}
