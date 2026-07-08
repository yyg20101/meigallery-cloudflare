import type { ConversionActionType, ConversionMetaEventName } from '@meigallery/shared'
import { ATTRIBUTION_LIMITS, META_EVENT_BY_CONVERSION } from '@meigallery/shared/constants'

type ConversionDedupeInput = {
  actionType: ConversionActionType
  sessionId: string
  visitorId: string
  occurredDate: string
  methodType?: string
  actionTarget?: string
}

const SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'nickname',
  'username',
  'contact_value',
  'contactValue',
  'token',
  'session_token',
  'private_url',
  'r2_key',
])

export function metaEventForConversion(actionType: ConversionActionType): ConversionMetaEventName | null {
  return META_EVENT_BY_CONVERSION[actionType]
}

export function buildConversionDedupeKey(input: ConversionDedupeInput) {
  if (input.actionType === 'contact' || input.actionType === 'lead') {
    return `${input.actionType}:${input.sessionId}:${normalizeKeyPart(input.methodType)}:${normalizeKeyPart(input.actionTarget)}`
  }
  if (input.actionType === 'complete_registration' || input.actionType === 'start_trial') {
    return `${input.actionType}:${input.sessionId}:${input.occurredDate}`
  }
  return `${input.actionType}:${input.visitorId}:${input.occurredDate}`
}

export function buildExternalEventId(input: ConversionDedupeInput & { metaEventName: ConversionMetaEventName }) {
  return `meta:${input.metaEventName}:${buildConversionDedupeKey(input)}`
}

export function sanitizeConversionMetadata(input: Record<string, unknown>) {
  const output: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(input).slice(0, ATTRIBUTION_LIMITS.METADATA_MAX_KEYS)) {
    if (SENSITIVE_KEYS.has(key)) continue
    if (key.includes('token') || key.includes('secret') || key.includes('password')) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && (value.includes('/api/media/') || value.includes('originals/'))) continue
    if (typeof value === 'string') {
      output[key] = value.replace(/\s+/g, ' ').trim().slice(0, ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value
    } else if (typeof value === 'boolean') {
      output[key] = value
    }
  }
  return output
}

function normalizeKeyPart(value: unknown) {
  const text = String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  return text || 'unknown'
}
