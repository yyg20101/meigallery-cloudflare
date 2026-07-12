export default defineNuxtPlugin(async () => {
  const router = useRouter()
  const { fetchSettings, metaBrowserConnection } = useSiteSettings()
  const { canTrackMarketing, refresh: refreshMarketingConsent } = useMarketingConsent()
  const tracking = useTracking()

  try {
    await Promise.all([fetchSettings(), refreshMarketingConsent()])
  }
  catch {
    tracking.teardownPixel()
    return
  }

  function syncBrowserTracking() {
    if (!canTrackMarketing.value || !metaBrowserConnection.value?.destinationId) {
      tracking.teardownPixel()
      return
    }
    tracking.trackPageView()
  }

  watch([metaBrowserConnection, canTrackMarketing], syncBrowserTracking, { immediate: true })
  router.afterEach(syncBrowserTracking)
})
