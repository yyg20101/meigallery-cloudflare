const ALLOWED_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:', 'tg:', 'line:', 'whatsapp:'])
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

export function normalizeContactLinkUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url) return null
  if (hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) {
    throw new Error('联系方式跳转链接不能包含空白或控制字符')
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('联系方式跳转链接格式无效')
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('联系方式跳转链接只允许 https、mailto、tel 或受支持的客户端协议')
  }
  if (parsed.protocol === 'https:') {
    const hostname = normalizeHostname(parsed.hostname)
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('联系方式跳转链接不允许使用本机或内部域名')
    }
    if (hostname.includes(':') || isPrivateIpv4(hostname)) {
      throw new Error('联系方式跳转链接不允许使用本机或私网 IP')
    }
  }

  return url
}

export function safeContactLinkUrl(value: unknown) {
  try {
    return normalizeContactLinkUrl(value)
  } catch {
    return null
  }
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function hasEncodedWhitespaceOrControlCharacter(value: string) {
  return /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
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
