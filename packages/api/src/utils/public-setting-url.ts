const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

export function normalizePublicSettingUrl(value: unknown, fieldLabel: string) {
  const url = String(value ?? '').trim()
  if (!url) return ''
  if (hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) {
    throw new Error(`${fieldLabel}不能包含空白或控制字符`)
  }

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) {
      throw new Error(`${fieldLabel}只允许站内相对路径或 https 链接`)
    }
    try {
      const parsed = new URL(url, 'https://meigallery.local')
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      throw new Error(`${fieldLabel}格式无效`)
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${fieldLabel}格式无效`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${fieldLabel}只允许站内相对路径或 https 链接`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`${fieldLabel}不允许使用本机或内部域名`)
  }
  if (hostname.includes(':') || isPrivateIpv4(hostname)) {
    throw new Error(`${fieldLabel}不允许使用本机或私网 IP`)
  }

  return parsed.toString()
}

export function safePublicSettingUrl(value: unknown, fieldLabel: string) {
  try {
    return normalizePublicSettingUrl(value, fieldLabel)
  } catch {
    return ''
  }
}

export function normalizeInternalPathSetting(value: unknown, fieldLabel: string) {
  const url = String(value ?? '').trim()
  if (!url) return ''
  if (hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) {
    throw new Error(`${fieldLabel}不能包含空白或控制字符`)
  }
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) {
    throw new Error(`${fieldLabel}只允许站内相对路径`)
  }
  try {
    const parsed = new URL(url, 'https://meigallery.local')
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    throw new Error(`${fieldLabel}格式无效`)
  }
}

export function safeInternalPathSetting(value: unknown, fieldLabel: string) {
  try {
    return normalizeInternalPathSetting(value, fieldLabel)
  } catch {
    return ''
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
