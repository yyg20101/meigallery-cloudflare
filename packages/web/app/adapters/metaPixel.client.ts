import { createFacebookPixelScript, normalizePixelId } from '~/utils/facebookPixel'

type MetaPixelEventName = 'ViewContent' | 'Search' | 'Contact' | 'CompleteRegistration'
type MetaPixelPayload = Record<string, string | number | boolean>
type MetaPixelOptions = { eventID?: string }

type FacebookQueueFunction = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void
  queue: unknown[]
  loaded: boolean
  version: string
}

declare global {
  interface Window {
    fbq?: FacebookQueueFunction
    _fbq?: FacebookQueueFunction
  }
}

export interface MetaPixelAdapter {
  initialize(pixelId: string): boolean
  pageView(): boolean
  standardEvent(
    eventName: MetaPixelEventName,
    payload?: MetaPixelPayload,
    options?: MetaPixelOptions,
  ): boolean
}

export function createMetaPixelAdapter(): MetaPixelAdapter {
  let initialized = false

  function call(...args: unknown[]) {
    if (!isClientRuntime() || !initialized || !window.fbq) return false
    window.fbq(...args)
    return true
  }

  function initialize(pixelId: string) {
    const normalizedPixelId = normalizePixelId(pixelId)
    if (!isClientRuntime() || !normalizedPixelId) return false
    if (initialized && window.fbq) return true

    if (!window.fbq) {
      const fbq = function (...args: unknown[]) {
        if (fbq.callMethod) fbq.callMethod(...args)
        else fbq.queue.push(args)
      } as FacebookQueueFunction

      fbq.queue = []
      fbq.loaded = true
      fbq.version = '2.0'
      window.fbq = fbq
      window._fbq = fbq
      document.head.appendChild(createFacebookPixelScript(document))
    }

    initialized = true
    return call('init', normalizedPixelId)
  }

  function pageView() {
    return call('track', 'PageView')
  }

  function standardEvent(
    eventName: MetaPixelEventName,
    payload: MetaPixelPayload = {},
    options: MetaPixelOptions = {},
  ) {
    return options.eventID
      ? call('track', eventName, payload, { eventID: options.eventID })
      : call('track', eventName, payload)
  }

  return { initialize, pageView, standardEvent }
}

export const metaPixelAdapter = createMetaPixelAdapter()

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
