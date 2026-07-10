import type { ConversionActionType, MetaPixelInstruction } from '@meigallery/shared'
import { sanitizeAnalyticsPath } from '~/utils/analyticsSanitizer'
import { readMetaBrowserIdentifiers } from '~/utils/metaBrowserIdentifiers'

type PublicConversionActionType = Extract<ConversionActionType, 'contact' | 'complete_registration'>

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
  send: () => Promise<MetaPixelInstruction[]>
  complete: (instructions: MetaPixelInstruction[]) => void
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

export function useConversionTracking() {
  const { api } = useApi()
  const route = useRoute()
  const analytics = useAnalytics()
  const pixel = useFacebookPixel()
  const marketingConsent = useMarketingConsent()

  async function trackConversion(actionType: PublicConversionActionType, options: TrackConversionOptions = {}) {
    const context = analytics.getContext() as AnalyticsContext
    const occurredAt = new Date().toISOString()
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
      consentState: marketingConsent.state.value,
      methodType: normalizeText(options.methodType, 80),
      actionTarget: normalizeText(options.actionTarget, 120),
      metadata,
      ...(marketingConsent.state.value === 'granted' && typeof document !== 'undefined'
        ? { browserIdentifiers: readMetaBrowserIdentifiers(document.cookie, route.query.fbclid) }
        : {}),
    }

    const send = async () => {
      const response = await api('/api/conversions/events', { method: 'POST', body })
      return pixelEventsFromResponse(response)
    }
    const deliver = (instructions: MetaPixelInstruction[]) => {
      for (const instruction of instructions) {
        const attempted = pixel.trackStandardEvent(instruction.eventName, instruction.payload, { eventID: instruction.eventId })
        if (attempted === true) reportPixelAttempted(() => api('/api/conversions/pixel-receipts', {
          method: 'POST',
          body: {
            deliveryId: instruction.deliveryId,
            attempted: true,
            receiptToken: instruction.receiptToken,
          },
        }))
      }
    }
    const complete = (instructions: MetaPixelInstruction[]) => {
      trackAnalyticsCompatibility(actionType, analytics, options, instructions[0]?.eventId || '')
      deliver(instructions)
    }

    let pixelEvents: MetaPixelInstruction[] = []
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

function pixelEventsFromResponse(response: unknown): MetaPixelInstruction[] {
  const events = (response as { data?: { pixelEvents?: unknown } } | null)?.data?.pixelEvents
  if (!Array.isArray(events)) return []
  return events.filter(isMetaPixelInstruction)
}

function isMetaPixelInstruction(value: unknown): value is MetaPixelInstruction {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<MetaPixelInstruction>
  return typeof event.deliveryId === 'string'
    && (event.eventName === 'Contact' || event.eventName === 'Lead' || event.eventName === 'CompleteRegistration')
    && typeof event.eventId === 'string'
    && Boolean(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))
    && typeof event.receiptToken === 'string'
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
