import type {
  AdBrowserInstruction,
  AdBrowserSignal,
  AdConsentSnapshot,
  PlatformPublicConfig,
} from '@meigallery/shared'

type GooglePublicConfig = Extract<PlatformPublicConfig, { provider: 'google' }>
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
const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
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

  async function initialize(config: PlatformPublicConfig, consent: AdConsentSnapshot) {
    if (!isClientRuntime() || config.provider !== 'google' || !hasBasicConsent(consent)) return false
    const tagId = normalizeGoogleTagId(config.tagId)
    if (!tagId) return false
    if (initialized && activeTagId === tagId && window.gtag) return true
    if (initialized) await teardown()

    const dataLayer = window.dataLayer ?? []
    if (!window.dataLayer) {
      window.dataLayer = dataLayer
      ownedDataLayer = dataLayer
    }
    const gtag = window.gtag ?? ((...args: unknown[]) => dataLayer.push(args))
    if (!window.gtag) {
      window.gtag = gtag
      ownedGtag = gtag
    }

    gtag('consent', 'default', {
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    })

    const script = document.createElement('script')
    script.async = true
    script.referrerPolicy = 'no-referrer'
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(tagId)}`
    ownedScript = script
    document.head.appendChild(script)

    gtag('js', new Date())
    gtag('config', tagId)
    initialized = true
    activeTagId = tagId
    return true
  }

  async function track(instruction: AdBrowserInstruction) {
    if (!initialized || !window.gtag || !validInstruction(instruction)) return false
    window.gtag('event', 'conversion', {
      ...safePayload(instruction.payload),
      send_to: instruction.descriptor.browserDestination,
      transaction_id: instruction.externalEventId,
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

function validInstruction(instruction: AdBrowserInstruction) {
  return instruction.provider === 'google'
    && instruction.descriptor.provider === 'google'
    && instruction.descriptor.canonicalEvent === instruction.canonicalEvent
    && instruction.descriptor.browserEventName === 'conversion'
    && GOOGLE_DESTINATION_PATTERN.test(instruction.descriptor.browserDestination)
    && EXTERNAL_EVENT_ID_PATTERN.test(instruction.externalEventId)
}

function safePayload(payload: BrowserPayload) {
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => (
    !BLOCKED_PAYLOAD_KEY_PATTERN.test(key)
    && key.length <= 80
    && (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 200 && !/[@\r\n]/.test(value)))
  )))
}

function hasBasicConsent(consent: AdConsentSnapshot) {
  return consent.marketingAllowed === true && consent.adUserDataAllowed === true
}

function normalizeGoogleTagId(value: unknown) {
  const tagId = String(value ?? '').trim().toUpperCase()
  return GOOGLE_TAG_PATTERN.test(tagId) ? tagId : ''
}

function isClientRuntime() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
