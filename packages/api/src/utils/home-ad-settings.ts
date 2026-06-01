import { normalizePublicSettingUrl } from './public-setting-url'

const HOME_AD_TEXT_LIMITS: Record<string, { label: string; maxLength: number }> = {
  home_ad_eyebrow: { label: '首页广告眉标', maxLength: 12 },
  home_ad_title: { label: '首页广告标题', maxLength: 40 },
  home_ad_summary: { label: '首页广告摘要', maxLength: 120 },
  home_ad_cta_label: { label: '首页广告按钮文案', maxLength: 12 },
  home_ad_sponsor: { label: '首页广告来源说明', maxLength: 30 },
}

export function normalizeHomeAdUrl(value: unknown) {
  return normalizePublicSettingUrl(value, '首页广告链接')
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
