import type { AnalyticsConsentState, ConversionActionType, ConversionMetaEventName } from '@meigallery/shared'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'

type PublicConversionActionType = Extract<ConversionActionType, 'contact' | 'complete_registration' | 'start_trial'>

type TrackConversionOptions = {
  methodType?: string
  actionTarget?: string
  metadata?: Record<string, unknown>
}

type AnalyticsContext = ReturnType<ReturnType<typeof useAnalytics>['getContext']> & {
  sourceChannel?: string
}

const META_EVENT: Partial<Record<ConversionActionType, ConversionMetaEventName>> = {
  contact: 'Contact',
  lead: 'Lead',
  complete_registration: 'CompleteRegistration',
  start_trial: 'StartTrial',
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
])

const SENSITIVE_KEY_PARTS = ['token', 'secret', 'password', 'credential', 'cookie', 'jwt', 'signature']

export function useConversionTracking() {
  const { api } = useApi()
  const route = useRoute()
  const analytics = useAnalytics()
  const pixel = useFacebookPixel()

  async function trackConversion(actionType: PublicConversionActionType, options: TrackConversionOptions = {}) {
    const context = analytics.getContext() as AnalyticsContext
    const occurredAt = new Date().toISOString()
    const occurredDate = occurredAt.slice(0, 10)
    const metaEventName = META_EVENT[actionType]
    const eventID = metaEventName
      ? buildExternalEventId({
        actionType,
        metaEventName,
        sessionId: context.sessionId,
        visitorId: context.visitorId,
        occurredDate,
        methodType: options.methodType,
        actionTarget: options.actionTarget,
      })
      : ''
    const metadata = sanitizeConversionMetadata(options.metadata || {})
    const body = {
      actionType,
      visitorId: normalizeText(context.visitorId, 120),
      sessionId: normalizeText(context.sessionId, 120),
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
      consentState: normalizeConsentState(context.consentState),
      methodType: normalizeText(options.methodType, 80),
      actionTarget: normalizeText(options.actionTarget, 120),
      metadata,
    }

    try {
      await api('/api/conversions/events', { method: 'POST', body })
    } catch {
      // 转化 API 失败不应阻断站内兼容事件或 Pixel 上报。
    }
    trackAnalyticsCompatibility(actionType, analytics, options, eventID)
    if (metaEventName && body.consentState === 'granted') {
      pixel.trackStandardEvent(metaEventName, metadata, { eventID })
    }
  }

  return { trackConversion }
}

function trackAnalyticsCompatibility(
  actionType: ConversionActionType,
  analytics: ReturnType<typeof useAnalytics>,
  options: TrackConversionOptions,
  eventId: string,
) {
  if (actionType === 'contact') {
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
  if (actionType === 'complete_registration') {
    analytics.track('register_success', {
      eventId,
      entityType: 'auth',
      flush: true,
      props: {
        method: normalizeText(options.metadata?.method, 40) || 'email',
      },
    })
  }
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

function buildExternalEventId(input: {
  actionType: PublicConversionActionType
  metaEventName: ConversionMetaEventName
  sessionId: string
  visitorId: string
  occurredDate: string
  methodType?: string
  actionTarget?: string
}) {
  return `meta:${input.metaEventName}:${buildConversionDedupeKey(input)}`
}

function buildConversionDedupeKey(input: {
  actionType: PublicConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  methodType?: string
  actionTarget?: string
}) {
  if (input.actionType === 'contact') {
    return `contact:${input.sessionId}:${normalizeKeyPart(input.methodType)}:${normalizeKeyPart(input.actionTarget)}`
  }
  if (input.actionType === 'complete_registration' || input.actionType === 'start_trial') {
    return `${input.actionType}:${input.sessionId}:${input.occurredDate}`
  }
  return `${input.actionType}:${input.visitorId}:${input.occurredDate}`
}

function sourceChannelFromContext(context: AnalyticsContext) {
  if (context.sourceContext.sourceName || context.sourceContext.utmSource || context.sourceContext.trackingSourceSlug) return 'ad'
  return 'unknown'
}

function normalizeConsentState(value: AnalyticsConsentState | string): AnalyticsConsentState {
  if (value === 'granted' || value === 'denied') return value
  return 'limited'
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

function normalizeKeyPart(value: unknown) {
  const text = String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  return text || 'unknown'
}
