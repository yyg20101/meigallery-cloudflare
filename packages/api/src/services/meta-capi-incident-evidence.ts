export type MetaCapiIncidentEvidence = Record<string, number | string>

const COUNT_KEY = /(?:Count|_count)$/
const RATE_KEY = /(?:Rate|Ratio|_rate|_ratio)$/
const PERCENTAGE_KEY = /(?:Percentage|_percentage)$/
const CATEGORY_KEY = /(?:Category|_category)$/
const TIME_KEY = /^(?:windowStart|windowEnd|observedAt|window_start|window_end|observed_at)$/
const STABLE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/
const UTC_ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SENSITIVE_KEY = /(?:token|secret|email|useragent|clientip|ipaddress|authorization|credential|cookie|session|fbp|fbc|external(?:event)?id|hash|fingerprint)/
const SENSITIVE_VALUE_PATTERNS = [
  /(?:bearer|token|secret)\s*[=: ]/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*\b/i,
  /\b(?:mozilla|agent|browser|client|curl|okhttp)\/\S+/i,
  /^(?:Browser|Client)$/,
  /\bfb\.1\.\d+\.\S+/i,
  /\bmeta:(?:Contact|CompleteRegistration):\S+/,
  /\b[0-9a-f]{32}\b/i,
  /\b[0-9a-f]{40}\b/i,
  /\b[0-9a-f]{64}\b/i,
]

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
      if (typeof item !== 'string' || !STABLE_CATEGORY.test(item) || containsSensitiveValue(item)) {
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

function containsSensitiveValue(value: string) {
  return SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value))
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
