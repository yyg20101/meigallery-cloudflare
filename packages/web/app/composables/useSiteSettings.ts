/**
 * 公开站点设置 composable
 * 从 /api/settings/public 获取站点配置
 * 数据全局缓存，避免重复请求
 */
export function useSiteSettings() {
  const { api } = useApi()

  interface SiteSettings {
    site_name?: string
    seo_title?: string
    membership_description?: string
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
  const seoTitle = computed(() => settings.value.seo_title || '')
  const membershipDescription = computed(() => settings.value.membership_description || '')

  return {
    settings,
    fetchSettings,
    siteName,
    seoTitle,
    membershipDescription,
  }
}
