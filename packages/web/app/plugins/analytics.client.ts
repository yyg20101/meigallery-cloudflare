import type { AnalyticsSourceChannel } from '@meigallery/shared'
import { hasSensitiveAnalyticsUrl, isAdminPath } from '~/utils/facebookPixel'
import { sanitizeReferrer } from '~/utils/analyticsSanitizer'

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

  const initialSource = deriveInitialSource(route)
  analytics.initialize({
    enabled: analyticsEnabled.value,
    consentState: analyticsConsentMode.value,
    sourceChannel: initialSource.channel,
    sourceContext: initialSource.context,
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

function deriveInitialSource(route: ReturnType<typeof useRoute>): {
  channel: AnalyticsSourceChannel
  context: {
    referrer: string
    referrerHost: string
    utmSource: string
    utmMedium: string
    utmCampaign: string
    trackingSourceSlug: string
    sourceName: string
  }
} {
  const trackingSourceSlug = queryValue(route.query.mg_source)
  const utmSource = queryValue(route.query.utm_source)
  const utmMedium = queryValue(route.query.utm_medium)
  const utmCampaign = queryValue(route.query.utm_campaign)
  const currentHost = import.meta.client ? window.location.host : ''
  const referrer = import.meta.client ? sanitizeReferrer(document.referrer, currentHost) : { referrer: '', referrerHost: '' }
  const channel = deriveInitialSourceChannel({
    hasInvite: Boolean(route.query.invite),
    hasTrackingSource: Boolean(trackingSourceSlug),
    utmMedium,
    hasUtm: Boolean(utmSource || utmMedium || utmCampaign),
    hasReferrer: Boolean(referrer.referrerHost),
  })
  return {
    channel,
    context: {
      referrer: referrer.referrer,
      referrerHost: referrer.referrerHost,
      utmSource,
      utmMedium,
      utmCampaign,
      trackingSourceSlug,
      sourceName: utmSource || trackingSourceSlug || referrer.referrerHost || channel,
    },
  }
}

function deriveInitialSourceChannel(input: {
  hasInvite: boolean
  hasTrackingSource: boolean
  utmMedium: string
  hasUtm: boolean
  hasReferrer: boolean
}): AnalyticsSourceChannel {
  if (input.hasInvite) return 'invite'
  if (input.hasTrackingSource || input.hasUtm) return channelFromUtmMedium(input.utmMedium)
  if (input.hasReferrer) return 'referral'
  return 'direct'
}

function channelFromUtmMedium(value: string): AnalyticsSourceChannel {
  const medium = value.trim().toLowerCase()
  if (medium === 'ad' || medium === 'ads' || medium === 'paid' || medium === 'cpc') return 'ad'
  if (medium === 'social' || medium === 'sns') return 'social'
  if (medium === 'search' || medium === 'seo' || medium === 'organic_search') return 'search'
  if (medium === 'direct') return 'direct'
  if (medium === 'internal') return 'internal'
  return 'referral'
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  return String(raw ?? '').trim().slice(0, 120)
}
