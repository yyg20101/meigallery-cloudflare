import { isAdminPath, sanitizeAnalyticsText } from '~/utils/facebookPixel'

type PixelEventParams = Record<string, string | number | boolean | string[] | number[] | null | undefined>
type FacebookQueueFunction = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void
  queue: unknown[]
  loaded: boolean
  version: string
}

declare global {
  interface Window {
    fbq?: FacebookQueueFunction
    _fbq?: unknown
  }
}

const initialized = ref(false)
const debug = ref(false)
const lastTrackedPagePath = ref('')
const leadTracked = ref(false)

function hasTrackingConsent() {
  return true
}

function logEvent(eventName: string, params?: PixelEventParams) {
  if (debug.value) console.info('[facebook-pixel]', eventName, params || {})
}

function callFbq(...args: unknown[]) {
  if (!import.meta.client || !initialized.value || !window.fbq) return
  window.fbq(...args)
}

export function useFacebookPixel() {
  const route = useRoute()

  function callFbqForCurrentRoute(...args: unknown[]) {
    if (isAdminPath(route.path)) return
    callFbq(...args)
  }

  function initFacebookPixel(pixelId: string, debugEnabled = false) {
    if (!import.meta.client || initialized.value || !pixelId || !hasTrackingConsent() || isAdminPath(route.path)) return
    debug.value = debugEnabled

    if (!window.fbq) {
      const fbq = function (...args: unknown[]) {
        if (fbq.callMethod) {
          fbq.callMethod(...args)
        } else {
          fbq.queue.push(args)
        }
      } as FacebookQueueFunction

      window.fbq = fbq
      window._fbq = fbq
      fbq.queue = []
      fbq.loaded = true
      fbq.version = '2.0'
      const script = document.createElement('script')
      script.async = true
      script.src = 'https://connect.facebook.net/en_US/fbevents.js'
      document.head.appendChild(script)
    }

    window.fbq('init', pixelId)
    initialized.value = true
    logEvent('init', { pixel_id: pixelId })
  }

  function trackPageView(fullPath: string) {
    if (!import.meta.client || isAdminPath(fullPath.split('?')[0] || fullPath)) return
    if (lastTrackedPagePath.value === fullPath) return
    lastTrackedPagePath.value = fullPath
    callFbqForCurrentRoute('track', 'PageView')
    logEvent('PageView', { full_path: fullPath })
  }

  function trackViewContent(params: { id: string; title: string; requiredRank: number; tags: string[] }) {
    const payload = {
      content_type: 'gallery',
      content_ids: [params.id],
      content_name: sanitizeAnalyticsText(params.title, 80),
      required_rank: params.requiredRank,
      tags: params.tags.slice(0, 8),
    }
    callFbqForCurrentRoute('track', 'ViewContent', payload)
    logEvent('ViewContent', payload)
  }

  function trackSearch(params: { searchString: string; resultCount: number }) {
    const payload = {
      search_string: sanitizeAnalyticsText(params.searchString, 80),
      result_count: params.resultCount,
    }
    callFbqForCurrentRoute('track', 'Search', payload)
    logEvent('Search', payload)
  }

  function trackLeadOnce(params: { location: string; methodType: string }) {
    if (leadTracked.value) return
    leadTracked.value = true
    const payload = { location: params.location, method_type: sanitizeAnalyticsText(params.methodType, 40) }
    callFbqForCurrentRoute('track', 'Lead', payload)
    logEvent('Lead', payload)
  }

  function trackCompleteRegistration() {
    const payload = { method: 'email' }
    callFbqForCurrentRoute('track', 'CompleteRegistration', payload)
    logEvent('CompleteRegistration', payload)
  }

  function trackLoginCompleted() {
    const payload = { method: 'email' }
    callFbqForCurrentRoute('trackCustom', 'login_completed', payload)
    logEvent('login_completed', payload)
  }

  function trackFilterSelected(params: { tagSlug: string; tagType: string; location: string }) {
    const payload = { tag_slug: params.tagSlug, tag_type: params.tagType, location: params.location }
    callFbqForCurrentRoute('trackCustom', 'filter_selected', payload)
    logEvent('filter_selected', payload)
  }

  return {
    initFacebookPixel,
    trackPageView,
    trackViewContent,
    trackSearch,
    trackLeadOnce,
    trackCompleteRegistration,
    trackLoginCompleted,
    trackFilterSelected,
  }
}
