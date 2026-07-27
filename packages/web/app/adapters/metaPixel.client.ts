import type {
  AdBrowserPublicConfig,
  AdBrowserInstruction,
  AdBrowserSignal,
} from '@meigallery/shared'
import { createFacebookPixelScript, normalizePixelId } from '~/utils/trackingSanitizer'

type MetaPixelEventName = AdBrowserSignal | 'Contact' | 'CompleteRegistration'
type MetaPixelPayload = Record<string, string | number | boolean>

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

const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function createMetaPixelAdapter() {
  let initialized = false
  let activePixelId = ''
  let ownedFbq: FacebookQueueFunction | null = null
  let ownedScript: HTMLScriptElement | null = null

  function call(...args: unknown[]) {
    if (!isClientRuntime() || !initialized || !window.fbq) return false
    window.fbq(...args)
    return true
  }

  async function initialize(config: AdBrowserPublicConfig) {
    if (!isClientRuntime() || config.provider !== 'meta') return false
    const pixelId = normalizePixelId(config.pixelId)
    if (!pixelId) return false
    if (initialized && activePixelId === pixelId && window.fbq) return true
    if (initialized) await teardown()
    if (window.fbq || window._fbq) return false

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

    ownedScript = createFacebookPixelScript(document)
    document.head.appendChild(ownedScript)

    initialized = true
    activePixelId = pixelId
    return call('init', pixelId)
  }

  async function track(instruction: AdBrowserInstruction) {
    if (!validInstruction(instruction)) return false
    return call(
      'track',
      instruction.descriptor.browserEventName,
      instruction.payload,
      { eventID: instruction.externalEventId },
    )
  }

  async function trackSignal(signal: AdBrowserSignal, payload: MetaPixelPayload) {
    if (signal === 'PageView') return call('track', 'PageView')
    return call('track', signal satisfies MetaPixelEventName, payload)
  }

  async function teardown() {
    if (ownedFbq) ownedFbq.queue.length = 0
    ownedScript?.remove()
    if (isClientRuntime()) {
      if (window.fbq === ownedFbq) delete window.fbq
      if (window._fbq === ownedFbq) delete window._fbq
    }
    ownedScript = null
    ownedFbq = null
    initialized = false
    activePixelId = ''
  }

  return { initialize, track, trackSignal, teardown }
}

export const metaPixelAdapter = createMetaPixelAdapter()

function validInstruction(instruction: AdBrowserInstruction) {
  return instruction.provider === 'meta'
    && instruction.descriptor.provider === 'meta'
    && instruction.descriptor.canonicalEvent === instruction.canonicalEvent
    && instruction.descriptor.browserEventName === instruction.canonicalEvent
    && EXTERNAL_EVENT_ID_PATTERN.test(instruction.externalEventId)
}

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
