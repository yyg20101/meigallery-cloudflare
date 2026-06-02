const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])
const BLOCKED_CREDENTIAL_PARAM_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authtoken',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'jwt',
  'keypairid',
  'password',
  'passwd',
  'pwd',
  'refreshtoken',
  'secret',
  'securitytoken',
  'session',
  'sessionid',
  'sig',
  'signature',
  'signed',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
])

export function normalizePublicSettingUrl(value: unknown, fieldLabel: string) {
  const url = String(value ?? '').trim()
  if (!url) return ''
  if (hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) {
    throw new Error(`${fieldLabel}不能包含空白或控制字符`)
  }
  if (hasBackslashOrEncodedBackslash(url)) {
    throw new Error(`${fieldLabel}不能包含反斜杠`)
  }

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) {
      throw new Error(`${fieldLabel}只允许站内相对路径或 https 链接`)
    }
    let parsed: URL
    try {
      parsed = new URL(url, 'https://meigallery.local')
    } catch {
      throw new Error(`${fieldLabel}格式无效`)
    }
    assertNoCredentialUrlParams(parsed, fieldLabel)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
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
  if (parsed.username || parsed.password) {
    throw new Error(`${fieldLabel}不允许包含用户名或密码`)
  }

  const hostname = normalizeHostname(parsed.hostname)
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`${fieldLabel}不允许使用本机或内部域名`)
  }
  if (hostname.includes(':') || isNonPublicIpv4(hostname)) {
    throw new Error(`${fieldLabel}不允许使用本机或非公网 IP`)
  }
  assertNoCredentialUrlParams(parsed, fieldLabel)

  return parsed.toString()
}

export function safePublicSettingUrl(value: unknown, fieldLabel: string) {
  try {
    return normalizePublicSettingUrl(value, fieldLabel)
  } catch {
    return ''
  }
}

export function normalizePublicImageSettingUrl(value: unknown, fieldLabel: string) {
  const url = normalizePublicSettingUrl(value, fieldLabel)
  if (!url || url.startsWith('https://')) return url
  if (url.startsWith('/api/media/public/site/')) return url
  throw new Error(`${fieldLabel}只允许站点公开媒体路径或 https 链接`)
}

export function safePublicImageSettingUrl(value: unknown, fieldLabel: string) {
  try {
    return normalizePublicImageSettingUrl(value, fieldLabel)
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
  if (hasBackslashOrEncodedBackslash(url)) {
    throw new Error(`${fieldLabel}不能包含反斜杠`)
  }
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) {
    throw new Error(`${fieldLabel}只允许站内相对路径`)
  }
  let parsed: URL
  try {
    parsed = new URL(url, 'https://meigallery.local')
  } catch {
    throw new Error(`${fieldLabel}格式无效`)
  }
  assertNoCredentialUrlParams(parsed, fieldLabel)
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
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

function hasBackslashOrEncodedBackslash(value: string) {
  return value.includes('\\') || /%5c/i.test(value)
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function assertNoCredentialUrlParams(url: URL, fieldLabel: string) {
  for (const name of url.searchParams.keys()) {
    if (isBlockedCredentialParamName(name)) {
      throw new Error(`${fieldLabel}不能包含凭证类 URL 参数`)
    }
  }
  for (const name of getFragmentParamNames(url.hash)) {
    if (isBlockedCredentialParamName(name)) {
      throw new Error(`${fieldLabel}不能包含凭证类 URL 参数`)
    }
  }
}

function isBlockedCredentialParamName(name: string) {
  return BLOCKED_CREDENTIAL_PARAM_NAMES.has(normalizeUrlParamName(name))
}

function normalizeUrlParamName(name: string) {
  return name.toLowerCase().replace(/[-_]/g, '')
}

function getFragmentParamNames(hash: string) {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment) return []

  const variants = new Set([fragment, safeDecodeURIComponent(fragment)])
  const names: string[] = []
  for (const variant of variants) {
    for (const match of variant.matchAll(/(?:^|[?#&;])([^=&#?;/]+)=/g)) {
      names.push(match[1] ?? '')
    }
  }
  return names
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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
