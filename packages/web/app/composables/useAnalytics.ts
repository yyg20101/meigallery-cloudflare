import type {
  AnalyticsBatchRequest,
  AnalyticsBatchResponse,
  AnalyticsConsentState,
  AnalyticsEntityType,
  AnalyticsEventName,
  AnalyticsEventPayload,
  AnalyticsPropValue,
  AnalyticsSourceChannel,
} from '@meigallery/shared'
import { ANALYTICS_LIMITS, ANALYTICS_RETENTION } from '@meigallery/shared/constants'
import { normalizeAnalyticsRoute, type AnalyticsRouteLike } from '~/utils/analyticsRoute'
import {
  detectAnalyticsDeviceType,
  getViewportBucket,
  normalizeAnalyticsConsentState,
  normalizeAnalyticsSourceChannel,
  sanitizeAnalyticsProps,
  sanitizeAnalyticsTitle,
} from '~/utils/analyticsSanitizer'

type AnalyticsApi = <T = unknown>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>

interface AnalyticsState {
  enabled: boolean
  initialized: boolean
  visitorId: string
  sessionId: string
  userId: number | null
  consentState: AnalyticsConsentState
  sourceChannel: AnalyticsSourceChannel
  sourceContext: AnalyticsSourceContext
  queue: AnalyticsEventPayload[]
  pageViewCount: number
  currentRoute: { routeName: string; path: string } | null
  currentPageStartedAt: number
  currentPageActiveSeconds: number
  currentMaxScrollDepth: number
  lastActivityAt: number
}

interface AnalyticsInitOptions {
  enabled: boolean
  consentState?: AnalyticsConsentState | string
  sourceChannel?: AnalyticsSourceChannel | string
  sourceContext?: Partial<AnalyticsSourceContext>
  api?: AnalyticsApi
  baseURL?: string
  route?: AnalyticsRouteLike
}

export interface AnalyticsSourceContext {
  referrer: string
  referrerHost: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  trackingSourceSlug: string
  sourceName: string
}

interface TrackOptions {
  eventId?: string
  route?: AnalyticsRouteLike
  props?: Record<string, AnalyticsPropValue | undefined>
  value?: number
  entityType?: AnalyticsEntityType
  entityId?: string
  sourceChannel?: AnalyticsSourceChannel | string
  flush?: boolean
}

interface FlushOptions {
  beacon?: boolean
}

const VISITOR_KEY = 'mg_analytics_visitor_id'
const SESSION_KEY = 'mg_analytics_session'
const FAILED_QUEUE_KEY = 'mg_analytics_failed_queue'
const VISITOR_TTL_MS = ANALYTICS_RETENTION.VISITOR_TTL_DAYS * 24 * 60 * 60 * 1000
const SESSION_IDLE_MS = ANALYTICS_RETENTION.SESSION_IDLE_MINUTES * 60 * 1000
const NON_ESSENTIAL_LIMITED_EVENTS = new Set<AnalyticsEventName>([
  'gallery_card_impression',
  'gallery_card_click',
  'home_ad_impression',
  'home_ad_click',
  'media_thumbnail_impression',
  'media_viewer_open',
  'scroll_depth',
  'engagement_ping',
  'filter_selected',
  'filter_removed',
  'sort_changed',
  'load_more',
  'contact_qr_expand',
])

let analyticsApi: AnalyticsApi | null = null
let analyticsBaseURL = ''
let flushTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function useAnalytics() {
  const { api, baseURL } = useApi()
  const state = useState<AnalyticsState>('analytics-state', createInitialAnalyticsState)
  analyticsApi = api
  analyticsBaseURL = baseURL

  function initialize(options: AnalyticsInitOptions) {
    analyticsApi = options.api ?? analyticsApi ?? api
    analyticsBaseURL = options.baseURL ?? analyticsBaseURL ?? baseURL
    if (!isBrowser() || !options.enabled) {
      state.value.enabled = false
      return
    }

    const now = Date.now()
    const visitorId = readVisitorId(now) || createAnalyticsId('visitor')
    const session = readSession(now)
    state.value = {
      ...state.value,
      enabled: true,
      initialized: true,
      visitorId,
      sessionId: session || createAnalyticsId('session'),
      consentState: normalizeAnalyticsConsentState(options.consentState),
      sourceChannel: normalizeAnalyticsSourceChannel(options.sourceChannel),
      sourceContext: normalizeSourceContext(options.sourceContext),
      lastActivityAt: now,
    }
    persistVisitorId(visitorId, now)
    persistSessionId(state.value.sessionId, now)
    restoreFailedQueue(state.value)
    ensureFlushTimer(() => {
      void flush()
    })
    ensureHeartbeatTimer(state.value)
    track('session_start', { route: options.route, props: { source_channel: state.value.sourceChannel } })
  }

  function track(eventName: AnalyticsEventName, options: TrackOptions = {}) {
    if (!isBrowser() || !state.value.enabled || !state.value.initialized) return
    if (state.value.consentState === 'denied') return
    if (state.value.consentState === 'limited' && NON_ESSENTIAL_LIMITED_EVENTS.has(eventName)) return

    const normalizedRoute = normalizeAnalyticsRoute(options.route || currentRouteLike())
    if (normalizedRoute.skip) return

    const event: AnalyticsEventPayload = {
      eventId: options.eventId || createAnalyticsId(eventName),
      eventName,
      occurredAt: new Date().toISOString(),
      routeName: normalizedRoute.routeName,
      path: normalizedRoute.path,
      pageTitle: sanitizeAnalyticsTitle(document.title),
      referrer: state.value.sourceContext.referrer,
      referrerHost: state.value.sourceContext.referrerHost,
      utmSource: state.value.sourceContext.utmSource,
      utmMedium: state.value.sourceContext.utmMedium,
      utmCampaign: state.value.sourceContext.utmCampaign,
      trackingSourceSlug: state.value.sourceContext.trackingSourceSlug,
      sourceChannel: normalizeAnalyticsSourceChannel(options.sourceChannel ?? state.value.sourceChannel),
      deviceType: detectAnalyticsDeviceType(),
      viewportWidth: getViewportBucket(),
      consentState: state.value.consentState,
      entityType: options.entityType ?? normalizedRoute.entityType,
      entityId: options.entityId ?? normalizedRoute.entityId,
      props: sanitizeAnalyticsProps({
        ...sourceContextProps(state.value.sourceContext),
        ...options.props,
        viewport_bucket: getViewportBucket(),
      }),
      value: Number.isFinite(options.value) ? options.value : undefined,
    }

    state.value.queue.push(event)
    state.value.queue = state.value.queue.slice(-ANALYTICS_LIMITS.QUEUE_MAX_EVENTS)
    state.value.lastActivityAt = Date.now()
    persistSessionId(state.value.sessionId, state.value.lastActivityAt)

    if (state.value.queue.length >= ANALYTICS_LIMITS.BATCH_EVENT_LIMIT || options.flush) {
      void flush()
    }
  }

  function trackPageView(route?: AnalyticsRouteLike) {
    const normalizedRoute = normalizeAnalyticsRoute(route || currentRouteLike())
    if (normalizedRoute.skip) return
    state.value.pageViewCount += 1
    state.value.currentRoute = { routeName: normalizedRoute.routeName, path: normalizedRoute.path }
    state.value.currentPageStartedAt = Date.now()
    state.value.currentPageActiveSeconds = 0
    state.value.currentMaxScrollDepth = 0
    track('page_view', {
      route,
      entityType: normalizedRoute.entityType,
      entityId: normalizedRoute.entityId,
      props: {
        is_landing: state.value.pageViewCount === 1,
        entry_path: state.value.pageViewCount === 1 ? normalizedRoute.path : undefined,
      },
    })
  }

  function trackClick(params: {
    eventName?: AnalyticsEventName
    elementId: string
    elementType: string
    location: string
    targetType?: string
    targetId?: string
    route?: AnalyticsRouteLike
  }) {
    track(params.eventName ?? 'membership_cta_click', {
      route: params.route,
      props: {
        element_id: params.elementId,
        element_type: params.elementType,
        location: params.location,
        target_type: params.targetType,
        target_id: params.targetId,
      },
    })
  }

  function trackPageLeave(route?: AnalyticsRouteLike) {
    if (!state.value.currentRoute && !route) return
    const activeSeconds = consumeCurrentPageActiveSeconds(state.value)
    track('page_leave', {
      route,
      props: {
        active_seconds: activeSeconds,
        max_scroll_depth: state.value.currentMaxScrollDepth,
        is_bounce: state.value.pageViewCount <= 1 && activeSeconds < 15,
      },
      value: activeSeconds,
    })
  }

  async function flush(options: FlushOptions = {}): Promise<AnalyticsBatchResponse | null> {
    if (!isBrowser() || !state.value.enabled || !state.value.queue.length) return null
    const events = state.value.queue.splice(0, ANALYTICS_LIMITS.BATCH_EVENT_LIMIT)
    const body: AnalyticsBatchRequest = {
      visitorId: state.value.visitorId,
      sessionId: state.value.sessionId,
      events,
    }

    if (options.beacon && sendBeacon('/api/analytics/events', body)) return null

    try {
      return await (analyticsApi ?? api)<AnalyticsBatchResponse>('/api/analytics/events', {
        method: 'POST',
        body,
      })
    } catch {
      state.value.queue = [...events, ...state.value.queue].slice(-ANALYTICS_LIMITS.QUEUE_MAX_EVENTS)
      persistFailedQueue(state.value.queue)
      return null
    }
  }

  function sendSessionEnd(options: FlushOptions = {}) {
    if (!isBrowser() || !state.value.enabled) return
    const activeSeconds = consumeCurrentPageActiveSeconds(state.value)
    const body = {
      visitorId: state.value.visitorId,
      sessionId: state.value.sessionId,
      occurredAt: new Date().toISOString(),
      routeName: state.value.currentRoute?.routeName ?? 'session',
      path: state.value.currentRoute?.path ?? '/',
      activeSeconds,
      pageViewCount: state.value.pageViewCount,
    }
    if (options.beacon && sendBeacon('/api/analytics/session/end', body)) return
    void (analyticsApi ?? api)('/api/analytics/session/end', { method: 'POST', body })
  }

  function identifyUser(userId: number | null) {
    state.value.userId = userId
  }

  function setConsentState(consentState: AnalyticsConsentState | string) {
    state.value.consentState = normalizeAnalyticsConsentState(consentState)
  }

  function getContext() {
    return {
      visitorId: state.value.visitorId,
      sessionId: state.value.sessionId,
      consentState: state.value.consentState,
      sourceChannel: state.value.sourceChannel,
      sourceContext: state.value.sourceContext,
    }
  }

  function updateScrollDepth(depthPercent: number) {
    if (!Number.isFinite(depthPercent)) return
    state.value.currentMaxScrollDepth = Math.max(state.value.currentMaxScrollDepth, Math.min(100, Math.max(0, Math.round(depthPercent))))
  }

  return {
    state,
    initialize,
    track,
    trackPageView,
    trackClick,
    trackPageLeave,
    flush,
    sendSessionEnd,
    identifyUser,
    setConsentState,
    getContext,
    updateScrollDepth,
  }
}

export function resetAnalyticsForTest() {
  analyticsApi = null
  analyticsBaseURL = ''
  if (flushTimer) clearInterval(flushTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  flushTimer = null
  heartbeatTimer = null
}

function createInitialAnalyticsState(): AnalyticsState {
  return {
    enabled: false,
    initialized: false,
    visitorId: '',
    sessionId: '',
    userId: null,
    consentState: 'limited',
    sourceChannel: 'unknown',
    sourceContext: normalizeSourceContext(),
    queue: [],
    pageViewCount: 0,
    currentRoute: null,
    currentPageStartedAt: 0,
    currentPageActiveSeconds: 0,
    currentMaxScrollDepth: 0,
    lastActivityAt: 0,
  }
}

function normalizeSourceContext(input: Partial<AnalyticsSourceContext> = {}): AnalyticsSourceContext {
  return {
    referrer: normalizeContextText(input.referrer, 240),
    referrerHost: normalizeContextText(input.referrerHost, 120),
    utmSource: normalizeContextText(input.utmSource, 120).toLowerCase(),
    utmMedium: normalizeContextText(input.utmMedium, 120).toLowerCase(),
    utmCampaign: normalizeContextText(input.utmCampaign, 120).toLowerCase(),
    trackingSourceSlug: normalizeContextText(input.trackingSourceSlug, 120).toLowerCase(),
    sourceName: normalizeContextText(input.sourceName, 120).toLowerCase(),
  }
}

function sourceContextProps(context: AnalyticsSourceContext): Record<string, AnalyticsPropValue | undefined> {
  return {
    source_name: context.sourceName || context.utmSource || context.trackingSourceSlug || undefined,
    tracking_source_slug: context.trackingSourceSlug || undefined,
    utm_source: context.utmSource || undefined,
    utm_medium: context.utmMedium || undefined,
    utm_campaign: context.utmCampaign || undefined,
  }
}

function normalizeContextText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function ensureFlushTimer(flushCallback: () => void) {
  if (flushTimer || !isBrowser()) return
  flushTimer = setInterval(() => {
    flushCallback()
  }, ANALYTICS_LIMITS.FLUSH_INTERVAL_SECONDS * 1000)
}

function ensureHeartbeatTimer(state: AnalyticsState) {
  if (heartbeatTimer || !isBrowser()) return
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'hidden' || !state.currentPageStartedAt) return
    const now = Date.now()
    const elapsed = Math.max(0, Math.floor((now - state.currentPageStartedAt) / 1000))
    if (elapsed <= 0) return
    state.currentPageActiveSeconds = Math.min(
      ANALYTICS_LIMITS.PAGE_ACTIVE_SECONDS_CAP,
      state.currentPageActiveSeconds + elapsed,
    )
    state.currentPageStartedAt = now
  }, ANALYTICS_LIMITS.HEARTBEAT_SECONDS * 1000)
}

function consumeCurrentPageActiveSeconds(state: AnalyticsState) {
  const now = Date.now()
  const elapsed = state.currentPageStartedAt > 0 ? Math.floor((now - state.currentPageStartedAt) / 1000) : 0
  const activeSeconds = Math.min(ANALYTICS_LIMITS.PAGE_ACTIVE_SECONDS_CAP, Math.max(0, state.currentPageActiveSeconds + elapsed))
  state.currentPageStartedAt = now
  state.currentPageActiveSeconds = 0
  return activeSeconds
}

function createAnalyticsId(prefix: string) {
  const cryptoRef = globalThis.crypto
  if (cryptoRef?.randomUUID) return `${prefix}_${cryptoRef.randomUUID()}`
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function currentRouteLike(): AnalyticsRouteLike {
  try {
    return useRoute()
  } catch {
    return {
      fullPath: isBrowser() ? window.location.pathname + window.location.search : '/',
      path: isBrowser() ? window.location.pathname : '/',
    }
  }
}

function readVisitorId(now: number) {
  const raw = safeLocalStorage().getItem(VISITOR_KEY)
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { id?: string; updatedAt?: number }
    if (!parsed.id || !parsed.updatedAt || now - parsed.updatedAt > VISITOR_TTL_MS) return ''
    return parsed.id
  } catch {
    return ''
  }
}

function persistVisitorId(id: string, now: number) {
  safeLocalStorage().setItem(VISITOR_KEY, JSON.stringify({ id, updatedAt: now }))
  if (isBrowser()) {
    document.cookie = `${VISITOR_KEY}=${encodeURIComponent(id)}; Max-Age=${ANALYTICS_RETENTION.VISITOR_TTL_DAYS * 24 * 60 * 60}; Path=/; SameSite=Lax`
  }
}

function readSession(now: number) {
  const raw = safeSessionStorage().getItem(SESSION_KEY)
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { id?: string; updatedAt?: number }
    if (!parsed.id || !parsed.updatedAt || now - parsed.updatedAt > SESSION_IDLE_MS) return ''
    return parsed.id
  } catch {
    return ''
  }
}

function persistSessionId(id: string, now: number) {
  safeSessionStorage().setItem(SESSION_KEY, JSON.stringify({ id, updatedAt: now }))
}

function restoreFailedQueue(state: AnalyticsState) {
  const raw = safeLocalStorage().getItem(FAILED_QUEUE_KEY)
  if (!raw) return
  try {
    const events = JSON.parse(raw)
    if (Array.isArray(events)) state.queue = [...events, ...state.queue].slice(-ANALYTICS_LIMITS.QUEUE_MAX_EVENTS)
    safeLocalStorage().removeItem(FAILED_QUEUE_KEY)
  } catch {
    safeLocalStorage().removeItem(FAILED_QUEUE_KEY)
  }
}

function persistFailedQueue(events: AnalyticsEventPayload[]) {
  safeLocalStorage().setItem(FAILED_QUEUE_KEY, JSON.stringify(events.slice(-ANALYTICS_LIMITS.QUEUE_MAX_EVENTS)))
}

function sendBeacon(path: string, body: unknown) {
  if (!isBrowser() || !navigator.sendBeacon) return false
  const blob = new Blob([JSON.stringify(body)], { type: 'application/json' })
  return navigator.sendBeacon(`${analyticsBaseURL}${path}`, blob)
}

function safeLocalStorage(): Storage {
  if (isBrowser() && window.localStorage) return window.localStorage
  return memoryStorage
}

function safeSessionStorage(): Storage {
  if (isBrowser() && window.sessionStorage) return window.sessionStorage
  return memoryStorage
}

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() {
    return memory.size
  },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => {
    memory.delete(key)
  },
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}
