export type MetaCapiIncidentEvidence = Record<string, number | string>

const COUNT_KEY = /(?:Count|_count)$/
const RATE_KEY = /(?:Rate|Ratio|_rate|_ratio)$/
const PERCENTAGE_KEY = /(?:Percentage|_percentage)$/
const CATEGORY_KEY = /(?:Category|_category)$/
const TIME_KEY = /^(?:windowStart|windowEnd|observedAt|window_start|window_end|observed_at)$/
const UTC_ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SENSITIVE_KEY = /(?:token|secret|email|useragent|clientip|ipaddress|authorization|credential|cookie|session|fbp|fbc|external(?:event)?id|hash|fingerprint)/

export const META_CAPI_INCIDENT_CATEGORIES = [
  'rate_limited',
  'client_error',
  'authorization_failed',
  'permission_denied',
  'server_error',
  'timeout',
  'network_error',
  'invalid_request',
  'retry_exhausted',
  'stale_pending',
  'duplicate_delivery',
  'duplicate_suppressed',
  'decryption_failed',
  'connection_changed',
  'dataset_mismatch',
  'collector_unavailable',
  'collector_stale',
  'unknown_error',
] as const

export type MetaCapiIncidentCategory = typeof META_CAPI_INCIDENT_CATEGORIES[number]

const META_CAPI_INCIDENT_CATEGORY_SET = new Set<string>(META_CAPI_INCIDENT_CATEGORIES)

export function validateMetaCapiIncidentEvidence(value: unknown): MetaCapiIncidentEvidence {
  if (!isPlainObject(value)) throw validationError()

  const entries = Object.entries(value)
  if (entries.length > 32) throw validationError()

  for (const [key, item] of entries) {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    if (!normalizedKey || isSensitiveKey(normalizedKey)) throw validationError()
    if (COUNT_KEY.test(key)) {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) throw validationError()
      continue
    }
    if (RATE_KEY.test(key)) {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) throw validationError()
      continue
    }
    if (PERCENTAGE_KEY.test(key)) {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 100) throw validationError()
      continue
    }
    if (CATEGORY_KEY.test(key)) {
      if (typeof item !== 'string' || !META_CAPI_INCIDENT_CATEGORY_SET.has(item)) {
        throw validationError()
      }
      continue
    }
    if (TIME_KEY.test(key)) {
      if (typeof item !== 'string' || !isUtcIsoTime(item)) throw validationError()
      continue
    }
    throw validationError()
  }

  return { ...value }
}

function isSensitiveKey(normalizedKey: string) {
  return SENSITIVE_KEY.test(normalizedKey)
    || /^ip(?:count|rate|ratio|percentage|category)?$/.test(normalizedKey)
}

function isUtcIsoTime(value: string) {
  return UTC_ISO_TIME.test(value) && new Date(value).toISOString() === value
}

function isPlainObject(value: unknown): value is MetaCapiIncidentEvidence {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validationError() {
  return new Error('Meta CAPI incident evidence 非法')
}
