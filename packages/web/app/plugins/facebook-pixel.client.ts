import { hasSensitiveAnalyticsUrl, isAdminPath, resolveFacebookPixelConfig } from '~/utils/facebookPixel'

export default defineNuxtPlugin(async () => {
  const route = useRoute()
  const router = useRouter()
  const runtimeConfig = useRuntimeConfig()
  const {
    fetchSettings,
    facebookPixelEnabled,
    facebookPixelId,
    facebookPixelDebugEnabled,
  } = useSiteSettings()
  const { canTrackMarketing } = useMarketingConsent()
  const { initFacebookPixel, cleanupFacebookPixel, trackPageView } = useFacebookPixel()

  await fetchSettings()

  function trackAllowedPage(fullPath: string) {
    const config = resolveFacebookPixelConfig({
      enabled: facebookPixelEnabled.value,
      pixelId: facebookPixelId.value,
      debugEnabled: facebookPixelDebugEnabled.value,
    }, runtimeConfig)
    const pathname = new URL(fullPath, 'https://site.local').pathname
    if (!config.enabled || !canTrackMarketing.value || isAdminPath(pathname) || hasSensitiveAnalyticsUrl(fullPath)) return
    initFacebookPixel(config.pixelId, config.debugEnabled, fullPath)
    trackPageView(fullPath)
  }

  watch(
    [facebookPixelEnabled, facebookPixelId, facebookPixelDebugEnabled, canTrackMarketing],
    () => {
      if (!canTrackMarketing.value) {
        cleanupFacebookPixel()
        return
      }
      trackAllowedPage(route.fullPath)
    },
    { immediate: true },
  )
  router.afterEach(to => trackAllowedPage(to.fullPath))
})
