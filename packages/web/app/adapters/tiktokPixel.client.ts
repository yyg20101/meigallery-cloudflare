import type {
  AdBrowserEvent,
  AdBrowserPublicConfig,
  AdBrowserSignal,
} from '@meigallery/shared'
import { isAdExternalEventId } from '@meigallery/shared/utils'

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
  let initialized = false
  let activePixelId = ''
  let ownedScript: HTMLScriptElement | null = null
  let ownedQueue: TikTokQueue | null = null

  async function initialize(config: AdBrowserPublicConfig) {
    if (!isClientRuntime() || config.provider !== 'tiktok') return false
    const pixelId = normalizeTikTokPixelId(config.pixelCode)
    if (!pixelId) return false
    if (initialized && activePixelId === pixelId && window.ttq) return true
    if (initialized) await teardown()
    if (window.ttq || window.TiktokAnalyticsObject) return false

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
      const script = document.createElement('script')
      script.type = 'text/javascript'
      script.async = true
      script.referrerPolicy = 'no-referrer'
      script.src = `${TIKTOK_SCRIPT_ORIGIN}?sdkid=${encodeURIComponent(id)}&lib=ttq`
      ownedScript = script
      document.head.appendChild(script)
    }

    initialized = true
    activePixelId = pixelId
    window.ttq?.load?.(pixelId)
    return true
  }

  async function track(event: AdBrowserEvent) {
    if (!window.ttq || !initialized || !validEvent(event)) return false
    window.ttq.track?.(
      event.browserEventName,
      event.payload,
      { event_id: event.externalEventId },
    )
    return true
  }

  async function trackSignal(signal: AdBrowserSignal, payload: TikTokPixelPayload) {
    if (!window.ttq || !initialized) return false
    if (signal === 'PageView') window.ttq.page?.()
    else window.ttq.track?.(signal, payload)
    return true
  }

  async function teardown() {
    ownedScript?.remove()
    if (ownedQueue) ownedQueue.length = 0
    if (isClientRuntime() && window.ttq === ownedQueue) {
      delete window.ttq
      delete window.TiktokAnalyticsObject
    }
    ownedScript = null
    ownedQueue = null
    initialized = false
    activePixelId = ''
  }

  return { initialize, track, trackSignal, teardown }
}

export const tiktokPixelAdapter = createTikTokPixelAdapter()

function validEvent(event: AdBrowserEvent) {
  return event.provider === 'tiktok'
    && event.browserEventName === event.canonicalEvent
    && isAdExternalEventId(event.externalEventId)
}

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
