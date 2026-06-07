import type { AnalyticsSourceChannel } from '@meigallery/shared'
import { hasSensitiveAnalyticsUrl, isAdminPath } from '~/utils/facebookPixel'

export default defineNuxtPlugin(async () => {
  const route = useRoute()
  const router = useRouter()
  const {
    fetchSettings,
    analyticsEnabled,
    analyticsConsentMode,
  } = useSiteSettings()
  const analytics = useAnalytics()

  await fetchSettings()
  if (!analyticsEnabled.value || isAdminPath(route.path) || hasSensitiveAnalyticsUrl(route.fullPath)) return

  analytics.initialize({
    enabled: analyticsEnabled.value,
    consentState: analyticsConsentMode.value,
    sourceChannel: deriveInitialSourceChannel(route),
    route,
  })
  analytics.trackPageView(route)

  router.afterEach((to, from) => {
    if (isAdminPath(to.path) || hasSensitiveAnalyticsUrl(to.fullPath)) return
    analytics.trackPageLeave(from)
    void analytics.flush()
    analytics.trackPageView(to)
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    analytics.trackPageLeave(route)
    void analytics.flush({ beacon: true })
  })

  window.addEventListener('pagehide', () => {
    analytics.trackPageLeave(route)
    void analytics.flush({ beacon: true })
    analytics.sendSessionEnd({ beacon: true })
  })

  window.addEventListener('scroll', () => {
    const doc = document.documentElement
    const scrollable = Math.max(1, doc.scrollHeight - window.innerHeight)
    const depth = Math.round(((window.scrollY + window.innerHeight) / scrollable) * 100)
    analytics.updateScrollDepth(depth)
  }, { passive: true })
})

function deriveInitialSourceChannel(route: ReturnType<typeof useRoute>): AnalyticsSourceChannel {
  if (route.query.invite) return 'invite'
  if (route.query.utm_source || route.query.utm_medium || route.query.utm_campaign) return 'ad'
  if (import.meta.client && document.referrer) return 'referral'
  return 'direct'
}
