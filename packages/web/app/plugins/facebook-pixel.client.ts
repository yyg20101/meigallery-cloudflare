export default defineNuxtPlugin(async () => {
  const router = useRouter()
  const {
    fetchSettings,
    facebookPixelEnabled,
    facebookPixelId,
    facebookPixelDebugEnabled,
  } = useSiteSettings()
  const { canTrackMarketing } = useMarketingConsent()
  const tracking = useTracking()

  await fetchSettings()

  function syncPixelTracking() {
    if (!canTrackMarketing.value || !facebookPixelEnabled.value || !String(facebookPixelId.value || '').trim()) {
      tracking.teardownPixel()
      return
    }
    tracking.trackPageView()
  }

  watch(
    [facebookPixelEnabled, facebookPixelId, facebookPixelDebugEnabled, canTrackMarketing],
    syncPixelTracking,
    { immediate: true },
  )
  router.afterEach(syncPixelTracking)
})
