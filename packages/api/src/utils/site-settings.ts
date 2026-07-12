export const PROTECTED_ADMIN_SETTING_KEYS = [] as const

export const ADMIN_SETTING_KEYS = [
  'site_name', 'seo_title', 'seo_keywords', 'site_description', 'site_icon',
  'og_title', 'og_description', 'og_image',
  'footer_text', 'membership_description', 'email_verification_enabled',
  'video_enabled',
  'analytics_enabled', 'analytics_sample_rate', 'analytics_consent_mode',
  ...PROTECTED_ADMIN_SETTING_KEYS,
  'home_hero_title', 'home_hero_subtitle',
  'home_featured_region_slugs', 'home_hot_tag_limit',
  'home_ad_enabled', 'home_ad_eyebrow', 'home_ad_title',
  'home_ad_summary', 'home_ad_cta_label', 'home_ad_url', 'home_ad_sponsor',
  'home_ad_starts_at', 'home_ad_ends_at',
  'rules_entry_enabled', 'rules_entry_title', 'rules_entry_summary',
  'rules_entry_icon', 'rules_modal_content', 'rules_page_title',
  'rules_page_summary', 'rules_page_content', 'rules_page_url',
] as const

export const PUBLIC_SETTING_KEYS = [
  'site_name', 'seo_title', 'seo_keywords', 'site_description', 'site_icon',
  'og_title', 'og_description', 'og_image',
  'footer_text', 'membership_description', 'email_verification_enabled',
  'video_enabled',
  'analytics_enabled', 'analytics_sample_rate', 'analytics_consent_mode',
  'home_hero_title', 'home_hero_subtitle',
  'home_featured_region_slugs', 'home_hot_tag_limit',
  'home_ad_enabled', 'home_ad_eyebrow', 'home_ad_title',
  'home_ad_summary', 'home_ad_cta_label', 'home_ad_url', 'home_ad_sponsor',
  'home_ad_starts_at', 'home_ad_ends_at',
  'rules_entry_enabled', 'rules_entry_title', 'rules_entry_summary',
  'rules_entry_icon', 'rules_modal_content', 'rules_page_title',
  'rules_page_summary', 'rules_page_content', 'rules_page_url',
] as const

const PROTECTED_ADMIN_SETTING_KEY_SET = new Set<string>(PROTECTED_ADMIN_SETTING_KEYS)

export function findProtectedAdminSettingKeys(keys: Iterable<string>): string[] {
  return Array.from(keys).filter(key => PROTECTED_ADMIN_SETTING_KEY_SET.has(key))
}
