import type {
  AdAttributionProvider,
  AdBrowserEvent,
  AdBrowserPublicConfig,
  AdBrowserInstruction,
  AdBrowserSignal,
} from '@meigallery/shared'
import {
  createRandomAdExternalEventId,
  isAdExternalEventId,
  normalizeAnalyticsCampaignToken,
} from '@meigallery/shared/utils'
import {
  dispatchAdBrowserEvent,
  executeAdBrowserInstruction,
  initializeAdBrowserProvider,
  isRegisteredAdBrowserProvider,
  teardownAllAdBrowserProviders,
  trackAdBrowserSignal,
} from '~/adapters/adPlatformBrowser.client'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'
import {
  projectAdClickCookie,
  readAdPlatformBrowserIdentifiers,
} from '~/utils/adPlatformBrowserIdentifiers'
import { resolveConversionIdentity } from '~/utils/conversionIdentity'
import { isMarketingTrackingRoute } from '~/utils/marketingTrackingRoute'
import { sanitizeAnalyticsText } from '~/utils/trackingSanitizer'
import { readBrowserAdAttributionSignals } from '~/utils/adAttributionSignals'

export interface TrackContactInput {
  contactMethodId: string
  methodType: string
  actionType: 'open_link'
}

export interface TrackSearchInput {
  searchString: string
  resultCount: number
}

type BrowserPayload = Record<string, string | number | boolean>
type AnalyticsContext = ReturnType<ReturnType<typeof useAnalytics>['getContext']> & { sourceChannel?: string }
const CONTACT_EVENT_ID_STORAGE_PREFIX = 'mg_contact_event_id_v1:'

let lastTrackedPageKey = ''
let pendingPageView: {
  key: string
  task: Promise<void>
} | null = null
let pageViewGeneration = 0

export function useTracking() {
  const { api } = useApi()
  const route = useRoute()
  const analytics = useAnalytics()
  const adAttribution = useAdAttribution()

  async function trackContact(input: TrackContactInput) {
    if (input?.actionType !== 'open_link' || !safeIdentifier(input.contactMethodId)) return
    const routeAllowed = isMarketingTrackingRoute(route.fullPath)
    const context = analytics.getContext() as AnalyticsContext
    const identity = resolveConversionIdentity(context)
    const sourceContext = context.sourceContext || {}
    const eventTemplate = routeAllowed
      ? adAttribution.getBrowserEventTemplate(route, 'Contact')
      : null
    const externalEventId = eventTemplate
      ? contactExternalEventId(identity.sessionId, input)
      : ''
    const browserEvent = eventTemplate && externalEventId
      ? {
          ...eventTemplate,
          externalEventId,
          payload: {
            method_type: normalizeText(input.methodType, 80) || 'unknown',
          },
        } satisfies AdBrowserEvent
      : null

    if (browserEvent) void dispatchAdBrowserEvent(browserEvent)
    trackContactAnalytics(analytics, input, externalEventId)
    void analytics.flush({ beacon: true })

    const body = {
      actionType: 'open_link' as const,
      contactMethodId: input.contactMethodId,
      visitorId: identity.visitorId,
      sessionId: identity.sessionId,
      occurredAt: new Date().toISOString(),
      routeName: normalizeText(route.name || route.path, 120),
      path: safeRoutePath(route.fullPath, route.path),
      sourceChannel: normalizeText(context.sourceChannel || sourceChannelFromContext(context), 40) || 'unknown',
      sourceName: normalizeText(sourceContext.sourceName, 120),
      trackingSourceSlug: normalizeText(sourceContext.trackingSourceSlug, 120),
      utmSource: normalizeText(sourceContext.utmSource, 120),
      utmMedium: normalizeText(sourceContext.utmMedium, 120),
      utmCampaign: normalizeText(sourceContext.utmCampaign, 120),
      utmContent: normalizeAnalyticsCampaignToken(sourceContext.utmContent || queryValue(route.query.utm_content)),
      methodType: normalizeText(input.methodType, 80),
      adAttributionSignals: readBrowserAdAttributionSignals(route.query),
      metadata: { action_type: 'open_link' },
      ...(externalEventId ? { externalEventId } : {}),
    }

    await postConversionWithRetry(api, body)
  }

  async function executeBrowserInstructions(instructions: unknown[]) {
    if (!isMarketingTrackingRoute(route.fullPath) || !Array.isArray(instructions)) return
    for (const value of instructions) {
      const instruction = normalizeBrowserInstruction(value)
      if (!instruction || instruction.provider !== adAttribution.provider.value) continue
      if (!await activateCurrentAdBrowserProvider(instruction.provider)) continue
      await executeAdBrowserInstruction(instruction)
    }
  }

  async function trackPageView() {
    if (!isMarketingTrackingRoute(route.fullPath)) {
      await teardownAdBrowserTracking()
      return
    }
    const active = await resolveActiveBrowserProvider()
    if (!active) {
      await teardownAdBrowserTracking()
      return
    }
    const pageKey = `${configKey(active.config)}|${route.fullPath}`
    if (lastTrackedPageKey === pageKey) return
    if (pendingPageView?.key === pageKey) return pendingPageView.task

    const generation = pageViewGeneration
    const signalTask = trackAdBrowserSignal(active.provider, 'PageView', {}).then((tracked) => {
      if (tracked && generation === pageViewGeneration) lastTrackedPageKey = pageKey
    })
    const task = signalTask.finally(() => {
      if (pendingPageView?.task === task) pendingPageView = null
    })
    pendingPageView = { key: pageKey, task }
    return task
  }

  async function trackViewContent(payload: BrowserPayload) {
    await trackSignalForAttributedProvider('ViewContent', payload)
  }

  async function trackSearch(input: TrackSearchInput) {
    await trackSignalForAttributedProvider('Search', {
      search_string: sanitizeAnalyticsText(input.searchString, 80),
      result_count: Number.isFinite(input.resultCount) ? input.resultCount : 0,
    })
  }

  async function trackSignalForAttributedProvider(signal: AdBrowserSignal, payload: BrowserPayload) {
    if (!isMarketingTrackingRoute(route.fullPath)) return
    const active = await resolveActiveBrowserProvider()
    if (!active) {
      await teardownAdBrowserTracking()
      return
    }
    await trackAdBrowserSignal(active.provider, signal, payload)
  }

  async function resolveActiveBrowserProvider() {
    const provider = await adAttribution.resolve(route)
    if (!provider || !isRegisteredAdBrowserProvider(provider)) return null
    const config = adAttribution.publicConfig.value
    if (!config || config.provider !== provider) return null
    const initialized = await initializeAdBrowserProvider(config)
    return initialized ? { provider, config } : null
  }

  async function activateCurrentAdBrowserProvider(provider: AdAttributionProvider) {
    if (!isRegisteredAdBrowserProvider(provider)) return false
    const config = adAttribution.publicConfig.value
    if (!config || config.provider !== provider) return false
    return initializeAdBrowserProvider(config)
  }

  async function teardownAdBrowserTracking() {
    pageViewGeneration += 1
    lastTrackedPageKey = ''
    pendingPageView = null
    await teardownAllAdBrowserProviders()
  }

  async function buildRegistrationAttributionContext() {
    const routeAllowed = isMarketingTrackingRoute(route.fullPath)
    if (routeAllowed) await adAttribution.resolve(route)
    else await teardownAdBrowserTracking()
    const context = analytics.getContext() as AnalyticsContext
    const sourceContext = context.sourceContext || {}
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
      utmContent: normalizeAnalyticsCampaignToken(sourceContext.utmContent || queryValue(route.query.utm_content)),
      adAttributionSignals: readBrowserAdAttributionSignals(route.query),
      ...(routeAllowed && adAttribution.provider.value && typeof document !== 'undefined'
        ? { browserIdentifiers: readBrowserIdentifiers(adAttribution.provider.value, route.query) }
        : {}),
    }
  }

  return {
    trackAnalytics: analytics.track,
    trackContact,
    executeBrowserInstructions,
    trackPageView,
    teardownAdBrowserTracking,
    trackViewContent,
    trackSearch,
    buildRegistrationAttributionContext,
  }
}

function readBrowserIdentifiers(provider: AdAttributionProvider, clickIds: Record<string, unknown>) {
  const persisted = projectAdClickCookie(provider, clickIds)
  if (persisted) document.cookie = persisted
  return readAdPlatformBrowserIdentifiers(provider, document.cookie, clickIds)
}

function normalizeBrowserInstruction(value: unknown): AdBrowserInstruction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const instruction = value as Record<string, unknown>
  if (!exactKeys(instruction, ['provider', 'canonicalEvent', 'externalEventId', 'descriptor', 'payload'])
    || !isRegisteredAdBrowserProvider(instruction.provider)
    || (instruction.canonicalEvent !== 'Contact' && instruction.canonicalEvent !== 'CompleteRegistration')
    || !isAdExternalEventId(instruction.externalEventId)
    || !safeBrowserPayload(instruction.payload)) return null
  const descriptor = instruction.descriptor
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null
  const mapping = descriptor as Record<string, unknown>
  if (!exactKeys(mapping, ['provider', 'canonicalEvent', 'browserEventName', 'browserDestination', 'serverDestination'])
    || mapping.provider !== instruction.provider
    || mapping.canonicalEvent !== instruction.canonicalEvent
    || !safeDescriptorText(mapping.browserDestination)
    || !safeDescriptorText(mapping.serverDestination)
    || (instruction.provider === 'google'
      ? mapping.browserEventName !== 'conversion'
      : mapping.browserEventName !== instruction.canonicalEvent)) return null
  return value as AdBrowserInstruction
}

function safeBrowserPayload(value: unknown): value is BrowserPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, item]) => (
    key.length <= 80
    && !/(?:email|phone|click|gclid|gbraid|wbraid|fbp|fbc|ttclid|ttp|token)/i.test(key)
    && (typeof item === 'boolean' || typeof item === 'number' || (typeof item === 'string' && item.length <= 200 && !/[@\r\n]/.test(item)))
  ))
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => key in value)
}

function safeDescriptorText(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\p{Cc}/u.test(value)
}

function trackContactAnalytics(analytics: ReturnType<typeof useAnalytics>, input: TrackContactInput, eventId: string) {
  analytics.track('contact_method_click', {
    eventId,
    entityType: 'contact',
    props: {
      contact_method_id: input.contactMethodId,
      method_type: normalizeText(input.methodType, 80) || 'unknown',
      action_type: 'open_link',
      location: 'floating_contact_panel',
    },
  })
}

function contactExternalEventId(sessionId: string, input: TrackContactInput) {
  const key = contactEventStorageKey(sessionId, input)
  try {
    const stored = sessionStorage.getItem(key)
    if (isAdExternalEventId(stored)) return stored
    const created = createRandomAdExternalEventId()
    sessionStorage.setItem(key, created)
    return created
  }
  catch {
    try { return createRandomAdExternalEventId() }
    catch { return '' }
  }
}

function contactEventStorageKey(sessionId: string, input: TrackContactInput) {
  return `${CONTACT_EVENT_ID_STORAGE_PREFIX}${encodeURIComponent([
    sessionId,
    input.contactMethodId,
    normalizeText(input.methodType, 80),
  ].join(':'))}`
}

function sourceChannelFromContext(context: AnalyticsContext) {
  const source = context.sourceContext || {}
  return source.sourceName || source.utmSource || source.trackingSourceSlug ? 'ad' : 'unknown'
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

function safeIdentifier(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

async function postConversionWithRetry(
  request: ReturnType<typeof useApi>['api'],
  body: Record<string, unknown>,
) {
  const delays = [100, 250] as const
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await request('/api/conversions/events', {
        method: 'POST',
        body,
        keepalive: true,
      })
    }
    catch (error) {
      if (attempt === delays.length || !isRetryableConversionError(error)) return null
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
  return null
}

function isRetryableConversionError(error: unknown) {
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null
  const rawStatus = candidate?.statusCode ?? candidate?.status ?? candidate?.response?.status
  if (rawStatus === undefined || rawStatus === null) return true
  const status = Number(rawStatus)
  return Number.isInteger(status) && (status === 408 || status === 425 || status === 429 || status >= 500)
}

function configKey(config: AdBrowserPublicConfig) {
  return JSON.stringify(config)
}
