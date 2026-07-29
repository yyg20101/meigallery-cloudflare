import type {
  AdBrowserEvent,
  AdBrowserPublicConfig,
  AdBrowserSignal,
} from '@meigallery/shared'
import { isAdExternalEventId } from '@meigallery/shared/utils'

type BrowserPayload = Record<string, string | number | boolean>
type DataLayer = unknown[][]
type Gtag = (...args: unknown[]) => void

declare global {
  interface Window {
    dataLayer?: DataLayer
    gtag?: Gtag
  }
}

const GOOGLE_TAG_PATTERN = /^AW-\d{5,20}$/
const GOOGLE_DESTINATION_PATTERN = /^AW-\d{5,20}\/[A-Za-z0-9_-]{1,100}$/
const BLOCKED_PAYLOAD_KEY_PATTERN = /(?:email|phone|click|gclid|gbraid|wbraid|fbp|fbc|ttclid|ttp|destination|token)/i
const SIGNAL_EVENT_NAMES: Record<AdBrowserSignal, string> = {
  PageView: 'page_view',
  ViewContent: 'view_item',
  Search: 'search',
}

export function createGoogleAdsAdapter() {
  let initialized = false
  let activeTagId = ''
  let ownedScript: HTMLScriptElement | null = null
  let ownedDataLayer: DataLayer | null = null
  let ownedGtag: Gtag | null = null

  async function initialize(config: AdBrowserPublicConfig) {
    if (!isClientRuntime() || config.provider !== 'google') return false
    const tagId = normalizeGoogleTagId(config.tagId)
    if (!tagId) return false
    if (initialized && activeTagId === tagId && window.gtag) return true
    if (initialized) await teardown()
    if (window.gtag || window.dataLayer) return false

    const dataLayer: DataLayer = []
    window.dataLayer = dataLayer
    ownedDataLayer = dataLayer
    const gtag = (...args: unknown[]) => dataLayer.push(args)
    window.gtag = gtag
    ownedGtag = gtag

    const script = document.createElement('script')
    script.async = true
    script.referrerPolicy = 'no-referrer'
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(tagId)}`
    ownedScript = script
    document.head.appendChild(script)

    gtag('js', new Date())
    gtag('config', tagId, { send_page_view: false })
    initialized = true
    activeTagId = tagId
    return true
  }

  async function track(event: AdBrowserEvent) {
    if (!initialized || !window.gtag || !validEvent(event, activeTagId)) return false
    window.gtag('event', 'conversion', {
      ...safePayload(event.payload),
      send_to: event.browserDestination,
      transaction_id: event.externalEventId,
    })
    return true
  }

  async function trackSignal(signal: AdBrowserSignal, payload: BrowserPayload) {
    if (!initialized || !window.gtag) return false
    window.gtag('event', SIGNAL_EVENT_NAMES[signal], safePayload(payload))
    return true
  }

  async function teardown() {
    ownedScript?.remove()
    if (isClientRuntime()) {
      if (window.gtag === ownedGtag) delete window.gtag
      if (window.dataLayer === ownedDataLayer) delete window.dataLayer
    }
    ownedScript = null
    ownedDataLayer = null
    ownedGtag = null
    initialized = false
    activeTagId = ''
  }

  return { initialize, track, trackSignal, teardown }
}

export const googleAdsAdapter = createGoogleAdsAdapter()

function validEvent(event: AdBrowserEvent, activeTagId: string) {
  return event.provider === 'google'
    && event.browserEventName === 'conversion'
    && GOOGLE_DESTINATION_PATTERN.test(event.browserDestination)
    && event.browserDestination.startsWith(`${activeTagId}/`)
    && isAdExternalEventId(event.externalEventId)
}

function safePayload(payload: BrowserPayload) {
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => (
    !BLOCKED_PAYLOAD_KEY_PATTERN.test(key)
    && key.length <= 80
    && (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 200 && !/[@\r\n]/.test(value)))
  )))
}

function normalizeGoogleTagId(value: unknown) {
  const tagId = String(value ?? '').trim().toUpperCase()
  return GOOGLE_TAG_PATTERN.test(tagId) ? tagId : ''
}

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
