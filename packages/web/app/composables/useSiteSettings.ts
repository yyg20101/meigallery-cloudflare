/**
 * 公开站点设置 composable
 * 从 /api/settings/public 获取联系方式等站点配置
 * 数据全局缓存，避免重复请求
 */
export function useSiteSettings() {
  const { api } = useApi()

  interface SiteSettings {
    site_name?: string
    seo_title?: string
    membership_description?: string
    contact_wechat?: string
    contact_telegram?: string
    contact_email?: string
    contact_custom_note?: string
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
      // 获取失败时使用空对象，不阻塞页面
      loaded.value = true
    }
    return settings.value
  }

  const contactWechat = computed(() => settings.value.contact_wechat || '')
  const contactTelegram = computed(() => settings.value.contact_telegram || '')
  const contactEmail = computed(() => settings.value.contact_email || '')
  const contactNote = computed(() => settings.value.contact_custom_note || '')
  const siteName = computed(() => settings.value.site_name || 'MeiGallery')

  return {
    settings,
    fetchSettings,
    contactWechat,
    contactTelegram,
    contactEmail,
    contactNote,
    siteName,
  }
}
