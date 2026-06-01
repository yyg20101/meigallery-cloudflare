const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])
const HOME_AD_TEXT_LIMITS: Record<string, number> = {
  home_ad_eyebrow: 12,
  home_ad_title: 40,
  home_ad_summary: 120,
  home_ad_cta_label: 12,
  home_ad_sponsor: 30,
}
const HOME_AD_TEXT_WARNING_LABELS: Record<string, string> = {
  home_ad_eyebrow: '广告眉标',
  home_ad_title: '广告标题',
  home_ad_summary: '广告摘要',
  home_ad_cta_label: '按钮文案',
  home_ad_sponsor: '赞助/来源说明',
}

export function normalizePublicSettingUrl(value: unknown) {
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
    if (parsed.username || parsed.password) return ''

    const hostname = parsed.hostname.toLowerCase()
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return ''
    if (hostname.includes(':') || isPrivateIpv4(hostname)) return ''

    return parsed.toString()
  } catch {
    return ''
  }

  return ''
}

export function normalizeInternalPath(value: unknown) {
  const url = String(value ?? '').trim()
  if (!url || hasWhitespaceOrControlCharacter(url) || hasEncodedWhitespaceOrControlCharacter(url)) return ''
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return ''

  try {
    const parsed = new URL(url, 'https://meigallery.local')
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return ''
  }
}

export function normalizeSiteSettingPixelId(value: unknown) {
  const pixelId = String(value ?? '').trim()
  return /^\d{5,30}$/.test(pixelId) ? pixelId : ''
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
