const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

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

export function assertSafeExternalUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('外部地址格式无效')
  }

  if (url.protocol !== 'https:') throw new Error('仅允许 HTTPS 外部地址')

  const hostname = normalizeHostname(url.hostname)
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('不允许访问本机或内部域名')
  }

  if (hostname.includes(':') || isNonPublicIpv4(hostname)) {
    throw new Error('不允许访问本机或非公网 IP')
  }

  return url.toString()
}

export function createSafeExternalUrl(baseUrl: string, pathAndQuery: string): string {
  const base = assertSafeExternalUrl(baseUrl)
  return assertSafeExternalUrl(new URL(pathAndQuery, base).toString())
}

export function safeExternalFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(assertSafeExternalUrl(input), {
    ...init,
    redirect: 'manual',
  })
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
}
