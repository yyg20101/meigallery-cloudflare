export type MetaCapiIncidentEvidence = Record<string, number | string>

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

export const META_CAPI_INCIDENT_DEFINITIONS = {
  permanent_failure_rate: {
    severity: 'critical',
    summary: 'Meta CAPI 永久失败率达到熔断阈值',
    category: 'client_error',
    evidence: { totalCount: 'count', failedCount: 'count', failedRate: 'rate' },
  },
  retry_exhausted: {
    severity: 'critical',
    summary: 'Meta CAPI 重试耗尽达到熔断阈值',
    category: 'retry_exhausted',
    evidence: { retryExhaustedCount: 'count' },
  },
  stale_pending: {
    severity: 'critical',
    summary: 'Meta CAPI 陈旧待处理投递达到熔断阈值',
    category: 'stale_pending',
    evidence: { stalePendingCount: 'count' },
  },
  duplicate_delivery: {
    severity: 'critical',
    summary: 'Meta CAPI 检测到重复有效投递',
    category: 'duplicate_delivery',
    evidence: { duplicateGroupCount: 'count' },
  },
  duplicate_suppressed_rate: {
    severity: 'warning',
    summary: 'Meta CAPI 重复抑制比例达到告警阈值',
    category: 'duplicate_suppressed',
    evidence: { totalCount: 'count', duplicateCount: 'count', duplicateRate: 'rate' },
  },
  connection_fingerprint_changed: {
    severity: 'critical',
    summary: 'MetaConnection 连接指纹已变化',
    category: 'connection_changed',
    evidence: {},
  },
  meta_permission_denied: {
    severity: 'critical',
    summary: 'Meta CAPI 权限被拒绝',
    category: 'permission_denied',
    evidence: { failedCount: 'count' },
  },
  secure_context_decryption_failed: {
    severity: 'critical',
    summary: 'Meta CAPI 安全上下文解密失败',
    category: 'decryption_failed',
    evidence: {},
  },
  dataset_pixel_mismatch: {
    severity: 'critical',
    summary: 'Meta Dataset 与已验证连接不一致',
    category: 'dataset_mismatch',
    evidence: {},
  },
} as const satisfies Record<string, {
  severity: 'critical' | 'warning'
  summary: string
  category: MetaCapiIncidentCategory
  evidence: Record<string, EvidenceValueKind>
}>

export type MetaIncidentTriggerCode = keyof typeof META_CAPI_INCIDENT_DEFINITIONS

type EvidenceValueKind = 'count' | 'rate' | 'category' | 'time'
type SanitizerMode = 'reject' | 'drop'

const COMMON_EVIDENCE_FIELDS: Record<string, EvidenceValueKind> = {
  errorCategory: 'category',
  windowStart: 'time',
  windowEnd: 'time',
  observedAt: 'time',
}
const UTC_ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isMetaCapiIncidentTriggerCode(value: unknown): value is MetaIncidentTriggerCode {
  return typeof value === 'string' && Object.hasOwn(META_CAPI_INCIDENT_DEFINITIONS, value)
}

export function metaCapiIncidentSummary(value: unknown) {
  return isMetaCapiIncidentTriggerCode(value)
    ? META_CAPI_INCIDENT_DEFINITIONS[value].summary
    : '未知 Meta CAPI incident'
}

export function sanitizeMetaCapiIncidentEvidence(
  triggerCode: unknown,
  value: unknown,
  mode: SanitizerMode = 'reject',
): MetaCapiIncidentEvidence {
  if (!isMetaCapiIncidentTriggerCode(triggerCode) || !isPlainObject(value)) {
    if (mode === 'reject') throw validationError()
    return {}
  }

  const definition = META_CAPI_INCIDENT_DEFINITIONS[triggerCode]
  const allowed: Record<string, EvidenceValueKind> = {
    ...COMMON_EVIDENCE_FIELDS,
    ...definition.evidence,
  }
  const output: MetaCapiIncidentEvidence = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(allowed, key)) {
      if (mode === 'reject') throw validationError()
      continue
    }
    const item = value[key]
    if (!isAllowedValue(allowed[key]!, item, definition.category)) {
      if (mode === 'reject') throw validationError()
      continue
    }
    output[key] = item
  }
  return output
}

function isAllowedValue(
  kind: EvidenceValueKind,
  value: unknown,
  category: MetaCapiIncidentCategory,
): value is number | string {
  if (kind === 'count') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (kind === 'rate') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  if (kind === 'category') return value === category
  return typeof value === 'string' && UTC_ISO_TIME.test(value) && new Date(value).toISOString() === value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validationError() {
  return new Error('Meta CAPI incident evidence 非法')
}
