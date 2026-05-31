import { normalizeBooleanSetting, normalizeFacebookPixelId } from './facebook-pixel-settings'
import { normalizeHomeAdUrl } from './home-ad-settings'
import { safeInternalPathSetting, safePublicSettingUrl } from './public-setting-url'

const PUBLIC_URL_FIELDS: Record<string, string> = {
  site_icon: '站点图标 URL',
  og_image: 'OG 封面图 URL',
}

const INTERNAL_PATH_FIELDS: Record<string, string> = {
  rules_page_url: '规则页链接',
}

export function sanitizePublicSiteSetting(key: string, value: unknown) {
  if (key === 'home_ad_url') {
    try {
      return normalizeHomeAdUrl(value)
    } catch {
      return ''
    }
  }

  const publicUrlLabel = PUBLIC_URL_FIELDS[key]
  if (publicUrlLabel) return safePublicSettingUrl(value, publicUrlLabel)

  const internalPathLabel = INTERNAL_PATH_FIELDS[key]
  if (internalPathLabel) return safeInternalPathSetting(value, internalPathLabel)

  if (key === 'facebook_pixel_id') {
    try {
      return normalizeFacebookPixelId(value)
    } catch {
      return ''
    }
  }

  if (key === 'facebook_pixel_enabled' || key === 'facebook_pixel_debug_enabled' || key === 'home_ad_enabled') {
    return normalizeBooleanSetting(value)
  }

  return value
}
