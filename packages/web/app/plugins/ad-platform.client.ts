export default defineNuxtPlugin(async () => {
  const router = useRouter()
  const { fetchSettings, browserConnections } = useSiteSettings()
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
    if (!canTrackMarketing.value || !browserConnections.value.some(connection => connection.destinationId)) {
      tracking.teardownPixel()
      return
    }
    tracking.trackPageView()
  }

  watch([browserConnections, canTrackMarketing], syncBrowserTracking, { immediate: true, deep: true })
  router.afterEach(syncBrowserTracking)
})
