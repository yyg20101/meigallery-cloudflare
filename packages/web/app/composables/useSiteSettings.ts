/**
 * 公开站点设置 composable
 * 从 /api/settings/public 获取站点配置
 * 数据全局缓存，避免重复请求
 */
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
    about_title?: string
    about_summary?: string
    about_content?: string
    home_hero_title?: string
    home_hero_subtitle?: string
    home_hero_cta_label?: string
    home_hero_cta_url?: string
    home_featured_region_slugs?: string
    home_hot_tag_limit?: string | number
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
  const siteIcon = computed(() => settings.value.site_icon || '')
  const seoTitle = computed(() => settings.value.seo_title || siteName.value)
  const ogTitle = computed(() => settings.value.og_title || seoTitle.value)
  const ogDescription = computed(() => settings.value.og_description || siteDescription.value)
  const ogImage = computed(() => settings.value.og_image || '')
  const footerText = computed(() => settings.value.footer_text || `© ${new Date().getFullYear()} ${siteName.value}`)
  const membershipDescription = computed(() => settings.value.membership_description || '')
  const aboutTitle = computed(() => settings.value.about_title || '关于我们')
  const aboutSummary = computed(() => settings.value.about_summary || '')
  const aboutContent = computed(() => settings.value.about_content || '')
  const homeHeroTitle = computed(() => settings.value.home_hero_title || '精选写真，按地区发现')
  const homeHeroSubtitle = computed(() => settings.value.home_hero_subtitle || '以授权写真、时尚、生活与艺术类内容为核心，按地区和标签探索精选图库。')
  const homeHeroCtaLabel = computed(() => settings.value.home_hero_cta_label || '浏览精选图库')
  const homeHeroCtaUrl = computed(() => settings.value.home_hero_cta_url || '/discover')
  const homeFeaturedRegionSlugs = computed(() => String(settings.value.home_featured_region_slugs || '').split(',').map(s => s.trim()).filter(Boolean))
  const homeHotTagLimit = computed(() => {
    const value = Number(settings.value.home_hot_tag_limit || 15)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 30) : 15
  })
  const videoEnabled = computed(() => {
    const v = settings.value.video_enabled
    return v === true || v === 'true'
  })

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
    aboutTitle,
    aboutSummary,
    aboutContent,
    homeHeroTitle,
    homeHeroSubtitle,
    homeHeroCtaLabel,
    homeHeroCtaUrl,
    homeFeaturedRegionSlugs,
    homeHotTagLimit,
    videoEnabled,
  }
}
