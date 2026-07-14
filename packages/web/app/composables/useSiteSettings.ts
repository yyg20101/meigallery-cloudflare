/**
 * 公开站点设置 composable
 * 从 /api/settings/public 获取站点配置
 * 数据全局缓存，避免重复请求
 */
import type { AdPlatformProvider, AdPlatformTrackingMode } from '@meigallery/shared'
import { isScheduledSiteFeatureActive, normalizeAnalyticsConsentMode, normalizeAnalyticsSampleRate, normalizeBooleanSetting, normalizeFeaturedRegionSlugs, normalizeHomeAdImageUrl, normalizeHomeAdUrl, normalizeHomeHotTagLimit, normalizeInternalPath, normalizePublicImageSettingUrl, normalizeSeoKeywords, normalizeSiteSettingDateTime, safeHomeAdText, safeRulesMarkdown, safeSiteText } from '~/utils/siteSettingsSecurity'

const DEFAULT_SITE_NAME = '图库站'
const LEGACY_DEFAULT_SITE_NAME = 'MeiGallery'

export function useSiteSettings() {
  const { api } = useApi()

  interface SiteSettings {
    site_name?: string
    site_description?: string
    site_icon?: string
    seo_title?: string
    seo_keywords?: string
    og_title?: string
    og_description?: string
    og_image?: string
    footer_text?: string
    membership_description?: string
    email_verification_enabled?: string | boolean
    video_enabled?: string | boolean
    ad_platform_browser_connections?: BrowserConnectionSetting[]
    analytics_enabled?: string | boolean
    analytics_sample_rate?: string | number
    analytics_consent_mode?: string
    home_hero_title?: string
    home_hero_subtitle?: string
    home_featured_region_slugs?: string
    home_hot_tag_limit?: string | number
    home_ad_enabled?: string | boolean
    home_ad_active?: boolean
    home_ad_eyebrow?: string
    home_ad_title?: string
    home_ad_summary?: string
    home_ad_cta_label?: string
    home_ad_url?: string
    home_ad_sponsor?: string
    home_ad_starts_at?: string
    home_ad_ends_at?: string
    home_ads?: HomeAdSetting[]
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

  interface HomeAdSetting {
    id?: string
    eyebrow?: string
    title?: string
    summary?: string
    ctaLabel?: string
    targetUrl?: string
    sponsor?: string
    imageUrl?: string
    sortOrder?: number
  }

  interface BrowserConnectionSetting {
    provider?: AdPlatformProvider
    destinationId?: string
    debugEnabled?: boolean
    mode?: AdPlatformTrackingMode
  }

  interface NormalizedHomeAd {
    id: string
    eyebrow: string
    title: string
    summary: string
    ctaLabel: string
    url: string
    sponsor: string
    imageUrl: string
    sortOrder: number
  }

  const settings = useState<SiteSettings>('site-settings', () => ({}))
  const loaded = useState<boolean>('site-settings-loaded', () => false)

  async function fetchSettings(options: { force?: boolean } = {}) {
    if (loaded.value && !options.force) return settings.value
    try {
      const data = await api<SiteSettings>('/api/settings/public', {
        query: options.force ? { _fresh: Date.now() } : undefined,
      })
      settings.value = data
      loaded.value = true
    } catch {
      if (options.force) throw new Error('公开站点设置刷新失败')
    }
    return settings.value
  }

  const siteName = computed(() => {
    const name = safeSiteText('site_name', settings.value.site_name)
    return name && name !== LEGACY_DEFAULT_SITE_NAME ? name : DEFAULT_SITE_NAME
  })
  const siteDescription = computed(() => safeSiteText('site_description', settings.value.site_description))
  const siteIcon = computed(() => normalizePublicImageSettingUrl(settings.value.site_icon))
  const seoTitle = computed(() => safeSiteText('seo_title', settings.value.seo_title) || siteName.value)
  const seoKeywords = computed(() => normalizeSeoKeywords(settings.value.seo_keywords))
  const ogTitle = computed(() => safeSiteText('og_title', settings.value.og_title) || seoTitle.value)
  const ogDescription = computed(() => safeSiteText('og_description', settings.value.og_description) || siteDescription.value)
  const ogImage = computed(() => normalizePublicImageSettingUrl(settings.value.og_image))
  const footerText = computed(() => safeSiteText('footer_text', settings.value.footer_text) || `© ${new Date().getFullYear()} ${siteName.value}`)
  const membershipDescription = computed(() => safeSiteText('membership_description', settings.value.membership_description))
  const homeHeroTitle = computed(() => safeSiteText('home_hero_title', settings.value.home_hero_title) || '精选写真，按地区发现')
  const homeHeroSubtitle = computed(() => safeSiteText('home_hero_subtitle', settings.value.home_hero_subtitle) || '以授权写真、时尚、生活与艺术类内容为核心，按地区和标签探索精选图库。')
  const homeFeaturedRegionSlugs = computed(() => normalizeFeaturedRegionSlugs(settings.value.home_featured_region_slugs))
  const homeHotTagLimit = computed(() => normalizeHomeHotTagLimit(settings.value.home_hot_tag_limit))
  const homeAdEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.home_ad_enabled)
  })
  const homeAdEyebrow = computed(() => safeHomeAdText('home_ad_eyebrow', settings.value.home_ad_eyebrow) || '本周推荐')
  const homeAdTitle = computed(() => safeHomeAdText('home_ad_title', settings.value.home_ad_title) || '会员季精选内容')
  const homeAdSummary = computed(() => safeHomeAdText('home_ad_summary', settings.value.home_ad_summary) || '探索本周精选图库、真实案例和会员可访问内容。')
  const homeAdCtaLabel = computed(() => safeHomeAdText('home_ad_cta_label', settings.value.home_ad_cta_label) || '查看推荐')
  const homeAdUrl = computed(() => normalizeHomeAdUrl(settings.value.home_ad_url) || '/discover?sort=hot')
  const homeAdSponsor = computed(() => safeHomeAdText('home_ad_sponsor', settings.value.home_ad_sponsor) || '运营推荐')
  const homeAdStartsAt = computed(() => normalizeSiteSettingDateTime(settings.value.home_ad_starts_at))
  const homeAdEndsAt = computed(() => normalizeSiteSettingDateTime(settings.value.home_ad_ends_at))
  const homeAdActive = computed(() => {
    if (typeof settings.value.home_ad_active === 'boolean') return settings.value.home_ad_active
    return isScheduledSiteFeatureActive(settings.value.home_ad_enabled, settings.value.home_ad_starts_at, settings.value.home_ad_ends_at)
  })
  const homeAds = computed<NormalizedHomeAd[]>(() => {
    const rows = Array.isArray(settings.value.home_ads) ? settings.value.home_ads : []
    const normalized = rows
      .map((ad, index) => normalizeHomeAdSetting(ad, index))
      .filter((ad): ad is NormalizedHomeAd => Boolean(ad))
      .sort((a, b) => a.sortOrder - b.sortOrder)

    if (normalized.length > 0) return normalized
    if (!homeAdActive.value) return []

    return [{
      id: 'legacy-home-ad',
      eyebrow: homeAdEyebrow.value,
      title: homeAdTitle.value,
      summary: homeAdSummary.value,
      ctaLabel: homeAdCtaLabel.value,
      url: homeAdUrl.value,
      sponsor: homeAdSponsor.value,
      imageUrl: '',
      sortOrder: 0,
    }]
  })
  const videoEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.video_enabled)
  })
  const browserConnections = computed(() => Array.isArray(settings.value.ad_platform_browser_connections)
    ? settings.value.ad_platform_browser_connections
    : [])
  const marketingTrackingMode = computed(() => {
    const modes = browserConnections.value.map(connection => connection.mode)
    if (modes.includes('production')) return 'production'
    if (modes.includes('test')) return 'test'
    return 'disabled'
  })
  const analyticsEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.analytics_enabled)
  })
  const analyticsSampleRate = computed(() => {
    return normalizeAnalyticsSampleRate(settings.value.analytics_sample_rate)
  })
  const analyticsConsentMode = computed(() => {
    return normalizeAnalyticsConsentMode(settings.value.analytics_consent_mode)
  })
  const rulesEntryEnabled = computed(() => {
    return normalizeBooleanSetting(settings.value.rules_entry_enabled)
  })
  const rulesEntryTitle = computed(() => safeSiteText('rules_entry_title', settings.value.rules_entry_title) || '入站规则')
  const rulesEntrySummary = computed(() => safeSiteText('rules_entry_summary', settings.value.rules_entry_summary) || '查看内容规则、会员说明和联系前须知。')
  const rulesEntryIcon = computed(() => safeSiteText('rules_entry_icon', settings.value.rules_entry_icon) || 'letter')
  const rulesModalContent = computed(() => safeRulesMarkdown(settings.value.rules_modal_content))
  const rulesPageTitle = computed(() => safeSiteText('rules_page_title', settings.value.rules_page_title) || '入站规则')
  const rulesPageSummary = computed(() => safeSiteText('rules_page_summary', settings.value.rules_page_summary))
  const rulesPageContent = computed(() => safeRulesMarkdown(settings.value.rules_page_content) || rulesModalContent.value)
  const rulesPageUrl = computed(() => normalizeInternalPath(settings.value.rules_page_url) || '/rules')

  return {
    settings,
    fetchSettings,
    siteName,
    siteDescription,
    siteIcon,
    seoTitle,
    seoKeywords,
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
    homeAdStartsAt,
    homeAdEndsAt,
    homeAdActive,
    homeAds,
    videoEnabled,
    browserConnections,
    marketingTrackingMode,
    analyticsEnabled,
    analyticsSampleRate,
    analyticsConsentMode,
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

  function normalizeHomeAdSetting(ad: HomeAdSetting, index: number): NormalizedHomeAd | null {
    const title = safeHomeAdText('home_ad_title', ad.title)
    const url = normalizeHomeAdUrl(ad.targetUrl)
    if (!title || !url) return null

    return {
      id: ad.id || `home-ad-${index}`,
      eyebrow: safeHomeAdText('home_ad_eyebrow', ad.eyebrow) || '本周推荐',
      title,
      summary: safeHomeAdText('home_ad_summary', ad.summary),
      ctaLabel: safeHomeAdText('home_ad_cta_label', ad.ctaLabel) || '查看详情',
      url,
      sponsor: safeHomeAdText('home_ad_sponsor', ad.sponsor),
      imageUrl: normalizeHomeAdImageUrl(ad.imageUrl),
      sortOrder: Number.isFinite(ad.sortOrder) ? Number(ad.sortOrder) : index,
    }
  }
}
