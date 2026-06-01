const ALLOWED_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:', 'tg:', 'line:', 'whatsapp:'])
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

export function normalizeContactActionUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return null

  try {
    const parsed = new URL(url)
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null
    if (parsed.protocol === 'https:' && !isPublicHostname(parsed.hostname)) return null
    return url
  } catch {
    return null
  }
}

export function normalizeContactQrCodeUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return null

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) return null
    try {
      const parsed = new URL(url, 'https://meigallery.local')
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      return null
    }
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !isPublicHostname(parsed.hostname)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function isPublicHostname(hostname: string) {
  const normalized = normalizeHostname(hostname)
  if (BLOCKED_HOSTS.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return false
  if (normalized.includes(':') || isPrivateIpv4(normalized)) return false
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
