import { sanitizeAnalyticsText } from '~/utils/facebookPixel'

type LegacyStandardEventName = 'Contact' | 'Lead' | 'CompleteRegistration' | 'ViewContent' | 'Search' | 'PageView'

// Task 5 删除前的兼容包装；不允许绕过 Tracking Facade 直接发送活动事件。
export function useFacebookPixel() {
  const tracking = useTracking()

  function trackPageView(_fullPath?: string) {
    tracking.trackPageView()
  }

  function trackViewContent(params: { id: string; title: string; requiredRank: number; tags: string[] }) {
    tracking.trackViewContent({
      content_id: params.id,
      content_name: sanitizeAnalyticsText(params.title, 80),
      required_rank: params.requiredRank,
      tag_count: params.tags.length,
    })
  }

  function trackSearch(params: { searchString: string; resultCount: number }) {
    tracking.trackSearch(params)
  }

  function trackStandardEvent(_eventName: LegacyStandardEventName) {
    return false
  }

  return {
    initFacebookPixel: () => false,
    cleanupFacebookPixel: () => undefined,
    trackPageView,
    trackStandardEvent,
    trackViewContent,
    trackSearch,
    trackLoginCompleted: () => undefined,
    trackFilterSelected: () => undefined,
  }
}
