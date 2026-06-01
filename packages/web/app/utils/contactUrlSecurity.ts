const ALLOWED_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:', 'tg:', 'line:', 'whatsapp:'])
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

export function normalizeContactActionUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return null
  if (hasBackslashOrEncodedBackslash(url)) return null

  try {
    const parsed = new URL(url)
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null
    if (parsed.protocol === 'https:') {
      if (parsed.username || parsed.password || !isPublicHostname(parsed.hostname)) return null
      return parsed.toString()
    }
    return url
  } catch {
    return null
  }
}

export function normalizeContactQrCodeUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return null
  if (hasBackslashOrEncodedBackslash(url)) return null

  if (url.startsWith('/')) {
    if (url.startsWith('//')) return null
    try {
      const parsed = new URL(url, 'https://meigallery.local')
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      return null
    }
  }

  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return null
    if (parsed.protocol !== 'https:' || !isPublicHostname(parsed.hostname)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function isPublicHostname(hostname: string) {
  const normalized = normalizeHostname(hostname)
  if (BLOCKED_HOSTS.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return false
  if (normalized.includes(':') || isNonPublicIpv4(normalized)) return false
  return true
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
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
