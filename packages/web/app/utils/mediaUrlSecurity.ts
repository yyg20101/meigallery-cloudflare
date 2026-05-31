const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

export function normalizeMediaUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return ''

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) return ''
    try {
      const parsed = new URL(url, 'https://meigallery.local')
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      return ''
    }
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return ''

    const hostname = parsed.hostname.toLowerCase()
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return ''
    if (hostname.includes(':') || isPrivateIpv4(hostname)) return ''

    return parsed.toString()
  } catch {
    return ''
  }
}

export function resolveMediaDisplayUrl(value: unknown, baseURL: string) {
  const url = normalizeMediaUrl(value)
  if (!url) return ''
  return url.startsWith('/') ? `${baseURL}${url}` : url
}

export function resolveCoverPreviewUrl(coverKey: unknown, galleryId: string | null | undefined, baseURL: string) {
  const key = String(coverKey ?? '').trim()
  if (!key || !galleryId) return null

  const externalUrl = normalizeMediaUrl(key)
  if (externalUrl && !externalUrl.startsWith('/')) return externalUrl
  if (isExternalMediaLike(key)) return null

  return `${baseURL}/api/media/cover/${galleryId}`
}

function isExternalMediaLike(value: string) {
  try {
    const protocol = new URL(value).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return /^https?:/i.test(value)
  }
}

function hasEncodedWhitespaceOrControlCharacter(value: string) {
  return /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
}
