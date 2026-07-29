export default defineNuxtPlugin(async () => {
  const router = useRouter()
  const tracking = useTracking()

  await tracking.trackPageView()
  router.afterEach(() => void tracking.trackPageView())
})
