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

const SENSITIVE_KEY_PARTS = ['token', 'secret', 'password', 'credential', 'cookie', 'jwt', 'signature']
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

const BLOCKED_CREDENTIAL_PARAM_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authtoken',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'jwt',
  'password',
  'passwd',
  'pwd',
  'refreshtoken',
  'secret',
  'securitytoken',
  'session',
  'sessionid',
  'sig',
  'signature',
  'signed',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
])

const REDACTED_ONLY_PATTERN = /^(?:[\s,，;；:/：|、-]*\[redacted_(?:email|phone|url|credential|contact)\])+[\s,，;；:/：|、-]*$/

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
    if (typeof value === 'string') {
      if (isSensitiveMetadataValue(value)) continue
      const sanitizedValue = sanitizeMetadataStringValue(value)
      if (sanitizedValue) output[key] = sanitizedValue
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
  if (isBlockedCredentialParamName(normalizedKey)) return true
  if (SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))) return true
  return SENSITIVE_EXACT_OR_PREFIX_KEYS.some(
    (candidate) => normalizedKey === candidate || normalizedKey.startsWith(candidate),
  )
}

function isSensitiveMetadataValue(value: string) {
  const normalizedValue = value.toLowerCase()
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => normalizedValue.includes(pattern))
}

function sanitizeMetadataStringValue(value: string) {
  const sanitized = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, '[redacted_email]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[redacted_url]')
    .replace(
      /(^|[^a-zA-Z0-9_])(?:微信|wechat|wx)\s*(?:[:：=号]\s*)?(?:wxid_[a-zA-Z0-9._-]{3,}|@?[a-zA-Z0-9._-]*(?:\d|[_-])[a-zA-Z0-9._-]{2,})(?=$|[^a-zA-Z0-9_])/gi,
      '$1[redacted_contact]',
    )
    .replace(
      /(^|[^a-zA-Z0-9_])(?:telegram|tg)\s*(?:(?:[:：=]\s*)?[＠@][a-zA-Z0-9_][a-zA-Z0-9._-]{2,}|[:：=]\s*[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\d|[_-])[a-zA-Z0-9._-]*)(?=$|[^a-zA-Z0-9_])/gi,
      '$1[redacted_contact]',
    )
    .replace(
      /(^|[^a-zA-Z0-9_])(?:line|whatsapp)\s*(?:(?:[:：=]\s*)?[＠@][a-zA-Z0-9_][a-zA-Z0-9._-]{2,}|[:：=]\s*[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\d|[_-])[a-zA-Z0-9._-]*)(?=$|[^a-zA-Z0-9_])/gi,
      '$1[redacted_contact]',
    )
    .replace(
      /(^|[^a-zA-Z0-9_])qq\s*(?:[:：=号]|\s)\s*[1-9]\d{4,11}(?=$|[^a-zA-Z0-9_])/gi,
      '$1[redacted_contact]',
    )
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted_phone]')
    .replace(/(?:^|[?\s&#;])([^=\s&?#;]+)=([^\s&?#;]+)/g, (match, rawName: string) => {
      return isBlockedCredentialParamName(rawName) ? match.replace(/=.*/, '=[redacted_credential]') : match
    })
    .trim()
    .slice(0, ATTRIBUTION_LIMITS.METADATA_VALUE_MAX_LENGTH)

  if (!sanitized || REDACTED_ONLY_PATTERN.test(sanitized)) return null
  return sanitized
}

function isBlockedCredentialParamName(name: string) {
  return BLOCKED_CREDENTIAL_PARAM_NAMES.has(name.toLowerCase().replace(/[-_]/g, ''))
}
