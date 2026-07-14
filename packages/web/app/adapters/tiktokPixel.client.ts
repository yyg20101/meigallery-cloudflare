type TikTokPixelPayload = Record<string, string | number | boolean>
type TikTokQueue = unknown[] & {
  _i?: Record<string, TikTokQueue>
  _o?: Record<string, unknown>
  _t?: Record<string, number>
  _u?: string
  methods?: readonly string[]
  setAndDefer?: (target: TikTokQueue, method: string) => void
  instance?: (pixelId: string) => TikTokQueue
  load?: (pixelId: string, options?: Record<string, unknown>) => void
  page?: () => void
  track?: (eventName: string, payload?: TikTokPixelPayload, options?: { event_id: string }) => void
}

declare global {
  interface Window {
    TiktokAnalyticsObject?: string
    ttq?: TikTokQueue
  }
}

const TIKTOK_SCRIPT_ORIGIN = 'https://analytics.tiktok.com/i18n/pixel/events.js'
const TIKTOK_DEFERRED_METHODS = [
  'page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready',
  'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent',
] as const

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
        const instance = [] as TikTokQueue
        instance._u = TIKTOK_SCRIPT_ORIGIN
        queue._i[id] = instance
        queue._o[id] = options
        queue._t[id] = Date.now()
        const element = document.createElement('script')
        element.type = 'text/javascript'
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
    if (eventId) window.ttq.track?.(eventName, payload, { event_id: eventId })
    else window.ttq.track?.(eventName, payload)
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
  queue.methods = TIKTOK_DEFERRED_METHODS
  queue.setAndDefer = (target, method) => {
    const methods = target as unknown as Record<string, unknown>
    methods[method] = (...args: unknown[]) => target.push([method, ...args])
  }
  for (const method of TIKTOK_DEFERRED_METHODS) queue.setAndDefer(queue, method)
  queue.instance = (pixelId) => {
    const instance = queue._i?.[pixelId] ?? [] as TikTokQueue
    for (const method of TIKTOK_DEFERRED_METHODS) queue.setAndDefer?.(instance, method)
    return instance
  }
}

export function normalizeTikTokPixelId(value: unknown) {
  const id = String(value ?? '').trim().toUpperCase()
  return /^[A-Z0-9]{10,30}$/.test(id) ? id : ''
}

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
