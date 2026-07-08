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
  'token',
  'session_token',
  'private_url',
  'r2_key',
  'membership_note',
  'admin_path',
  'admin_action_detail',
  'operator_note_text',
])

const SENSITIVE_KEY_PARTS = ['token', 'secret', 'password']
const SENSITIVE_EXACT_OR_PREFIX_KEYS = [
  'email',
  'phone',
  'nickname',
  'username',
  'contact_value',
  'contact_value_',
  'membership_note',
  'membership_note_',
  'admin_path',
  'admin_action_detail',
  'operator_note',
]

const SENSITIVE_VALUE_PATTERNS = ['/api/media/', 'originals/', '/admin/']

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
    const normalizedKey = normalizeMetadataKey(key)
    if (isSensitiveMetadataKey(normalizedKey)) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && isSensitiveMetadataValue(value)) continue
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
  if (SENSITIVE_KEYS.has(normalizedKey)) return true
  if (SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))) return true
  return SENSITIVE_EXACT_OR_PREFIX_KEYS.some(
    (candidate) => normalizedKey === candidate || normalizedKey.startsWith(candidate),
  )
}

function isSensitiveMetadataValue(value: string) {
  const normalizedValue = value.toLowerCase()
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => normalizedValue.includes(pattern))
}
