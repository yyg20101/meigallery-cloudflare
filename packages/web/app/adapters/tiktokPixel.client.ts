type TikTokPixelPayload = Record<string, string | number | boolean>
type TikTokQueue = unknown[] & {
  _i?: Record<string, unknown[]>
  _o?: Record<string, unknown>
  _t?: Record<string, number>
  load?: (pixelId: string, options?: Record<string, unknown>) => void
  page?: () => void
  track?: (eventName: string, payload?: TikTokPixelPayload) => void
}

declare global {
  interface Window {
    TiktokAnalyticsObject?: string
    ttq?: TikTokQueue
  }
}

const TIKTOK_SCRIPT_ORIGIN = 'https://analytics.tiktok.com/i18n/pixel/events.js'

export function createTikTokPixelAdapter() {
  let activePixelId = ''
  let script: HTMLScriptElement | null = null
  let ownedQueue: TikTokQueue | null = null
  let initialPageTracked = false

  function initialize(pixelId: string) {
    const normalized = normalizeTikTokPixelId(pixelId)
    if (!isClientRuntime() || !normalized) return false
    if (activePixelId === normalized && window.ttq) return true
    if (activePixelId && activePixelId !== normalized) teardown()

    if (!window.ttq) {
      const queue = [] as TikTokQueue
      window.TiktokAnalyticsObject = 'ttq'
      window.ttq = queue
      ownedQueue = queue
      installQueueMethods(queue)
      queue.load = (id, options = {}) => {
        queue._i ||= {}
        queue._o ||= {}
        queue._t ||= {}
        queue._i[id] = []
        queue._o[id] = options
        queue._t[id] = Date.now()
        const element = document.createElement('script')
        element.async = true
        element.referrerPolicy = 'no-referrer'
        element.src = `${TIKTOK_SCRIPT_ORIGIN}?sdkid=${encodeURIComponent(id)}&lib=ttq`
        script = element
        document.head.appendChild(element)
      }
    }

    activePixelId = normalized
    window.ttq?.load?.(normalized)
    return true
  }

  function pageView() {
    if (!window.ttq || !activePixelId || initialPageTracked) return false
    window.ttq.page?.()
    initialPageTracked = true
    return true
  }

  function standardEvent(eventName: string, payload: TikTokPixelPayload = {}, eventId?: string) {
    if (!window.ttq || !activePixelId) return false
    window.ttq.track?.(eventName, eventId ? { ...payload, event_id: eventId } : payload)
    return true
  }

  function teardown() {
    script?.remove()
    if (isClientRuntime() && window.ttq === ownedQueue) {
      delete window.ttq
      delete window.TiktokAnalyticsObject
    }
    script = null
    ownedQueue = null
    activePixelId = ''
    initialPageTracked = false
  }

  return { initialize, pageView, standardEvent, teardown }
}

export const tiktokPixelAdapter = createTikTokPixelAdapter()

function installQueueMethods(queue: TikTokQueue) {
  for (const method of ['page', 'track'] as const) {
    queue[method] = (...args: unknown[]) => queue.push([method, ...args])
  }
}

export function normalizeTikTokPixelId(value: unknown) {
  const id = String(value ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{10,30}$/.test(id) ? id : ''
}

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
