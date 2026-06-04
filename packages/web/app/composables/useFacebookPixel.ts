import { createFacebookPixelScript, hasSensitiveAnalyticsUrl, isAdminPath, sanitizeAnalyticsText } from '~/utils/facebookPixel'

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
  if (!import.meta.client || !initialized.value || !window.fbq) return false
  window.fbq(...args)
  return true
}

export function useFacebookPixel() {
  const route = useRoute()

  function getPathname(fullPath: string) {
    try {
      return new URL(fullPath, 'https://meigallery.local').pathname
    } catch {
      return fullPath.split(/[?#]/)[0] || fullPath
    }
  }

  function isTrackingBlocked(fullPath: string) {
    return isAdminPath(getPathname(fullPath)) || hasSensitiveAnalyticsUrl(fullPath)
  }

  function callFbqForPath(fullPath: string, ...args: unknown[]) {
    if (isTrackingBlocked(fullPath)) return false
    return callFbq(...args)
  }

  function callFbqForCurrentRoute(...args: unknown[]) {
    return callFbqForPath(route.fullPath, ...args)
  }

  function initFacebookPixel(pixelId: string, debugEnabled = false, fullPath = route.fullPath) {
    if (!import.meta.client || initialized.value || !pixelId || !hasTrackingConsent() || isTrackingBlocked(fullPath)) return
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
      document.head.appendChild(createFacebookPixelScript(document))
    }

    window.fbq('init', pixelId)
    initialized.value = true
    logEvent('init', { pixel_id: pixelId })
  }

  function trackPageView(fullPath: string) {
    if (!import.meta.client || isTrackingBlocked(fullPath)) return
    if (lastTrackedPagePath.value === fullPath) return
    lastTrackedPagePath.value = fullPath
    const sent = callFbqForPath(fullPath, 'track', 'PageView')
    if (sent) logEvent('PageView', { full_path: fullPath })
  }

  function trackViewContent(params: { id: string; title: string; requiredRank: number; tags: string[] }) {
    const payload = {
      content_type: 'gallery',
      content_ids: [params.id],
      content_name: sanitizeAnalyticsText(params.title, 80),
      required_rank: params.requiredRank,
      tags: params.tags.slice(0, 8),
    }
    const sent = callFbqForCurrentRoute('track', 'ViewContent', payload)
    if (sent) logEvent('ViewContent', payload)
  }

  function trackSearch(params: { searchString: string; resultCount: number }) {
    const payload = {
      search_string: sanitizeAnalyticsText(params.searchString, 80),
      result_count: params.resultCount,
    }
    const sent = callFbqForCurrentRoute('track', 'Search', payload)
    if (sent) logEvent('Search', payload)
  }

  function trackLeadOnce(params: { location: string; methodType: string }) {
    if (leadTracked.value) return
    const payload = { location: params.location, method_type: sanitizeAnalyticsText(params.methodType, 40) }
    const sent = callFbqForCurrentRoute('track', 'Lead', payload)
    if (!sent) return
    leadTracked.value = true
    logEvent('Lead', payload)
  }

  function trackCompleteRegistration() {
    const payload = { method: 'email' }
    const sent = callFbqForCurrentRoute('track', 'CompleteRegistration', payload)
    if (sent) logEvent('CompleteRegistration', payload)
  }

  function trackLoginCompleted() {
    const payload = { method: 'email' }
    const sent = callFbqForCurrentRoute('trackCustom', 'login_completed', payload)
    if (sent) logEvent('login_completed', payload)
  }

  function trackFilterSelected(params: { tagSlug: string; tagType: string; location: string }) {
    const payload = { tag_slug: params.tagSlug, tag_type: params.tagType, location: params.location }
    const sent = callFbqForCurrentRoute('trackCustom', 'filter_selected', payload)
    if (sent) logEvent('filter_selected', payload)
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
