import type { AdBrowserInstruction } from '@meigallery/shared'
import {
  executeAdBrowserInstruction,
  initializeAdBrowserProvider,
  isRegisteredAdBrowserProvider,
  teardownAllAdBrowserProviders,
  trackAdBrowserPageView,
  trackAdBrowserStandardEvent,
} from '~/adapters/adPlatformBrowser.client'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'
import { resolveConversionIdentity } from '~/utils/conversionIdentity'
import { hasSensitiveAnalyticsUrl, isAdminPath, sanitizeAnalyticsText } from '~/utils/trackingSanitizer'
import {
  clearTikTokClickIdCookie,
  readAdPlatformBrowserIdentifiers,
  tikTokClickIdCookie,
} from '~/utils/adPlatformBrowserIdentifiers'

export interface TrackContactInput {
  methodType: string
  actionTarget: string
  actionType: 'open_link' | 'copy'
}

export interface TrackSearchInput {
  searchString: string
  resultCount: number
}

export interface MetaLiveChallengeInput {
  pixelId: string
  eventIds: {
    Contact: string
    CompleteRegistration: string
  }
}

type MarketingConsentScope = 'granted' | 'limited' | 'denied'

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
const lastTrackedPageKeys = new Map<AdBrowserInstruction['provider'], string>()
let activeBrowserProvider: AdBrowserInstruction['provider'] | null = null

export function useTracking() {
  const { api } = useApi()
  const route = useRoute()
  const analytics = useAnalytics()
  const siteSettings = useSiteSettings()
  const marketingConsent = useMarketingConsent()
  const adAttribution = useAdAttribution()

  async function trackContact(input: TrackContactInput) {
    const marketingRouteAllowed = isMarketingRouteAllowed(route.fullPath)
    if (marketingRouteAllowed && canDeliverMarketing(marketingConsent)) {
      await adAttribution.resolve(route)
    }
    else if (!marketingRouteAllowed) {
      await adAttribution.clear()
    }
    const context = analytics.getContext() as AnalyticsContext
    const identity = resolveConversionIdentity(context)
    const activationConsentScope = currentMarketingConsentScope(marketingConsent)
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
      adAttributionState: activationConsentScope === 'granted'
        ? trustedAdAttributionState(adAttribution)
        : 'suppress' as const,
      metadata: { action_type: input.actionType },
    }

    const send = async () => {
      const body = consentScopedBody(baseBody, marketingConsent, route.query, activationConsentScope)
      const response = await api('/api/conversions/events', { method: 'POST', body })
      return trackingInstructionsFromResponse(response)
    }
    const complete = (instructions: unknown[]) => {
      trackContactAnalytics(analytics, input, firstInstructionEventId(instructions))
      executeBrowserInstructionsWithinScope(instructions as AdBrowserInstruction[], activationConsentScope)
    }

    let instructions: unknown[]
    try {
      instructions = await send()
    } catch {
      queueFailedConversionRetry({ send, complete, attempts: 0 })
      return
    }
    completeLocally(complete, instructions)
  }

  function executeBrowserInstructions(instructions: AdBrowserInstruction[]) {
    executeBrowserInstructionsWithinScope(instructions, 'granted')
  }

  function executeBrowserInstructionsWithinScope(
    instructions: AdBrowserInstruction[],
    maximumConsentScope: MarketingConsentScope,
  ) {
    if (!ensureCurrentMarketingRouteAllowed()) return
    if (scopedMarketingConsent(marketingConsent, maximumConsentScope) !== 'granted' || !Array.isArray(instructions)) return
    for (const value of instructions) {
      const instruction = normalizeBrowserInstruction(value)
      if (!instruction) continue
      if (instruction.provider !== adAttribution.provider.value) continue
      if (!activateAdBrowserProvider(instruction.provider)) continue
      const attempted = executeAdBrowserInstruction(instruction)
      if (!attempted) continue
      reportPixelAttempted(() => api('/api/conversions/pixel-receipts', {
        method: 'POST',
        body: {
          deliveryId: instruction.deliveryId,
          attempted: true,
          receiptToken: instruction.receiptToken,
        },
      }))
    }
  }

  async function trackPageView() {
    if (!ensureCurrentMarketingRouteAllowed()) return
    if (!canDeliverMarketing(marketingConsent)) {
      clearPersistedAdClickIdentifiers()
      await adAttribution.clear()
      teardownAdBrowserTracking()
      return
    }

    const provider = await adAttribution.resolve(route)
    const connection = siteSettings.browserConnections.value.find(item => (
      item.provider === provider
      && isRegisteredAdBrowserProvider(item.provider)
      && Boolean(item.destinationId)
    ))
    if (!provider || !connection?.destinationId) {
      teardownAdBrowserTracking()
      return
    }
    const pageKey = `${connection.destinationId}|${route.fullPath}`
    if (lastTrackedPageKeys.get(provider) === pageKey) return
    if (!activateAdBrowserProvider(provider)) return
    const tracked = trackAdBrowserPageView(provider)
    if (tracked || provider === 'tiktok') lastTrackedPageKeys.set(provider, pageKey)
  }

  function teardownAdBrowserTracking() {
    teardownAllAdBrowserProviders()
    lastTrackedPageKeys.clear()
    activeBrowserProvider = null
  }

  function ensureCurrentMarketingRouteAllowed() {
    if (isMarketingRouteAllowed(route.fullPath)) return true
    teardownAdBrowserTracking()
    return false
  }

  async function trackViewContent(payload: Record<string, string | number | boolean>) {
    if (!ensureCurrentMarketingRouteAllowed() || !canDeliverMarketing(marketingConsent)) return
    await trackStandardEventForAttributedProvider('ViewContent', payload)
  }

  async function trackSearch(input: TrackSearchInput) {
    if (!ensureCurrentMarketingRouteAllowed() || !canDeliverMarketing(marketingConsent)) return
    await trackStandardEventForAttributedProvider('Search', {
      search_string: sanitizeAnalyticsText(input.searchString, 80),
      result_count: Number.isFinite(input.resultCount) ? input.resultCount : 0,
    })
  }

  async function trackStandardEventForAttributedProvider(
    eventName: string,
    payload: Record<string, string | number | boolean>,
  ) {
    const provider = await adAttribution.resolve(route)
    const connection = siteSettings.browserConnections.value.find(item => item.provider === provider)
    if (!provider || !connection?.destinationId || !isRegisteredAdBrowserProvider(connection.provider)) {
      teardownAdBrowserTracking()
      return
    }
    if (!activateAdBrowserProvider(provider)) return
    trackAdBrowserStandardEvent(provider, eventName, payload)
  }

  function activateAdBrowserProvider(provider: AdBrowserInstruction['provider']) {
    const connection = siteSettings.browserConnections.value.find(item => (
      item.provider === provider
      && isRegisteredAdBrowserProvider(item.provider)
      && Boolean(item.destinationId)
    ))
    if (!connection?.destinationId) return false
    if (activeBrowserProvider && activeBrowserProvider !== provider) teardownAdBrowserTracking()
    if (!initializeAdBrowserProvider(provider, connection.destinationId)) return false
    activeBrowserProvider = provider
    return true
  }

  async function clearAdAttribution() {
    clearPersistedAdClickIdentifiers()
    teardownAdBrowserTracking()
    await adAttribution.clear()
  }

  async function buildRegistrationAttributionContext() {
    const consentScope = currentMarketingConsentScope(marketingConsent)
    if (consentScope === 'granted' && isMarketingRouteAllowed(route.fullPath)) {
      await adAttribution.resolve(route)
    }
    else if (!isMarketingRouteAllowed(route.fullPath)) {
      await adAttribution.clear()
    }
    const context = analytics.getContext() as AnalyticsContext
    const sourceContext = context.sourceContext || {}
    if (consentScope !== 'granted') clearPersistedAdClickIdentifiers()
    return {
      visitorId: normalizeText(context.visitorId, 120) || undefined,
      sessionId: normalizeText(context.sessionId, 120) || undefined,
      occurredAt: new Date().toISOString(),
      routeName: normalizeText(route.name || route.path, 120),
      path: safeRoutePath(route.fullPath, route.path),
      sourceChannel: normalizeText(context.sourceChannel, 40) || 'unknown',
      sourceName: normalizeText(sourceContext.sourceName, 120),
      trackingSourceSlug: normalizeText(sourceContext.trackingSourceSlug, 120),
      utmSource: normalizeText(sourceContext.utmSource, 120),
      utmMedium: normalizeText(sourceContext.utmMedium, 120),
      utmCampaign: normalizeText(sourceContext.utmCampaign, 120),
      utmContent: queryValue(route.query.utm_content),
      consentState: consentScope,
      adAttributionState: consentScope === 'granted'
        ? trustedAdAttributionState(adAttribution)
        : 'suppress' as const,
      ...(consentScope === 'granted' && typeof document !== 'undefined'
        ? { browserIdentifiers: readBrowserIdentifiers(route.query) }
        : {}),
    }
  }

  function sendMetaLiveChallenge(input: MetaLiveChallengeInput) {
    const contactId = String(input?.eventIds?.Contact || '')
    const registrationId = String(input?.eventIds?.CompleteRegistration || '')
    if (!/^mlv_contact_[0-9a-f]{32}$/.test(contactId)
      || !/^mlv_registration_[0-9a-f]{32}$/.test(registrationId)
      || contactId === registrationId) return false
    if (activeBrowserProvider && activeBrowserProvider !== 'meta') teardownAdBrowserTracking()
    if (!initializeAdBrowserProvider('meta', input.pixelId)) return false
    activeBrowserProvider = 'meta'
    const contactSent = trackAdBrowserStandardEvent(
      'meta',
      'Contact',
      { content_category: 'meta_live_synthetic_test' },
      contactId,
    )
    const registrationSent = trackAdBrowserStandardEvent(
      'meta',
      'CompleteRegistration',
      { content_category: 'meta_live_synthetic_test' },
      registrationId,
    )
    return contactSent && registrationSent
  }

  return {
    trackAnalytics: analytics.track,
    trackContact,
    executeBrowserInstructions,
    trackPageView,
    teardownAdBrowserTracking,
    clearAdAttribution,
    trackViewContent,
    trackSearch,
    buildRegistrationAttributionContext,
    sendMetaLiveChallenge,
  }
}

function consentScopedBody<T extends Record<string, unknown>>(
  baseBody: T,
  marketingConsent: ReturnType<typeof useMarketingConsent>,
  clickIds: { fbclid?: unknown; ttclid?: unknown },
  maximumConsentScope: MarketingConsentScope,
) {
  const consentScope = scopedMarketingConsent(marketingConsent, maximumConsentScope)
  if (consentScope !== 'granted') clearPersistedAdClickIdentifiers()
  return {
    ...baseBody,
    consentState: consentScope,
    ...(consentScope === 'granted' && typeof document !== 'undefined'
      ? { browserIdentifiers: readBrowserIdentifiers(clickIds) }
      : {}),
  }
}

function readBrowserIdentifiers(clickIds: { fbclid?: unknown; ttclid?: unknown }) {
  const persisted = tikTokClickIdCookie(clickIds.ttclid)
  if (persisted) document.cookie = persisted
  return readAdPlatformBrowserIdentifiers(document.cookie, clickIds)
}

function clearPersistedAdClickIdentifiers() {
  if (typeof document !== 'undefined') document.cookie = clearTikTokClickIdCookie()
}

function canDeliverMarketing(marketingConsent: ReturnType<typeof useMarketingConsent>) {
  return currentMarketingConsentScope(marketingConsent) === 'granted'
}

function trustedAdAttributionState(adAttribution: ReturnType<typeof useAdAttribution>) {
  return adAttribution.provider.value
    && (adAttribution.resolution.value === 'matched' || adAttribution.resolution.value === 'inherited')
    ? 'resolved' as const
    : 'suppress' as const
}

function currentMarketingConsentScope(
  marketingConsent: ReturnType<typeof useMarketingConsent>,
): MarketingConsentScope {
  if (marketingConsent.state.value === 'denied') return 'denied'
  return marketingConsent.state.value === 'granted' && marketingConsent.canTrackMarketing.value ? 'granted' : 'limited'
}

function scopedMarketingConsent(
  marketingConsent: ReturnType<typeof useMarketingConsent>,
  maximumConsentScope: MarketingConsentScope,
): MarketingConsentScope {
  const currentScope = currentMarketingConsentScope(marketingConsent)
  const rank: Record<MarketingConsentScope, number> = { denied: 0, limited: 1, granted: 2 }
  return rank[currentScope] <= rank[maximumConsentScope] ? currentScope : maximumConsentScope
}

function isAdBrowserInstruction(value: unknown): value is AdBrowserInstruction {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<AdBrowserInstruction> & { eventName?: unknown }
  return isRegisteredAdBrowserProvider(event.provider)
    && typeof event.deliveryId === 'string'
    && event.deliveryId.length > 0
    && (event.eventName === 'Contact' || event.eventName === 'CompleteRegistration')
    && typeof event.eventId === 'string'
    && event.eventId.length > 0
    && Boolean(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
    && typeof event.receiptToken === 'string'
    && event.receiptToken.length > 0
}

function normalizeBrowserInstruction(value: unknown): AdBrowserInstruction | null {
  return isAdBrowserInstruction(value) ? value : null
}

function isMarketingRouteAllowed(fullPath: string) {
  let pathname: string
  try {
    pathname = new URL(fullPath, 'https://site.local').pathname
  } catch {
    pathname = fullPath.split(/[?#]/)[0] || fullPath
  }
  return !isAdminPath(pathname) && !hasSensitiveAnalyticsUrl(fullPath)
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
    let instructions: unknown[]
    try {
      instructions = await entry.send()
    } catch {
      if (entry.attempts < 2) failedConversionRetries.push({ ...entry, attempts: entry.attempts + 1 })
      else completeLocally(entry.complete, [])
      continue
    }
    completeLocally(entry.complete, instructions)
  }
  scheduleFailedConversionRetry()
}

function completeLocally(complete: (instructions: unknown[]) => void, instructions: unknown[]) {
  try {
    complete(instructions)
  } catch {
    // 一方事实已提交成功，本地 analytics / Pixel 失败不得触发 conversion 重试。
  }
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

function trackingInstructionsFromResponse(response: unknown): unknown[] {
  const instructions = (response as { data?: { trackingInstructions?: unknown } } | null)?.data?.trackingInstructions
  return Array.isArray(instructions) ? instructions : []
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
