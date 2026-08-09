export type AdminAppAuditRegistryOperation = 'publish' | 'retire'
export type AdminAppAuditRegistrySensitivity = 'internal' | 'restricted' | 'highly_restricted'
export type AdminAppAuditRegistryRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type AdminAppAuditRegistryRequestStatus = 'pending_review' | 'approved' | 'rejected' | 'stale'
export type AdminAppAuditRegistryGovernanceState =
  | 'active'
  | 'unregistered'
  | 'retired'
  | 'pending_review'
  | 'inconsistent'

export interface AdminAppAuditRegistryActor {
  id: number
  role: string
  label: string
}

export interface AdminAppAuditRegistryDefinition {
  registryId: string
  actionKey: string
  schemaVersion: number
  domain: string
  displayName: string
  ownerReference: string
  sensitivity: AdminAppAuditRegistrySensitivity
  riskLevel: AdminAppAuditRegistryRiskLevel
  visibleRoles: Array<'admin' | 'owner'>
  retentionPolicyReference: string | null
  qualityRuleReference: string | null
  status: 'active' | 'retired'
  createdBy: AdminAppAuditRegistryActor
  createdAt: string
  productionReady: boolean
}

export interface AdminAppAuditRegistryObservation {
  eventCount: number
  missingIndexCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  domains: string[]
  riskLevels: AdminAppAuditRegistryRiskLevel[]
  observationDigest: string
}

export interface AdminAppAuditRegistryActionSummary {
  actionKey: string
  governanceState: AdminAppAuditRegistryGovernanceState
  latestDefinition: AdminAppAuditRegistryDefinition | null
  observation: AdminAppAuditRegistryObservation
  pendingRequest: null | {
    requestId: string
    operation: AdminAppAuditRegistryOperation
    requestedBy: AdminAppAuditRegistryActor
    createdAt: string
  }
}

export interface AdminAppAuditRegistryOverview {
  distinctActionCount: number
  activeActionCount: number
  unregisteredActionCount: number
  retiredActionCount: number
  inconsistentActionCount: number
  pendingRequestCount: number
  unregisteredEventCount: number
  definitionsNotProductionReady: number
  productionReady: boolean
  blockers: string[]
}

export interface AdminAppAuditRegistryProposal {
  actionKey: string
  operation: AdminAppAuditRegistryOperation
  schemaVersion: number
  domain: string
  displayName: string
  ownerReference: string
  sensitivity: AdminAppAuditRegistrySensitivity
  riskLevel: AdminAppAuditRegistryRiskLevel
  visibleRoles: Array<'admin' | 'owner'>
  retentionPolicyReference: string | null
  qualityRuleReference: string | null
}

export interface AdminAppAuditRegistryPreview {
  proposal: AdminAppAuditRegistryProposal
  currentDefinition: AdminAppAuditRegistryDefinition | null
  latestDefinition: AdminAppAuditRegistryDefinition | null
  observation: AdminAppAuditRegistryObservation
  affectedHistoricalEventCount: number
  blockers: string[]
  warnings: string[]
  canSubmit: boolean
}

export interface AdminAppAuditRegistryRequestEvent {
  eventId: string
  sequence: number
  type: 'submitted' | 'approved' | 'rejected' | 'stale'
  actor: AdminAppAuditRegistryActor
  reasonCode: string
  summary: Record<string, unknown>
  createdAt: string
}

export interface AdminAppAuditRegistryRequest {
  requestId: string
  operation: AdminAppAuditRegistryOperation
  proposal: AdminAppAuditRegistryProposal
  baseline: {
    expectedCurrentSchemaVersion: number | null
    observationDigest: string
    observedEventCount: number
    observedFirstAt: string | null
    observedLastAt: string | null
  }
  requestReason: string
  status: AdminAppAuditRegistryRequestStatus
  version: number
  requestedBy: AdminAppAuditRegistryActor
  reviewedBy: AdminAppAuditRegistryActor | null
  reviewReasonCode: string | null
  reviewNote: string | null
  resultRegistryId: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  appliedAt: string | null
  canReview: boolean
  currentState: {
    latestDefinition: AdminAppAuditRegistryDefinition | null
    observation: AdminAppAuditRegistryObservation
    governanceReady: boolean
    baselineChanged: boolean
  }
  events: AdminAppAuditRegistryRequestEvent[]
}

export function auditRegistryStateLabel(value: AdminAppAuditRegistryGovernanceState) {
  return {
    active: '当前已登记',
    unregistered: '未登记',
    retired: '当前已退休',
    pending_review: '待独立复核',
    inconsistent: '观察口径冲突',
  }[value]
}

export function auditRegistryStateClass(value: AdminAppAuditRegistryGovernanceState) {
  if (value === 'active') return 'bg-emerald-100 text-emerald-800 ring-emerald-200'
  if (value === 'pending_review') return 'bg-blue-100 text-blue-800 ring-blue-200'
  if (value === 'inconsistent') return 'bg-red-100 text-red-800 ring-red-200'
  if (value === 'retired') return 'bg-gray-100 text-gray-700 ring-gray-200'
  return 'bg-violet-100 text-violet-800 ring-violet-200'
}

export function auditRegistryRequestStatusLabel(value: AdminAppAuditRegistryRequestStatus) {
  return {
    pending_review: '待独立复核',
    approved: '已批准并应用',
    rejected: '已驳回',
    stale: '基线已变化',
  }[value]
}

export function auditRegistryRequestStatusClass(value: AdminAppAuditRegistryRequestStatus) {
  if (value === 'approved') return 'bg-emerald-100 text-emerald-800 ring-emerald-200'
  if (value === 'pending_review') return 'bg-blue-100 text-blue-800 ring-blue-200'
  if (value === 'stale') return 'bg-amber-100 text-amber-900 ring-amber-200'
  return 'bg-red-100 text-red-800 ring-red-200'
}

export function auditRegistryOperationLabel(value: AdminAppAuditRegistryOperation) {
  return value === 'publish' ? '发布新口径版本' : '退休当前口径'
}

export function auditRegistryRiskLabel(value: AdminAppAuditRegistryRiskLevel) {
  return ({ low: '低', medium: '中', high: '高', critical: '关键' })[value]
}

export function auditRegistrySensitivityLabel(value: AdminAppAuditRegistrySensitivity) {
  return ({ internal: '内部', restricted: '受限', highly_restricted: '高度受限' })[value]
}

export function formatAuditRegistryTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}
