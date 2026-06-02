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
  const { initFacebookPixel, trackPageView } = useFacebookPixel()

  await fetchSettings()

  const config = resolveFacebookPixelConfig({
    enabled: facebookPixelEnabled.value,
    pixelId: facebookPixelId.value,
    debugEnabled: facebookPixelDebugEnabled.value,
  }, runtimeConfig)

  if (config.enabled && !isAdminPath(route.path) && !hasSensitiveAnalyticsUrl(route.fullPath)) {
    initFacebookPixel(config.pixelId, config.debugEnabled, route.fullPath)
    trackPageView(route.fullPath)
  }

  router.afterEach((to) => {
    if (isAdminPath(to.path) || hasSensitiveAnalyticsUrl(to.fullPath)) return
    if (config.enabled) {
      initFacebookPixel(config.pixelId, config.debugEnabled, to.fullPath)
      trackPageView(to.fullPath)
    }
  })
})
