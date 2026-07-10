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
  teardown(): void
  pageView(): boolean
  standardEvent(
    eventName: MetaPixelEventName,
    payload?: MetaPixelPayload,
    options?: MetaPixelOptions,
  ): boolean
}

export function createMetaPixelAdapter(): MetaPixelAdapter {
  let initialized = false
  let activePixelId = ''
  let ownedFbq: FacebookQueueFunction | null = null
  let pendingScript: HTMLScriptElement | null = null
  let pendingScriptLoadHandler: (() => void) | null = null

  function call(...args: unknown[]) {
    if (!isClientRuntime() || !initialized || !window.fbq) return false
    window.fbq(...args)
    return true
  }

  function initialize(pixelId: string) {
    const normalizedPixelId = normalizePixelId(pixelId)
    if (!isClientRuntime() || !normalizedPixelId) return false
    if (initialized && activePixelId === normalizedPixelId && window.fbq) return true
    if (activePixelId && activePixelId !== normalizedPixelId) teardown()

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
      ownedFbq = fbq

      const script = createFacebookPixelScript(document)
      const handleLoad = () => {
        if (pendingScript === script) {
          pendingScript = null
          pendingScriptLoadHandler = null
        }
        script.removeEventListener('load', handleLoad)
      }
      script.addEventListener('load', handleLoad)
      pendingScript = script
      pendingScriptLoadHandler = handleLoad
      document.head.appendChild(script)
    }

    initialized = true
    activePixelId = normalizedPixelId
    return call('init', normalizedPixelId)
  }

  function teardown() {
    if (ownedFbq?.queue) ownedFbq.queue.length = 0
    if (pendingScript && pendingScriptLoadHandler) {
      pendingScript.removeEventListener('load', pendingScriptLoadHandler)
    }
    pendingScript?.remove()
    if (isClientRuntime()) {
      if (window.fbq === ownedFbq) delete window.fbq
      if (window._fbq === ownedFbq) delete window._fbq
    }
    pendingScript = null
    pendingScriptLoadHandler = null
    ownedFbq = null
    initialized = false
    activePixelId = ''
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

  return { initialize, teardown, pageView, standardEvent }
}

export const metaPixelAdapter = createMetaPixelAdapter()

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
