import type { MetaPixelInstruction } from '@meigallery/shared'
import { metaPixelAdapter } from '~/adapters/metaPixel.client'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'
import { resolveConversionIdentity } from '~/utils/conversionIdentity'
import { hasSensitiveAnalyticsUrl, isAdminPath, resolveFacebookPixelConfig, sanitizeAnalyticsText } from '~/utils/facebookPixel'
import { readMetaBrowserIdentifiers } from '~/utils/metaBrowserIdentifiers'

export interface TrackContactInput {
  methodType: string
  actionTarget: string
  actionType: 'open_link' | 'copy'
}

type AnalyticsContext = ReturnType<ReturnType<typeof useAnalytics>['getContext']> & {
  sourceChannel?: string
}

type FailedConversionRetry = {
  send: () => Promise<unknown[]>
  complete: (instructions: unknown[]) => void
  attempts: number
}

type FailedPixelReceiptRetry = {
  send: () => Promise<unknown>
  attempts: number
}

const failedConversionRetries: FailedConversionRetry[] = []
const failedPixelReceiptRetries: FailedPixelReceiptRetry[] = []
const PIXEL_RECEIPT_RETRY_DELAYS = [250, 1_000, 3_000]
const PIXEL_RECEIPT_RETRY_LIMIT = 100
let conversionRetryTimer: ReturnType<typeof setTimeout> | null = null
let pixelReceiptRetryTimer: ReturnType<typeof setTimeout> | null = null
let lastTrackedPagePath = ''

export function useTracking() {
  const { api } = useApi()
  const route = useRoute()
  const runtimeConfig = useRuntimeConfig()
  const analytics = useAnalytics()
  const siteSettings = useSiteSettings()
  const marketingConsent = useMarketingConsent()

  async function trackContact(input: TrackContactInput) {
    const context = analytics.getContext() as AnalyticsContext
    const identity = resolveConversionIdentity(context)
    const baseBody = {
      actionType: 'contact' as const,
      visitorId: identity.visitorId,
      sessionId: identity.sessionId,
      occurredAt: new Date().toISOString(),
      routeName: route.name ? String(route.name) : normalizeText(route.path, 120),
      path: safeRoutePath(route.fullPath, route.path),
      sourceChannel: normalizeText(context.sourceChannel || sourceChannelFromContext(context), 40) || 'unknown',
      sourceName: normalizeText(context.sourceContext.sourceName, 120),
      trackingSourceSlug: normalizeText(context.sourceContext.trackingSourceSlug, 120),
      utmSource: normalizeText(context.sourceContext.utmSource, 120),
      utmMedium: normalizeText(context.sourceContext.utmMedium, 120),
      utmCampaign: normalizeText(context.sourceContext.utmCampaign, 120),
      utmContent: queryValue(route.query.utm_content),
      methodType: normalizeText(input.methodType, 80),
      actionTarget: normalizeText(input.actionTarget, 120),
      metadata: { action_type: input.actionType },
    }

    const send = async () => {
      const body = consentScopedBody(baseBody, marketingConsent, route.query.fbclid)
      const response = await api('/api/conversions/events', { method: 'POST', body })
      return pixelEventsFromResponse(response)
    }
    const complete = (instructions: unknown[]) => {
      trackContactAnalytics(analytics, input, firstInstructionEventId(instructions))
      executePixelInstructions(instructions as MetaPixelInstruction[])
    }

    try {
      complete(await send())
    } catch {
      queueFailedConversionRetry({ send, complete, attempts: 0 })
    }
  }

  function executePixelInstructions(instructions: MetaPixelInstruction[]) {
    if (!canDeliverMarketing(marketingConsent) || !Array.isArray(instructions)) return
    for (const value of instructions) {
      if (!isMetaPixelInstruction(value)) continue
      const attempted = metaPixelAdapter.standardEvent(value.eventName, value.payload, { eventID: value.eventId })
      if (!attempted) continue
      reportPixelAttempted(() => api('/api/conversions/pixel-receipts', {
        method: 'POST',
        body: {
          deliveryId: value.deliveryId,
          attempted: true,
          receiptToken: value.receiptToken,
        },
      }))
    }
  }

  function trackPageView() {
    if (!canDeliverMarketing(marketingConsent)) {
      lastTrackedPagePath = ''
      return
    }
    if (isTrackingBlocked(route.fullPath)) return

    const config = resolveFacebookPixelConfig({
      enabled: siteSettings.facebookPixelEnabled.value,
      pixelId: siteSettings.facebookPixelId.value,
      debugEnabled: siteSettings.facebookPixelDebugEnabled.value,
    }, runtimeConfig)
    if (!config.enabled || lastTrackedPagePath === route.fullPath) return
    if (!metaPixelAdapter.initialize(config.pixelId)) return
    if (metaPixelAdapter.pageView()) lastTrackedPagePath = route.fullPath
  }

  function trackViewContent(payload: Record<string, string | number | boolean>) {
    if (!canDeliverMarketing(marketingConsent) || isTrackingBlocked(route.fullPath)) return
    metaPixelAdapter.standardEvent('ViewContent', payload)
  }

  function trackSearch(payload: Record<string, string | number | boolean>) {
    if (!canDeliverMarketing(marketingConsent) || isTrackingBlocked(route.fullPath)) return
    metaPixelAdapter.standardEvent('Search', payload)
  }

  return {
    trackAnalytics: analytics.track,
    trackContact,
    executePixelInstructions,
    trackPageView,
    trackViewContent,
    trackSearch,
  }
}

function consentScopedBody<T extends Record<string, unknown>>(
  baseBody: T,
  marketingConsent: ReturnType<typeof useMarketingConsent>,
  fbclid: unknown,
) {
  const canDeliver = canDeliverMarketing(marketingConsent)
  const currentState = marketingConsent.state.value
  return {
    ...baseBody,
    consentState: canDeliver ? 'granted' : currentState === 'denied' ? 'denied' : 'limited',
    ...(canDeliver && typeof document !== 'undefined'
      ? { browserIdentifiers: readMetaBrowserIdentifiers(document.cookie, fbclid) }
      : {}),
  }
}

function canDeliverMarketing(marketingConsent: ReturnType<typeof useMarketingConsent>) {
  return marketingConsent.state.value === 'granted' && marketingConsent.canTrackMarketing.value
}

function isMetaPixelInstruction(value: unknown): value is MetaPixelInstruction {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<MetaPixelInstruction> & { eventName?: unknown }
  return typeof event.deliveryId === 'string'
    && event.deliveryId.length > 0
    && (event.eventName === 'Contact' || event.eventName === 'CompleteRegistration')
    && typeof event.eventId === 'string'
    && event.eventId.length > 0
    && Boolean(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
    && typeof event.receiptToken === 'string'
    && event.receiptToken.length > 0
}

function isTrackingBlocked(fullPath: string) {
  let pathname = fullPath
  try {
    pathname = new URL(fullPath, 'https://site.local').pathname
  } catch {
    pathname = fullPath.split(/[?#]/)[0] || fullPath
  }
  return isAdminPath(pathname) || hasSensitiveAnalyticsUrl(fullPath)
}

function queueFailedConversionRetry(entry: FailedConversionRetry) {
  failedConversionRetries.push(entry)
  scheduleFailedConversionRetry()
}

function scheduleFailedConversionRetry() {
  if (conversionRetryTimer || failedConversionRetries.length === 0) return
  conversionRetryTimer = setTimeout(() => {
    conversionRetryTimer = null
    void retryFailedConversions()
  }, 1_000)
}

async function retryFailedConversions() {
  const pending = failedConversionRetries.splice(0)
  for (const entry of pending) {
    try {
      entry.complete(await entry.send())
    } catch {
      if (entry.attempts < 2) failedConversionRetries.push({ ...entry, attempts: entry.attempts + 1 })
      else entry.complete([])
    }
  }
  scheduleFailedConversionRetry()
}

function reportPixelAttempted(send: () => Promise<unknown>) {
  void send().catch(() => queueFailedPixelReceiptRetry({ send, attempts: 0 }))
}

function queueFailedPixelReceiptRetry(entry: FailedPixelReceiptRetry) {
  if (failedPixelReceiptRetries.length >= PIXEL_RECEIPT_RETRY_LIMIT) return
  failedPixelReceiptRetries.push(entry)
  scheduleFailedPixelReceiptRetry()
}

function scheduleFailedPixelReceiptRetry() {
  if (pixelReceiptRetryTimer || failedPixelReceiptRetries.length === 0) return
  const delay = PIXEL_RECEIPT_RETRY_DELAYS[failedPixelReceiptRetries[0]!.attempts]!
  pixelReceiptRetryTimer = setTimeout(() => {
    pixelReceiptRetryTimer = null
    void retryFailedPixelReceipts()
  }, delay)
}

async function retryFailedPixelReceipts() {
  const pending = failedPixelReceiptRetries.splice(0)
  for (const entry of pending) {
    try {
      await entry.send()
    } catch {
      if (entry.attempts < PIXEL_RECEIPT_RETRY_DELAYS.length - 1) {
        queueFailedPixelReceiptRetry({ ...entry, attempts: entry.attempts + 1 })
      }
    }
  }
  scheduleFailedPixelReceiptRetry()
}

function pixelEventsFromResponse(response: unknown): unknown[] {
  const events = (response as { data?: { pixelEvents?: unknown } } | null)?.data?.pixelEvents
  return Array.isArray(events) ? events : []
}

function firstInstructionEventId(instructions: unknown[]) {
  for (const value of instructions) {
    if (!value || typeof value !== 'object') continue
    const eventId = (value as { eventId?: unknown }).eventId
    if (typeof eventId === 'string') return eventId
  }
  return ''
}

function trackContactAnalytics(
  analytics: ReturnType<typeof useAnalytics>,
  input: TrackContactInput,
  eventId: string,
) {
  analytics.track('contact_method_click', {
    eventId,
    entityType: 'contact',
    flush: true,
    props: {
      method_type: normalizeText(input.methodType, 80) || 'unknown',
      action_type: input.actionType,
      location: normalizeText(input.actionTarget, 120) || 'floating_contact_panel',
    },
  })
}

function sourceChannelFromContext(context: AnalyticsContext) {
  if (context.sourceContext.sourceName || context.sourceContext.utmSource || context.sourceContext.trackingSourceSlug) return 'ad'
  return 'unknown'
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  return sanitizeAnalyticsText(raw, 120)
}

function safeRoutePath(fullPath: string, path: string) {
  return sanitizeAnalyticsPath(fullPath) || sanitizeAnalyticsPath(path) || '/'
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}
