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

  watch(
    [facebookPixelEnabled, facebookPixelId, facebookPixelDebugEnabled, canTrackMarketing],
    () => tracking.trackPageView(),
    { immediate: true },
  )
  router.afterEach(() => tracking.trackPageView())
})
