import { normalizePublicSettingUrl } from './public-setting-url'

const HOME_AD_TEXT_LIMITS: Record<string, { label: string; maxLength: number }> = {
  home_ad_eyebrow: { label: '首页广告眉标', maxLength: 12 },
  home_ad_title: { label: '首页广告标题', maxLength: 40 },
  home_ad_summary: { label: '首页广告摘要', maxLength: 120 },
  home_ad_cta_label: { label: '首页广告按钮文案', maxLength: 12 },
  home_ad_sponsor: { label: '首页广告来源说明', maxLength: 30 },
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

export function normalizeHomeAdUrl(value: unknown) {
  const url = normalizePublicSettingUrl(value, '首页广告链接')
  if (!url || url.startsWith('https://')) return url

  if (!isAllowedHomeAdInternalPath(url)) {
    throw new Error('首页广告链接只允许跳转到公开前台页面或 https 外链')
  }
  return url
}

export function normalizeHomeAdText(key: string, value: unknown) {
  const config = HOME_AD_TEXT_LIMITS[key]
  if (!config) return value
  if (value === null || value === undefined) return ''

  const text = String(value).trim().replace(/\s+/g, ' ')
  if (hasControlCharacter(text)) {
    throw new Error(`${config.label}不能包含控制字符`)
  }
  if (text.length > config.maxLength) {
    throw new Error(`${config.label}不能超过 ${config.maxLength} 个字符`)
  }
  return text
}

export function safeHomeAdText(key: string, value: unknown) {
  try {
    return normalizeHomeAdText(key, value)
  } catch {
    return ''
  }
}

export function isHomeAdTextKey(key: string) {
  return key in HOME_AD_TEXT_LIMITS
}

function hasControlCharacter(value: string) {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isAllowedHomeAdInternalPath(url: string) {
  const pathname = new URL(url, 'https://meigallery.local').pathname
  if (pathname === '/') return true

  return HOME_AD_ALLOWED_INTERNAL_PATH_PREFIXES.some((prefix) => {
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}
