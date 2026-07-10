import { createFacebookPixelScript, hasSensitiveAnalyticsUrl, isAdminPath, sanitizeAnalyticsText } from '~/utils/facebookPixel'

type PixelEventParams = Record<string, string | number | boolean | string[] | number[] | null | undefined>
type PixelEventOptions = { eventID?: string }
type PixelStandardEventName = 'Contact' | 'Lead' | 'CompleteRegistration' | 'StartTrial' | 'ViewContent' | 'Search' | 'PageView'
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

function logEvent(eventName: string, params?: PixelEventParams) {
  if (debug.value) console.info('[facebook-pixel]', eventName, params || {})
}

export function useFacebookPixel() {
  const route = useRoute()
  const { canTrackMarketing } = useMarketingConsent()

  function callFbq(...args: unknown[]) {
    if (!isClientRuntime() || !canTrackMarketing.value || !initialized.value || !window.fbq) return false
    window.fbq(...args)
    return true
  }

  function getPathname(fullPath: string) {
    try {
      return new URL(fullPath, 'https://site.local').pathname
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
    if (!isClientRuntime() || initialized.value || !pixelId || !canTrackMarketing.value || isTrackingBlocked(fullPath)) return
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

    initialized.value = true
    if (callFbq('init', pixelId)) logEvent('init', { pixel_id: pixelId })
  }

  function trackPageView(fullPath: string) {
    if (!isClientRuntime() || isTrackingBlocked(fullPath)) return
    if (lastTrackedPagePath.value === fullPath) return
    const sent = callFbqForPath(fullPath, 'track', 'PageView')
    if (sent) {
      lastTrackedPagePath.value = fullPath
      logEvent('PageView', { full_path: fullPath })
    }
  }

  function trackStandardEvent(eventName: PixelStandardEventName, payload: PixelEventParams = {}, options: PixelEventOptions = {}) {
    const args: unknown[] = ['track', eventName, payload]
    if (options.eventID) args.push({ eventID: options.eventID })
    const sent = callFbqForCurrentRoute(...args)
    if (sent) logEvent(eventName, { ...payload, event_id: options.eventID })
    return sent
  }

  function trackViewContent(params: { id: string; title: string; requiredRank: number; tags: string[] }) {
    const payload = {
      content_type: 'gallery',
      content_ids: [params.id],
      content_name: sanitizeAnalyticsText(params.title, 80),
      required_rank: params.requiredRank,
      tags: params.tags.slice(0, 8),
    }
    trackStandardEvent('ViewContent', payload)
  }

  function trackSearch(params: { searchString: string; resultCount: number }) {
    const payload = {
      search_string: sanitizeAnalyticsText(params.searchString, 80),
      result_count: params.resultCount,
    }
    trackStandardEvent('Search', payload)
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
    trackStandardEvent,
    trackViewContent,
    trackSearch,
    trackLoginCompleted,
    trackFilterSelected,
  }
}

function isClientRuntime() {
  return import.meta.client || typeof window !== 'undefined'
}
