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
    videoEnabled,
  }
}
