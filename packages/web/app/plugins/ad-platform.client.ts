export default defineNuxtPlugin(() => {
  const router = useRouter()
  const tracking = useTracking()

  async function syncBrowserTracking() {
    await tracking.trackPageView()
  }

  void syncBrowserTracking()
  router.afterEach(() => void syncBrowserTracking())
})
