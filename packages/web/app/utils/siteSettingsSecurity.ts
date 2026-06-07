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
const HOME_AD_TEXT_LIMITS: Record<string, number> = {
  home_ad_eyebrow: 16,
  home_ad_title: 64,
  home_ad_summary: 180,
  home_ad_cta_label: 16,
  home_ad_sponsor: 40,
}
const HOME_AD_TEXT_WARNING_LABELS: Record<string, string> = {
  home_ad_eyebrow: '广告眉标',
  home_ad_title: '广告标题',
  home_ad_summary: '广告摘要',
  home_ad_cta_label: '按钮文案',
  home_ad_sponsor: '赞助/来源说明',
}
const HOME_AD_ALLOWED_INTERNAL_PATH_PREFIXES = [
  '/discover',
  '/search',
  '/gallery',
  '/cases',
  '/tags',
  '/rules',
  '/login',
  '/register',
  '/user',
  '/settings',
  '/forgot-password',
]
const HOME_AD_REDIRECT_PARAM_NAMES = new Set([
  'callback',
  'continue',
  'next',
  'redirect',
  'returnto',
  'returnurl',
])
const SITE_TEXT_LIMITS: Record<string, { maxLength: number; pattern?: RegExp }> = {
  site_name: { maxLength: 40 },
  site_description: { maxLength: 180 },
  seo_title: { maxLength: 80 },
  og_title: { maxLength: 80 },
  og_description: { maxLength: 220 },
  footer_text: { maxLength: 120 },
  membership_description: { maxLength: 300 },
  home_hero_title: { maxLength: 40 },
  home_hero_subtitle: { maxLength: 180 },
  rules_entry_title: { maxLength: 20 },
  rules_entry_summary: { maxLength: 120 },
  rules_entry_icon: { maxLength: 32, pattern: /^[a-z0-9_-]+$/i },
  rules_page_title: { maxLength: 40 },
  rules_page_summary: { maxLength: 180 },
}
const MAX_FEATURED_REGION_SLUGS = 12
const MAX_RULES_MARKDOWN_LENGTH = 8000
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i

export function normalizePublicSettingUrl(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url) || hasBackslashOrEncodedBackslash(url)) return ''

  if (url.startsWith('/')) {
    if (url.startsWith('//') || url.startsWith('/\\')) return ''
    try {
      const parsed = new URL(url, 'https://meigallery.local')
      if (hasCredentialUrlParam(parsed)) return ''
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
    if (hasCredentialUrlParam(parsed)) return ''

    return parsed.toString()
  } catch {
    return ''
  }

  return ''
}

export function normalizeHomeAdUrl(value: unknown) {
  const url = normalizePublicSettingUrl(value)
  if (!url || url.startsWith('https://')) return url
  return isAllowedHomeAdInternalPath(url) && hasAllowedHomeAdRedirectParams(url, 0) ? url : ''
}

export function normalizePublicImageSettingUrl(value: unknown) {
  const url = normalizePublicSettingUrl(value)
  if (!url || url.startsWith('https://')) return url
  return url.startsWith('/api/media/public/site/') ? url : ''
}

export function normalizeHomeAdImageUrl(value: unknown) {
  const url = normalizePublicSettingUrl(value)
  if (!url || url.startsWith('https://')) return url
  return url.startsWith('/api/media/public/home-ads/') ? url : ''
}

export function normalizeInternalPath(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url) || hasBackslashOrEncodedBackslash(url)) return ''
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return ''

  try {
    const parsed = new URL(url, 'https://meigallery.local')
    if (hasCredentialUrlParam(parsed)) return ''
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return ''
  }
}

export function normalizeSiteSettingPixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  return /^\d{5,30}$/.test(pixelId) ? pixelId : ''
}

export function safeSiteText(key: string, value: unknown): string {
  const config = SITE_TEXT_LIMITS[key]
  if (!config || value === null || value === undefined) return ''

  const raw = String(value)
  if (hasDisallowedControlCharacter(raw)) return ''

  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length > config.maxLength) return ''
  if (text && config.pattern && !config.pattern.test(text)) return ''
  return text
}

export function normalizeHomeHotTagLimit(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return 15
  if (!/^\d+$/.test(raw)) return 15

  const limit = Number(raw)
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 30) : 15
}

export function normalizeFeaturedRegionSlugs(value: unknown) {
  const raw = String(value ?? '').trim()
  if (!raw) return []

  const slugs = raw
    .split(',')
    .map(slug => slug.trim())
    .filter(Boolean)
  if (slugs.length > MAX_FEATURED_REGION_SLUGS) return []

  const normalizedSlugs: string[] = []
  const seen = new Set<string>()
  for (const slug of slugs) {
    if (!SLUG_PATTERN.test(slug)) return []
    const normalized = slug.toLowerCase()
    if (seen.has(normalized)) continue
    normalizedSlugs.push(normalized)
    seen.add(normalized)
  }
  return normalizedSlugs
}

export function safeRulesMarkdown(value: unknown) {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(/\r\n/g, '\n').trim()
  if (hasDisallowedControlCharacter(text) || text.length > MAX_RULES_MARKDOWN_LENGTH) return ''
  return text
}

export function normalizeHomeAdText(key: string, value: unknown): string {
  const limit = HOME_AD_TEXT_LIMITS[key]
  if (!limit) return String(value ?? '')
  if (value === null || value === undefined) return ''

  const text = String(value).trim().replace(/\s+/g, ' ')
  if (hasControlCharacter(text) || text.length > limit) return ''
  return text
}

export function safeHomeAdText(key: string, value: unknown) {
  return normalizeHomeAdText(key, value) || ''
}

export function getHomeAdTextPreviewWarnings(values: Record<string, unknown>) {
  const warnings: string[] = []
  for (const [key, label] of Object.entries(HOME_AD_TEXT_WARNING_LABELS)) {
    const raw = String(values[key] ?? '').trim()
    if (raw && !safeHomeAdText(key, raw)) warnings.push(`${label}已按安全规则清空`)
  }
  return warnings
}

export function normalizeBooleanSetting(value: unknown) {
  return value === true || value === 'true'
}

export function normalizeAnalyticsSampleRate(value: unknown) {
  if (value === null || value === undefined || value === '') return 0.01
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0) return 0.01
  return Math.min(rate, 0.05)
}

export function normalizeAnalyticsConsentMode(value: unknown) {
  const mode = String(value ?? 'limited').trim()
  return mode === 'granted' || mode === 'limited' || mode === 'denied' ? mode : 'limited'
}

export function normalizeSiteSettingDateTime(value: unknown) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

export function isScheduledSiteFeatureActive(
  enabled: unknown,
  startsAt: unknown,
  endsAt: unknown,
  now = new Date(),
) {
  if (!normalizeBooleanSetting(enabled)) return false

  const normalizedStartsAt = normalizeSiteSettingDateTime(startsAt)
  const normalizedEndsAt = normalizeSiteSettingDateTime(endsAt)
  const start = normalizedStartsAt ? new Date(normalizedStartsAt) : null
  const end = normalizedEndsAt ? new Date(normalizedEndsAt) : null

  if (startsAt && !normalizedStartsAt) return false
  if (endsAt && !normalizedEndsAt) return false
  if (start && now < start) return false
  if (end && now >= end) return false
  return true
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

function hasControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function hasDisallowedControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code === 0x7f) return true
  }
  return false
}

function hasBackslashOrEncodedBackslash(value: string) {
  return value.includes('\\') || /%5c/i.test(value)
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/, '')
}

function hasCredentialUrlParam(url: URL) {
  for (const name of url.searchParams.keys()) {
    if (isBlockedCredentialParamName(name)) return true
  }
  for (const name of getFragmentParamNames(url.hash)) {
    if (isBlockedCredentialParamName(name)) return true
  }
  return false
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

function isAllowedHomeAdInternalPath(url: string) {
  const pathname = new URL(url, 'https://meigallery.local').pathname
  if (pathname === '/') return true

  return HOME_AD_ALLOWED_INTERNAL_PATH_PREFIXES.some((prefix) => {
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}

function hasAllowedHomeAdRedirectParams(url: string, depth: number) {
  if (depth > 3) return false

  const parsed = new URL(url, 'https://meigallery.local')
  for (const [name, target] of parsed.searchParams.entries()) {
    if (!HOME_AD_REDIRECT_PARAM_NAMES.has(normalizeUrlParamName(name))) continue

    const normalizedTarget = normalizePublicSettingUrl(target)
    if (!normalizedTarget || normalizedTarget.startsWith('https://') || !isAllowedHomeAdInternalPath(normalizedTarget)) return false
    if (!hasAllowedHomeAdRedirectParams(normalizedTarget, depth + 1)) return false
  }
  return true
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
