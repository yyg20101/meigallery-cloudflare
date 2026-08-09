export type AdminAppAuditRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type AdminAppAuditResult = 'succeeded' | 'denied' | 'failed'
export type AdminAppAuditPurpose =
  | 'operational_investigation'
  | 'security_review'
  | 'financial_reconciliation'
  | 'compliance_audit'

export interface AdminAppAuditActor {
  id: number
  role: string
  label: string
}

export interface AdminAppAuditContext {
  requestId: string | null
  traceId: string | null
  reasonCode: string | null
  businessReference: string | null
  targetVersion: string | null
  approvalRequestId: string | null
  approvalStepId: string | null
  policyVersion: string | null
  capability: string | null
  scopeSummary: string | null
  errorCode: string | null
}

export interface AdminAppAuditRegistryEntry {
  actionKey: string
  schemaVersion: number
  displayName: string
  ownerReference: string
  sensitivity: 'internal' | 'restricted' | 'highly_restricted'
  status: 'active' | 'retired'
}

export interface AdminAppAuditEventSummary {
  eventId: string
  sequence: number
  occurredAt: string
  actor: AdminAppAuditActor
  action: string
  actionDisplayName: string
  domain: string
  riskLevel: AdminAppAuditRiskLevel
  result: AdminAppAuditResult
  target: { type: string; id: string | null }
  context: AdminAppAuditContext
  registry: AdminAppAuditRegistryEntry | null
  payloadState: {
    before: 'empty' | 'valid' | 'invalid'
    after: 'empty' | 'valid' | 'invalid'
  }
}

export interface AdminAppAuditRedactedPayload {
  state: 'empty' | 'valid' | 'invalid'
  digest: string | null
  value: unknown
  redactedFieldCount: number
}

export interface AdminAppAuditEventDetail extends AdminAppAuditEventSummary {
  before: AdminAppAuditRedactedPayload
  after: AdminAppAuditRedactedPayload
  relatedEvents: AdminAppAuditEventSummary[]
  explanation: {
    who: string
    when: string
    what: string
    target: string
    why: string
    result: string
    approval: string
  }
}

export interface AdminAppAuditEventList {
  events: AdminAppAuditEventSummary[]
  nextCursor: string | null
  appliedRange: { from: string; to: string; maxDays: number }
  summary: { total: number; critical: number; high: number; unregistered: number }
  filterOptions: {
    actions: Array<{ value: string; label: string }>
    domains: string[]
  }
  visibility: 'all' | 'self'
}

export interface AdminAppAuditIntegrityFinding {
  findingId: string
  type:
    | 'sequence_gap'
    | 'missing_index'
    | 'malformed_payload'
    | 'sensitive_key'
    | 'unregistered_action'
    | 'business_without_audit'
    | 'manifest_changed'
  severity: 'info' | 'warning' | 'critical'
  sequence: number | null
  eventId: string | null
  evidenceDigest: string
  summaryCode: string
}

export interface AdminAppAuditIntegrityCheck {
  checkId: string
  startSequence: number
  endSequence: number
  eventCount: number
  manifestVersion: string
  manifestDigest: string
  status: 'passed' | 'findings'
  counts: {
    sequenceGap: number
    missingIndex: number
    malformedPayload: number
    sensitiveKey: number
    unregisteredAction: number
    businessWithoutAudit: number
  }
  previousManifestCheckId: string | null
  createdBy: AdminAppAuditActor
  createdAt: string
  findings: AdminAppAuditIntegrityFinding[]
}

export interface AdminAppAuditIntegrityOverview {
  sourceEventCount: number
  indexedEventCount: number
  minimumSequence: number | null
  maximumSequence: number | null
  missingIndexCount: number
  activeRegistryCount: number
  distinctActionCount: number
  unregisteredActionCount: number
  latestCheck: AdminAppAuditIntegrityCheck | null
  productionReady: boolean
  blockers: string[]
}

export function adminAuditRiskLabel(value: AdminAppAuditRiskLevel) {
  return { low: '低', medium: '中', high: '高', critical: '关键' }[value]
}

export function adminAuditRiskClass(value: AdminAppAuditRiskLevel) {
  if (value === 'critical') return 'bg-red-100 text-red-800 ring-red-200'
  if (value === 'high') return 'bg-amber-100 text-amber-900 ring-amber-200'
  if (value === 'medium') return 'bg-blue-100 text-blue-800 ring-blue-200'
  return 'bg-gray-100 text-gray-700 ring-gray-200'
}

export function adminAuditResultLabel(value: AdminAppAuditResult) {
  return { succeeded: '成功', denied: '拒绝', failed: '失败' }[value]
}

export function adminAuditResultClass(value: AdminAppAuditResult) {
  if (value === 'succeeded') return 'bg-emerald-100 text-emerald-800 ring-emerald-200'
  if (value === 'denied') return 'bg-amber-100 text-amber-900 ring-amber-200'
  return 'bg-red-100 text-red-800 ring-red-200'
}

export function adminAuditPurposeLabel(value: AdminAppAuditPurpose) {
  return {
    operational_investigation: '运营调查',
    security_review: '安全复核',
    financial_reconciliation: '财务对账',
    compliance_audit: '合规审计',
  }[value]
}

export function formatAdminAuditTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date)
}
