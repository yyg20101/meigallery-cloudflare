const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

export function normalizeMediaUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return ''
  if (hasBackslashOrEncodedBackslash(url)) return ''

  if (url.startsWith('/')) {
    if (url.startsWith('//')) return ''
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
    if (parsed.username || parsed.password) return ''

    const hostname = normalizeHostname(parsed.hostname)
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return ''
    if (hostname.includes(':') || isNonPublicIpv4(hostname)) return ''

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

export function resolveAdminMediaDisplayUrl(value: unknown) {
  return normalizeMediaUrl(value)
}

export function resolveCoverPreviewUrl(coverKey: unknown, galleryId: string | null | undefined, baseURL: string) {
  const key = String(coverKey ?? '').trim()
  if (!key || !galleryId) return null

  const externalUrl = normalizeMediaUrl(key)
  if (externalUrl && !externalUrl.startsWith('/')) return externalUrl
  if (isExternalMediaLike(key)) return null

  return `${baseURL}/api/media/cover/${galleryId}`
}

export function resolveAdminCoverPreviewUrl(coverKey: unknown, galleryId: string | null | undefined, _baseURL?: string) {
  const key = String(coverKey ?? '').trim()
  if (!key || !galleryId) return null

  const externalUrl = normalizeMediaUrl(key)
  if (externalUrl && !externalUrl.startsWith('/')) return externalUrl
  if (isExternalMediaLike(key)) return null

  return `/api/admin/galleries/${galleryId}/cover`
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

function hasBackslashOrEncodedBackslash(value: string) {
  return value.includes('\\') || /%5c/i.test(value)
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function isNonPublicIpv4(hostname: string) {
  const rawParts = hostname.split('.')
  if (rawParts.length !== 4 || rawParts.some(part => !/^\d+$/.test(part))) return false
  const parts = rawParts.map(part => Number.parseInt(part, 10))
  if (parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) return false
  const [a, b, c] = parts as [number, number, number, number]
  return a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
    || a === 0
}
