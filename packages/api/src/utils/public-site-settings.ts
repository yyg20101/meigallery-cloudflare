import { normalizeBooleanSetting, normalizeFacebookPixelId } from './facebook-pixel-settings'
import { normalizeHomeAdScheduleValue } from './home-ad-schedule'
import { normalizeHomeAdUrl, safeHomeAdText } from './home-ad-settings'
import { safeInternalPathSetting, safePublicImageSettingUrl } from './public-setting-url'
import { safeFeaturedRegionSlugs, safeHomeHotTagLimit, safeRulesMarkdown } from './site-content-settings'
import { isSiteTextSettingKey, safeSiteTextSetting } from './site-text-settings'

const PUBLIC_URL_FIELDS: Record<string, string> = {
  site_icon: '站点图标 URL',
  og_image: 'OG 封面图 URL',
}

const INTERNAL_PATH_FIELDS: Record<string, string> = {
  rules_page_url: '规则页链接',
}

export const LEGACY_DEFAULT_SEO_TITLE = 'MeiGallery - 精选写真图库'

export function sanitizePublicSiteSetting(key: string, value: unknown) {
  if (key === 'home_ad_url') {
    try {
      return normalizeHomeAdUrl(value)
    } catch {
      return ''
    }
  }

  if (key === 'home_ad_eyebrow' || key === 'home_ad_title' || key === 'home_ad_summary' || key === 'home_ad_cta_label' || key === 'home_ad_sponsor') {
    return safeHomeAdText(key, value)
  }

  if (key === 'home_ad_starts_at' || key === 'home_ad_ends_at') {
    return normalizeHomeAdScheduleValue(value)
  }

  const publicUrlLabel = PUBLIC_URL_FIELDS[key]
  if (publicUrlLabel) return safePublicImageSettingUrl(value, publicUrlLabel)

  const internalPathLabel = INTERNAL_PATH_FIELDS[key]
  if (internalPathLabel) return safeInternalPathSetting(value, internalPathLabel)

  if (key === 'home_hot_tag_limit') return safeHomeHotTagLimit(value)
  if (key === 'home_featured_region_slugs') return safeFeaturedRegionSlugs(value)
  if (key === 'rules_modal_content' || key === 'rules_page_content') return safeRulesMarkdown(value)

  if (isSiteTextSettingKey(key)) {
    return safeSiteTextSetting(key, value)
  }

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

export function sanitizePublicSiteSettings(settings: Record<string, unknown>) {
  const sanitized = { ...settings }
  if (sanitized.seo_title === LEGACY_DEFAULT_SEO_TITLE) {
    sanitized.seo_title = ''
  }
  return sanitized
}
