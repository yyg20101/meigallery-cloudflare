export type MembershipCatalogState = 'development' | 'published' | 'retired'
export type MembershipEntitlementValueType = 'boolean' | 'integer' | 'enum'
export type MembershipEntitlementAvailability = 'available' | 'planned'
export type MembershipEntitlementValue = boolean | number | string
export type MembershipCatalogIssueSeverity = 'error' | 'warning' | 'info'
export type MembershipCatalogPublishStatus =
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'cancelled'

export interface MembershipCatalogValidationIssue {
  code: string
  severity: MembershipCatalogIssueSeverity
  scope: string
  message: string
}

export interface MembershipCatalogValidation {
  issues: MembershipCatalogValidationIssue[]
  errorCount: number
  warningCount: number
  infoCount: number
  canSubmitPublish: boolean
  canMarkProductionReady: boolean
}

export interface MembershipCatalogTier {
  tierId: string
  code: string
  displayName: string
  tagline: string
  rank: number
  accentToken: string
  acquisitionLabel: string
  serviceDisclosure: string
  sortOrder: number
}

export interface MembershipTierEntitlementValue {
  tierId: string
  value: MembershipEntitlementValue
  availability: MembershipEntitlementAvailability
}

export interface MembershipEntitlementDefinition {
  key: string
  schemaVersion: number
  valueType: MembershipEntitlementValueType
  defaultValue: MembershipEntitlementValue
  mergeStrategy: 'highest_rank'
  periodRule: string | null
  clientCapability: string
  displayName: string
  description: string
  unitLabel: string | null
  values: MembershipTierEntitlementValue[]
}

export interface MembershipCatalogSummary {
  catalogVersionId: string
  versionCode: string
  state: MembershipCatalogState
  productionReady: boolean
  effectiveAt: string
  timezone: string
  minimumClientVersion: string
  baseCatalogVersionId: string | null
  lockVersion: number
  changeSummary: string
  productionDecisionStatus: 'unresolved' | 'approved'
  tierCount: number
  entitlementCount: number
  grantCount: number
  applicationCount: number
  dependentCatalogCount: number
  activeRuntimeReference: boolean
  createdBy: number | null
  updatedBy: number | null
  publishedBy: number | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  latestPublishRequest: null | {
    requestId: string
    status: MembershipCatalogPublishStatus
    createdAt: string
  }
}

export interface MembershipCatalogDetail extends MembershipCatalogSummary {
  contentHash: string
  tiers: MembershipCatalogTier[]
  definitions: MembershipEntitlementDefinition[]
  validation: MembershipCatalogValidation
}

export interface MembershipCatalogComparison {
  catalogVersionId: string
  baseCatalogVersionId: string
  tierChanges: Array<{
    tierId: string
    kind: 'added' | 'removed' | 'changed'
    fields: string[]
  }>
  entitlementChanges: Array<{
    key: string
    kind: 'added' | 'removed' | 'changed'
    fields: string[]
    tierValueChangeCount: number
  }>
  summary: {
    addedTiers: number
    removedTiers: number
    changedTiers: number
    addedEntitlements: number
    removedEntitlements: number
    changedEntitlements: number
  }
}

export interface MembershipCatalogPublishRequest {
  requestId: string
  catalog: MembershipCatalogSummary
  catalogLockVersion: number
  contentHash: string
  requestedProductionReady: boolean
  validation: MembershipCatalogValidation
  submitNote: string
  status: MembershipCatalogPublishStatus
  version: number
  requestedBy: { id: number; label: string }
  reviewedBy: { id: number; label: string } | null
  reviewNote: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  canReview: boolean
}

export interface MembershipEntitlementImpact {
  catalogVersionId: string
  entitlement: MembershipEntitlementDefinition
  dependencies: string[]
  knownClientCapability: boolean
  affectedTierCount: number
  availableTierCount: number
  grants: { total: number; active: number }
  activeRuntimeReference: boolean
  baseDifference: null | { fields: string[]; tierValueChangeCount: number }
}

export const MEMBERSHIP_CATALOG_STATE_LABELS: Record<MembershipCatalogState, string> = {
  development: '草稿',
  published: '已发布',
  retired: '已退役',
}

export const MEMBERSHIP_PUBLISH_STATUS_LABELS: Record<MembershipCatalogPublishStatus, string> = {
  pending_review: '待独立复核',
  approved: '已批准',
  rejected: '已拒绝',
  stale: '内容已变化',
  cancelled: '已取消',
}

export const MEMBERSHIP_VALUE_TYPE_LABELS: Record<MembershipEntitlementValueType, string> = {
  boolean: '布尔权限',
  integer: '整数额度',
  enum: '枚举档位',
}

export function membershipCatalogStateClass(state: MembershipCatalogState) {
  if (state === 'published') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (state === 'retired') return 'bg-gray-100 text-gray-600 ring-gray-200'
  return 'bg-amber-50 text-amber-700 ring-amber-200'
}

export function membershipPublishStatusClass(status: MembershipCatalogPublishStatus) {
  if (status === 'approved') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (status === 'rejected' || status === 'stale') return 'bg-rose-50 text-rose-700 ring-rose-200'
  if (status === 'cancelled') return 'bg-gray-100 text-gray-600 ring-gray-200'
  return 'bg-blue-50 text-blue-700 ring-blue-200'
}

export function membershipIssueClass(severity: MembershipCatalogIssueSeverity) {
  if (severity === 'error') return 'border-rose-200 bg-rose-50 text-rose-800'
  if (severity === 'warning') return 'border-amber-200 bg-amber-50 text-amber-800'
  return 'border-blue-200 bg-blue-50 text-blue-800'
}

export function formatMembershipCatalogDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}
