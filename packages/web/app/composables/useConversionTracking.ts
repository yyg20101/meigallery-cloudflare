import type { PublicConversionActionType } from '@meigallery/shared'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'
import { resolveConversionIdentity } from '~/utils/conversionIdentity'
import { readMetaBrowserIdentifiers } from '~/utils/metaBrowserIdentifiers'

type TrackConversionOptions = {
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

type AnalyticsContext = ReturnType<ReturnType<typeof useAnalytics>['getContext']> & {
  sourceChannel?: string
}

const SENSITIVE_METADATA_KEYS = new Set([
  'email',
  'handle',
  'href',
  'phone',
  'value',
  'contactvalue',
  'contact_value',
  'linkurl',
  'link_url',
  'url',
  'token',
  'fbp',
  'fbc',
  'client_ip_address',
  'client_user_agent',
  'user_agent',
])

const SENSITIVE_KEY_PARTS = ['token', 'secret', 'password', 'credential', 'cookie', 'jwt', 'signature']

type FailedConversionRetry = {
  send: () => Promise<unknown[]>
  complete: (instructions: unknown[]) => void
  attempts: number
}

const failedConversionRetries: FailedConversionRetry[] = []
let conversionRetryTimer: ReturnType<typeof setTimeout> | null = null

export function useConversionTracking() {
  const { api } = useApi()
  const route = useRoute()
  const analytics = useAnalytics()
  const tracking = useTracking()
  const marketingConsent = useMarketingConsent()

  async function trackConversion(actionType: PublicConversionActionType, options: TrackConversionOptions = {}) {
    const context = analytics.getContext() as AnalyticsContext
    const identity = resolveConversionIdentity(context)
    const occurredAt = new Date().toISOString()
    const metadata = sanitizeConversionMetadata(options.metadata || {})
    const baseBody = {
      actionType,
      visitorId: identity.visitorId,
      sessionId: identity.sessionId,
      occurredAt,
      routeName: route.name ? String(route.name) : normalizeText(route.path, 120),
      path: safeRoutePath(route.fullPath, route.path),
      sourceChannel: normalizeText(context.sourceChannel || sourceChannelFromContext(context), 40) || 'unknown',
      sourceName: normalizeText(context.sourceContext.sourceName, 120),
      trackingSourceSlug: normalizeText(context.sourceContext.trackingSourceSlug, 120),
      utmSource: normalizeText(context.sourceContext.utmSource, 120),
      utmMedium: normalizeText(context.sourceContext.utmMedium, 120),
      utmCampaign: normalizeText(context.sourceContext.utmCampaign, 120),
      utmContent: queryValue(route.query.utm_content),
      methodType: normalizeText(options.methodType, 80),
      actionTarget: normalizeText(options.actionTarget, 120),
      metadata,
    }

    const send = async () => {
      const body = consentScopedBody(baseBody, marketingConsent, route.query.fbclid)
      const response = await api('/api/conversions/events', { method: 'POST', body })
      return pixelEventsFromResponse(response)
    }
    const complete = (instructions: unknown[]) => {
      trackAnalyticsCompatibility(analytics, options, firstInstructionEventId(instructions))
      tracking.executePixelInstructions(instructions)
    }

    let pixelEvents: unknown[]
    try {
      pixelEvents = await send()
    } catch {
      queueFailedConversionRetry({ send, complete, attempts: 0 })
      return
    }
    complete(pixelEvents)
  }

  return { trackConversion }
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
      if (entry.attempts < 2) {
        failedConversionRetries.push({ ...entry, attempts: entry.attempts + 1 })
      } else {
        entry.complete([])
      }
    }
  }
  scheduleFailedConversionRetry()
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

function trackAnalyticsCompatibility(
  analytics: ReturnType<typeof useAnalytics>,
  options: TrackConversionOptions,
  eventId: string,
) {
  analytics.track('contact_method_click', {
    eventId,
    entityType: 'contact',
    flush: true,
    props: {
      method_type: normalizeText(options.methodType, 80) || 'unknown',
      action_type: normalizeText(options.metadata?.action_type, 40) || 'open_link',
      location: normalizeText(options.actionTarget, 120) || 'floating_contact_panel',
    },
  })
}

function sanitizeConversionMetadata(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input).slice(0, 24)) {
    const normalizedKey = normalizeMetadataKey(key)
    if (isSensitiveMetadataKey(normalizedKey)) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      const sanitized = sanitizeMetadataStringValue(value)
      if (sanitized) output[key] = sanitized
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value
    } else if (typeof value === 'boolean') {
      output[key] = value
    }
  }
  return output
}

function sourceChannelFromContext(context: AnalyticsContext) {
  if (context.sourceContext.sourceName || context.sourceContext.utmSource || context.sourceContext.trackingSourceSlug) return 'ad'
  return 'unknown'
}

function normalizeMetadataKey(key: string) {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function isSensitiveMetadataKey(normalizedKey: string) {
  if (SENSITIVE_METADATA_KEYS.has(normalizedKey)) return true
  return SENSITIVE_KEY_PARTS.some(part => normalizedKey.includes(part))
}

function sanitizeMetadataStringValue(value: string) {
  const sanitized = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted_email]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[redacted_url]')
    .replace(/(^|[^a-zA-Z0-9_])@[a-zA-Z0-9_][a-zA-Z0-9._-]{2,}(?=$|[^a-zA-Z0-9_])/g, '$1[redacted_contact]')
    .replace(
      /(^|[^a-zA-Z0-9_])(?:微信|wechat|wx)\s*(?:[:：=号]\s*)?(?:wxid_[a-zA-Z0-9._-]{3,}|@?[a-zA-Z0-9._-]*(?:\d|[_-])[a-zA-Z0-9._-]{2,})(?=$|[^a-zA-Z0-9_])/gi,
      '$1[redacted_contact]',
    )
    .replace(
      /(^|[^a-zA-Z0-9_])(?:telegram|tg)\s*(?:(?:[:：=]\s*)?[＠@][a-zA-Z0-9_][a-zA-Z0-9._-]{2,}|[:：=]\s*[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\d|[_-])[a-zA-Z0-9._-]*)(?=$|[^a-zA-Z0-9_])/gi,
      '$1[redacted_contact]',
    )
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted_phone]')
    .replace(/(?:^|[?\s&#;])([^=\s&?#;]+)=([^\s&?#;]+)/g, (match, rawName: string) => {
      return isSensitiveMetadataKey(normalizeMetadataKey(rawName)) ? match.replace(/=.*/, '=[redacted_credential]') : match
    })
    .trim()
    .slice(0, 120)
  return sanitized && !/^(?:[\s,，;；:/：|、-]*\[redacted_(?:email|phone|url|credential|contact)\])+[\s,，;；:/：|、-]*$/.test(sanitized)
    ? sanitized
    : null
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  return sanitizeMetadataStringValue(String(raw ?? '')) || ''
}

function safeRoutePath(fullPath: string, path: string) {
  return sanitizeAnalyticsPath(fullPath) || sanitizeAnalyticsPath(path) || '/'
}

function normalizeText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}
