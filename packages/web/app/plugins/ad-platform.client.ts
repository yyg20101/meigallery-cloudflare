export default defineNuxtPlugin(async () => {
  const router = useRouter()
  const { canTrackMarketing, refresh: refreshMarketingConsent } = useMarketingConsent()
  const tracking = useTracking()

  try {
    await refreshMarketingConsent()
  }
  catch {
    await tracking.teardownAdBrowserTracking()
    return
  }

  async function syncBrowserTracking() {
    if (!canTrackMarketing.value) {
      await tracking.clearAdAttribution()
      return
    }
    await tracking.trackPageView()
  }

  watch(canTrackMarketing, () => void syncBrowserTracking(), { immediate: true })
  router.afterEach(() => void syncBrowserTracking())
})
