export default defineNuxtPlugin(async () => {
  const router = useRouter()
  const { fetchSettings, browserConnections } = useSiteSettings()
  const { canTrackMarketing, refresh: refreshMarketingConsent } = useMarketingConsent()
  const tracking = useTracking()

  try {
    await Promise.all([fetchSettings(), refreshMarketingConsent()])
  }
  catch {
    tracking.teardownAdBrowserTracking()
    return
  }

  async function syncBrowserTracking() {
    if (!canTrackMarketing.value || !browserConnections.value.some(connection => connection.destinationId)) {
      await tracking.clearAdAttribution()
      return
    }
    await tracking.trackPageView()
  }

  watch([browserConnections, canTrackMarketing], () => void syncBrowserTracking(), { immediate: true, deep: true })
  router.afterEach(() => void syncBrowserTracking())
})
