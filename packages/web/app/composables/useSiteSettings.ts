/**
 * 公开站点设置 composable
 * 从 /api/settings/public 获取站点配置
 * 数据全局缓存，避免重复请求
 */
import { normalizeBooleanSetting, normalizeInternalPath, normalizePublicSettingUrl, normalizeSiteSettingPixelId } from '~/utils/siteSettingsSecurity'

export function useSiteSettings() {
  const { api } = useApi()

  interface SiteSettings {
    site_name?: string
    site_description?: string
    site_icon?: string
    seo_title?: string
    og_title?: string
    og_description?: string
    og_image?: string
    footer_text?: string
    membership_description?: string
    email_verification_enabled?: string | boolean
    video_enabled?: string | boolean
    facebook_pixel_enabled?: string | boolean
    facebook_pixel_id?: string
    facebook_pixel_debug_enabled?: string | boolean
    home_hero_title?: string
    home_hero_subtitle?: string
    home_featured_region_slugs?: string
    home_hot_tag_limit?: string | number
    home_ad_enabled?: string | boolean
    home_ad_eyebrow?: string
    home_ad_title?: string
    home_ad_summary?: string
    home_ad_cta_label?: string
    home_ad_url?: string
    home_ad_sponsor?: string
    rules_entry_enabled?: string | boolean
    rules_entry_title?: string
    rules_entry_summary?: string
    rules_entry_icon?: string
    rules_modal_content?: string
    rules_page_title?: string
    rules_page_summary?: string
    rules_page_content?: string
    rules_page_url?: string
  }

  const settings = useState<SiteSettings>('site-settings', () => ({}))
  const loaded = useState<boolean>('site-settings-loaded', () => false)

  async function fetchSettings() {
    if (loaded.value) return settings.value
    try {
      const data = await api<SiteSettings>('/api/settings/public')
      settings.value = data
      loaded.value = true
    } catch {
      loaded.value = true
    }
    return settings.value
  }

  const siteName = computed(() => settings.value.site_name || 'MeiGallery')
  const siteDescription = computed(() => settings.value.site_description || '')
  const siteIcon = computed(() => normalizePublicSettingUrl(settings.value.site_icon))
  const seoTitle = computed(() => settings.value.seo_title || siteName.value)
  const ogTitle = computed(() => settings.value.og_title || seoTitle.value)
  const ogDescription = computed(() => settings.value.og_description || siteDescription.value)
  const ogImage = computed(() => normalizePublicSettingUrl(settings.value.og_image))
  const footerText = computed(() => settings.value.footer_text || `© ${new Date().getFullYear()} ${siteName.value}`)
  const membershipDescription = computed(() => settings.value.membership_description || '')
  const homeHeroTitle = computed(() => settings.value.home_hero_title || '精选写真，按地区发现')
  const homeHeroSubtitle = computed(() => settings.value.home_hero_subtitle || '以授权写真、时尚、生活与艺术类内容为核心，按地区和标签探索精选图库。')
  const homeFeaturedRegionSlugs = computed(() => String(settings.value.home_featured_region_slugs || '').split(',').map(s => s.trim()).filter(Boolean))
  const homeHotTagLimit = computed(() => {
    const value = Number(settings.value.home_hot_tag_limit || 15)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 30) : 15
  })
  const homeAdEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.home_ad_enabled)
  })
  const homeAdEyebrow = computed(() => settings.value.home_ad_eyebrow || '本周推荐')
  const homeAdTitle = computed(() => settings.value.home_ad_title || '会员季精选内容')
  const homeAdSummary = computed(() => settings.value.home_ad_summary || '探索本周精选图库、真实案例和会员可访问内容。')
  const homeAdCtaLabel = computed(() => settings.value.home_ad_cta_label || '查看推荐')
  const homeAdUrl = computed(() => normalizePublicSettingUrl(settings.value.home_ad_url) || '/discover?sort=hot')
  const homeAdSponsor = computed(() => settings.value.home_ad_sponsor || 'MeiGallery 运营推荐')
  const videoEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.video_enabled)
  })
  const facebookPixelEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.facebook_pixel_enabled)
  })
  const facebookPixelId = computed(() => normalizeSiteSettingPixelId(settings.value.facebook_pixel_id))
  const facebookPixelDebugEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.facebook_pixel_debug_enabled)
  })
  const rulesEntryEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.rules_entry_enabled)
  })
  const rulesEntryTitle = computed(() => settings.value.rules_entry_title || '入站规则')
  const rulesEntrySummary = computed(() => settings.value.rules_entry_summary || '查看内容规则、会员说明和联系前须知。')
  const rulesEntryIcon = computed(() => settings.value.rules_entry_icon || 'letter')
  const rulesModalContent = computed(() => settings.value.rules_modal_content || '')
  const rulesPageTitle = computed(() => settings.value.rules_page_title || '入站规则')
  const rulesPageSummary = computed(() => settings.value.rules_page_summary || '')
  const rulesPageContent = computed(() => settings.value.rules_page_content || rulesModalContent.value)
  const rulesPageUrl = computed(() => normalizeInternalPath(settings.value.rules_page_url) || '/rules')

  return {
    settings,
    fetchSettings,
    siteName,
    siteDescription,
    siteIcon,
    seoTitle,
    ogTitle,
    ogDescription,
    ogImage,
    footerText,
    membershipDescription,
    homeHeroTitle,
    homeHeroSubtitle,
    homeFeaturedRegionSlugs,
    homeHotTagLimit,
    homeAdEnabled,
    homeAdEyebrow,
    homeAdTitle,
    homeAdSummary,
    homeAdCtaLabel,
    homeAdUrl,
    homeAdSponsor,
    videoEnabled,
    facebookPixelEnabled,
    facebookPixelId,
    facebookPixelDebugEnabled,
    rulesEntryEnabled,
    rulesEntryTitle,
    rulesEntrySummary,
    rulesEntryIcon,
    rulesModalContent,
    rulesPageTitle,
    rulesPageSummary,
    rulesPageContent,
    rulesPageUrl,
  }
}
