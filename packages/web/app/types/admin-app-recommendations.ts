export type RecommendationRuleState =
  | 'draft'
  | 'validating'
  | 'approved'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'retired'
  | 'rolled_back'

export type RecommendationPlacementState =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'expired'
  | 'retired'

export type RecommendationWeights = {
  quality: number
  heat: number
  freshness: number
  region: number
  preferredTaxonomy: number
}

export type RecommendationReasonMap = {
  editorial: string
  region: string
  popular: string
  fresh: string
  preferred: string
  default: string
}

export type RecommendationDryRun = {
  candidateCount: number
  emptyResultRisk: boolean
  mode: 'non_personalized' | 'personalized'
  ruleVersionId: string
  generatedAt: string
  scenario: {
    type: 'synthetic'
    regionCode: string | null
    personalizedSignals: number
  }
  reasonCoverage: number
  repeatedProfileCount: number
  representedRegionCount: number
  reasons: Array<{ code: string; count: number }>
  topItems: Array<{
    profileId: string
    displayName: string
    score: number
    reasonCode: string
    regionLabel: string | null
  }>
  safetyEligibilityFixed: boolean
  producesExposure: false
  [key: string]: unknown
}

export type RecommendationRule = {
  ruleVersionId: string
  ruleSetId: string
  versionNumber: number
  state: RecommendationRuleState
  entryPoint: 'discovery_home'
  mode: 'non_personalized' | 'personalized'
  name: string
  description: string | null
  taxonomyCatalogId: string | null
  heatVersionId: string | null
  weights: RecommendationWeights
  reasonMap: RecommendationReasonMap
  targetRegionCodes: string[]
  targetChannels: string[]
  diversity: {
    maxConsecutiveSameRegion: number
    maxConsecutiveSameTerm: number
    repeatExposureCap: number
  }
  rolloutPercent: number
  minimumClientVersion: string
  effectiveAt: string | null
  expiresAt: string | null
  rollbackRuleVersionId: string | null
  productionReady: boolean
  lastDryRun: RecommendationDryRun | null
  lastDryRunAt: string | null
  version: number
  createdBy: number
  updatedBy: number
  reviewedBy: number | null
  activatedBy: number | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  activatedAt: string | null
  pausedAt: string | null
}

export type RecommendationRuleEvent = {
  eventId: string
  fromState: string | null
  toState: string
  action: string
  reason: string
  actorId: number
  requestId: string | null
  createdAt: string
}

export type RecommendationRuleDetail = RecommendationRule & {
  events: RecommendationRuleEvent[]
}

export type RecommendationPlacement = {
  placementId: string
  state: RecommendationPlacementState
  entryPoint: 'discovery_home'
  profileId: string
  positionKey: 'discovery_feed'
  priority: number
  regionCode: string | null
  channel: 'app'
  disclosure: { code: 'PLATFORM_SELECTED'; label: '平台精选' }
  reason: string
  startsAt: string
  endsAt: string
  version: number
  createdBy: number
  updatedBy: number
  reviewedBy: number | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  activatedAt: string | null
  pausedAt: string | null
  eligibility?: { exists: boolean; eligible: boolean; checkedAt: string }
}

export type RecommendationPolicy = {
  policyId: string
  state: 'development' | 'published'
  productionReady: boolean
  feedEnabled: boolean
  adminOperationsEnabled: boolean
  preferenceEnabled: boolean
  personalizationEnabled: boolean
  personalizationDecisionStatus: 'unresolved' | 'approved'
  evidenceRecordingEnabled: boolean
  evidenceRetentionDecisionStatus: 'unresolved' | 'approved'
  evidenceRetentionDays: number | null
  purgeEnabled: boolean
  defaultPageSize: number
  maxPageSize: number
  maxCandidatePool: number
  maxEditorialItems: number
  minimumClientVersion: string
  effectiveAt: string
}

export type RecommendationOverview = {
  policy: RecommendationPolicy
  runtime: {
    effectiveAt: string
    generatedAt: string
    productionReady: boolean
    personalizationReady: boolean
    evidenceReady: boolean
  }
  ruleCounts: Record<string, number>
  placementCounts: Record<string, number>
  heatVersions: Array<{
    heatVersionId: string
    versionCode: string
    state: string
    productionReady: boolean
    observationWindowDays: number
    minimumSampleSize: number
  }>
}

export const RECOMMENDATION_STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  validating: '待复核',
  pending_review: '待复核',
  approved: '已批准',
  scheduled: '待生效',
  active: '生效中',
  paused: '已暂停',
  retired: '已退役',
  rolled_back: '已回滚',
  expired: '已过期',
}

export const RECOMMENDATION_ACTION_LABELS: Record<string, string> = {
  create: '创建草稿',
  copy: '复制新版本',
  submit: '提交复核',
  approve: '批准',
  reject: '退回',
  activate: '启用',
  schedule: '计划生效',
  pause: '暂停',
  superseded: '被新版本替换',
  rollback: '执行回滚',
  rollback_restore: '恢复为生效版本',
}

export function recommendationStateClass(state: string) {
  if (state === 'active') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (['validating', 'pending_review', 'scheduled'].includes(state)) return 'bg-amber-50 text-amber-800 ring-amber-200'
  if (state === 'approved') return 'bg-blue-50 text-blue-700 ring-blue-200'
  if (['paused', 'rolled_back', 'expired'].includes(state)) return 'bg-red-50 text-red-700 ring-red-200'
  return 'bg-gray-100 text-gray-700 ring-gray-200'
}

export function formatRecommendationDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : value
}

export function recommendationApiError(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: unknown; message?: unknown }
  if (candidate.data && typeof candidate.data === 'object') {
    const message = (candidate.data as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  if (typeof candidate.data === 'string') {
    try {
      const parsed = JSON.parse(candidate.data) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message
    }
    catch { /* 使用 fallback */ }
  }
  if (typeof candidate.message === 'string' && candidate.message.length < 180) return candidate.message
  return fallback
}

export function newRecommendationIdempotencyKey(prefix: 'rule' | 'placement' | 'copy') {
  return `${prefix}-${crypto.randomUUID()}`
}
