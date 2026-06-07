import type { AnalyticsSourceChannel } from '@meigallery/shared'

const SENSITIVE_PARAM_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authtoken',
  'bearer',
  'clientsecret',
  'code',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'jwt',
  'key',
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
])

const ALLOWED_ANALYTICS_PATH_PARAMS = new Set([
  'tag',
  'region',
  'style',
  'personality',
  'scene',
  'content_type',
  'sort',
  'page',
])

const SEARCH_HOST_PATTERNS = [
  'google.',
  'bing.com',
  'baidu.com',
  'duckduckgo.com',
  'yahoo.',
  'yandex.',
]

const SOCIAL_HOST_PATTERNS = [
  'facebook.com',
  'instagram.com',
  't.co',
  'twitter.com',
  'x.com',
  'telegram.',
  't.me',
  'weibo.com',
  'xiaohongshu.com',
  'douyin.com',
]

export interface SanitizedReferrer {
  host: string
  path: string
}

export interface SourceAttributionInput {
  inviteCodeId?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  adId?: string | null
  referrerHost?: string | null
  currentHost?: string | null
}

export interface SourceAttribution {
  channel: AnalyticsSourceChannel
  name: string
}

export function sanitizeAnalyticsPath(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw || hasWhitespaceOrControlCharacter(raw) || hasEncodedControlCharacter(raw) || hasBackslashOrEncodedBackslash(raw)) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(raw, 'https://meigallery.local')
  } catch {
    return null
  }

  if (parsed.username || parsed.password || hasSensitiveAnalyticsUrl(parsed)) return null
  if (!parsed.pathname.startsWith('/')) return null
  if (parsed.pathname.startsWith('/admin') || parsed.pathname.startsWith('/api') || parsed.pathname.startsWith('/_nuxt')) {
    return null
  }

  const params = new URLSearchParams()
  for (const [key, paramValue] of parsed.searchParams.entries()) {
    if (!ALLOWED_ANALYTICS_PATH_PARAMS.has(key)) continue
    params.append(key, truncateValue(paramValue, 80))
  }
  const query = params.toString()
  return query ? `${parsed.pathname}?${query}` : parsed.pathname
}

export function sanitizeReferrer(value: unknown, currentHost?: string | null): SanitizedReferrer | null {
  const raw = String(value ?? '').trim()
  if (!raw || hasWhitespaceOrControlCharacter(raw) || hasEncodedControlCharacter(raw) || hasBackslashOrEncodedBackslash(raw)) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password || hasSensitiveAnalyticsUrl(parsed)) return null

  const host = normalizeHost(parsed.hostname)
  if (!host || (currentHost && host === normalizeHost(currentHost))) return null
  return {
    host,
    path: parsed.pathname || '/',
  }
}

export function stripSensitiveParams(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value, 'https://meigallery.local')
  } catch {
    return null
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (isSensitiveParamName(name)) parsed.searchParams.delete(name)
  }
  parsed.hash = ''
  if (parsed.origin === 'https://meigallery.local') {
    return `${parsed.pathname}${parsed.search}`
  }
  return parsed.toString()
}

export function hasSensitiveAnalyticsUrl(value: string | URL): boolean {
  const url = typeof value === 'string' ? tryParseUrl(value) : value
  if (!url) return true
  if (url.username || url.password) return true
  for (const name of url.searchParams.keys()) {
    if (isSensitiveParamName(name)) return true
  }
  for (const name of getFragmentParamNames(url.hash)) {
    if (isSensitiveParamName(name)) return true
  }
  return false
}

export function deriveSourceAttribution(input: SourceAttributionInput): SourceAttribution {
  if (input.inviteCodeId) return { channel: 'invite', name: 'invite' }
  if (input.adId) return { channel: 'ad', name: 'ad' }

  const utmSource = normalizeAttributionName(input.utmSource)
  if (utmSource) {
    const medium = normalizeAttributionName(input.utmMedium)
    return {
      channel: medium === 'cpc' || medium === 'paid' || medium === 'ad' ? 'ad' : 'referral',
      name: utmSource,
    }
  }

  const referrerHost = normalizeAttributionName(input.referrerHost)
  const currentHost = normalizeAttributionName(input.currentHost)
  if (!referrerHost) return { channel: 'direct', name: 'direct' }
  if (currentHost && referrerHost === currentHost) return { channel: 'internal', name: referrerHost }
  if (SEARCH_HOST_PATTERNS.some(pattern => referrerHost.includes(pattern))) return { channel: 'search', name: referrerHost }
  if (SOCIAL_HOST_PATTERNS.some(pattern => referrerHost.includes(pattern))) return { channel: 'social', name: referrerHost }
  return { channel: 'referral', name: referrerHost }
}

function tryParseUrl(value: string) {
  try {
    return new URL(value, 'https://meigallery.local')
  } catch {
    return null
  }
}

function isSensitiveParamName(name: string) {
  return SENSITIVE_PARAM_NAMES.has(normalizeParamName(name))
}

function normalizeParamName(name: string) {
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

function normalizeHost(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function normalizeAttributionName(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase().slice(0, 120)
}

function truncateValue(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function hasWhitespaceOrControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

function hasEncodedControlCharacter(value: string) {
  return /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
}

function hasBackslashOrEncodedBackslash(value: string) {
  return value.includes('\\') || /%5c/i.test(value)
}
