export type AdminOperationOverallState = 'critical' | 'attention' | 'partial' | 'healthy'
export type AdminOperationMetricQuality = 'known' | 'unknown' | 'delayed' | 'partial' | 'invalid' | 'unconfigured'
export type AdminOperationTopicState = 'known' | 'unknown' | 'delayed' | 'invalid' | 'paused'
export type AdminOperationalIncidentSeverity = 'p0' | 'p1' | 'p2' | 'p3'
export type AdminOperationalIncidentStatus =
  | 'open'
  | 'acknowledged'
  | 'investigating'
  | 'mitigated'
  | 'resolved'
  | 'false_positive'

export type AdminOperationalControlKey =
  | 'person_publication'
  | 'recommendation_delivery'
  | 'operator_messaging'
  | 'membership_grants'
  | 'wallet_adjustments'

export interface AdminOperationalControl {
  key: AdminOperationalControlKey
  displayName: string
  state: 'available' | 'paused'
  version: number
  incidentId: string | null
  reasonCode: string | null
  reasonSummary: string | null
  changedBy: number | null
  changedAt: string
  linkedToThisIncident?: boolean
}

export interface AdminOperationalIncidentSummary {
  incidentId: string
  incidentKey: string
  type: string
  domain: string
  severity: AdminOperationalIncidentSeverity
  title: string
  summary: string
  impact: {
    count: number | null
    scope: Record<string, unknown>
  }
  status: AdminOperationalIncidentStatus
  owner: null | { id: number; label: string; role: string | null }
  runbook: null | {
    id: string
    key: string | null
    version: number | null
    title: string | null
    summary: string | null
    documentReference: string | null
  }
  version: number
  signalCount: number
  firstSeenAt: string
  lastSeenAt: string
  updatedAt: string
}

export interface AdminOperationsOverviewMetric {
  key: string
  name: string
  description: string
  unit: 'count' | 'ratio' | 'milliseconds' | 'status'
  value: number | string | null
  quality: { state: AdminOperationMetricQuality; label: string }
  source: {
    type: string
    reference: string
    watermark: string | null
    measuredAt: string | null
    freshnessSloSeconds: number
  }
  governance: {
    ownerReference: string
    sensitivity: string
    retentionDecisionStatus: string
    retentionPolicyReference: string | null
    productionReady: boolean
  }
}

export interface AdminOperationsOverview {
  scope: { key: string; label: string }
  generatedAt: string
  overall: {
    state: AdminOperationOverallState
    label: string
    unknownMetricCount: number
  }
  snapshot: null | {
    runId: string
    version: string
    status: string
    metricCount: number
    knownCount: number
    completedAt: string
    ageSeconds: number
  }
  controls: AdminOperationalControl[]
  incidents: {
    total: number
    open: number
    p0: number
    p1: number
    unassigned: number
    recent: AdminOperationalIncidentSummary[]
  }
  topics: Array<{
    key: string
    label: string
    state: AdminOperationTopicState
    metrics: AdminOperationsOverviewMetric[]
  }>
  dataBoundary: {
    missingIsZero: false
    individualRankingEnabled: false
    futureCapabilityMetricsIncluded: false
    excludedFutureCapabilities: string[]
  }
}

export interface AdminOperationalIncidentList {
  incidents: AdminOperationalIncidentSummary[]
  nextCursor: string | null
  summary: { total: number; open: number; p0: number; p1: number; unassigned: number }
  appliedFilters: {
    status: string | null
    severity: string | null
    domain: string | null
    type: string | null
    owner: string
  }
}

export interface AdminOperationalIncidentEvent {
  eventId: string
  sequence: number
  incidentVersion: number
  type: string
  actor: { type: 'system' | 'admin'; id: number | null; label: string }
  transition: null | { from: string; to: string }
  reasonCode: string
  responseNote: string | null
  safeSummary: Record<string, unknown>
  evidenceReference: string | null
  createdAt: string
}

export interface AdminOperationalIncidentDetail extends AdminOperationalIncidentSummary {
  source: { type: string; reference: string; lastDetectionRunId: string | null }
  timestamps: {
    firstSeenAt: string
    lastSeenAt: string
    acknowledgedAt: string | null
    mitigatedAt: string | null
    resolvedAt: string | null
    createdAt: string
    updatedAt: string
  }
  resolution: null | {
    code: string
    summary: string
    evidenceReference: string
    postmortemReference: string | null
  }
  events: AdminOperationalIncidentEvent[]
  controls: AdminOperationalControl[]
  permissions: {
    canClaim: boolean
    canRespond: boolean
    canOperateSafetyControls: boolean
  }
}

export interface AdminOperationalRunbook {
  runbookId: string
  key: string
  version: number
  title: string
  summary: string
  documentReference: string
  domains: string[]
  controlKeys: string[]
  minimumSeverity: AdminOperationalIncidentSeverity
}

export interface AdminOperationalControlPreview {
  control: AdminOperationalControl
  incident: AdminOperationalIncidentSummary
  impact: {
    blockedOperations: string[]
    unaffectedOperations: string[]
  }
  decision: {
    canPause: boolean
    canRestore: boolean
    blockers: string[]
  }
}

export function adminIncidentSeverityLabel(value: AdminOperationalIncidentSeverity) {
  return ({ p0: 'P0 紧急', p1: 'P1 高优', p2: 'P2 中优', p3: 'P3 观察' })[value]
}

export function adminIncidentSeverityClass(value: AdminOperationalIncidentSeverity) {
  return ({
    p0: 'bg-red-100 text-red-800 ring-red-200',
    p1: 'bg-orange-100 text-orange-800 ring-orange-200',
    p2: 'bg-amber-100 text-amber-800 ring-amber-200',
    p3: 'bg-slate-100 text-slate-700 ring-slate-200',
  })[value]
}

export function adminIncidentStatusLabel(value: AdminOperationalIncidentStatus) {
  return ({
    open: '待响应',
    acknowledged: '已确认',
    investigating: '调查中',
    mitigated: '已缓解',
    resolved: '已解决',
    false_positive: '误报',
  })[value]
}

export function adminIncidentStatusClass(value: AdminOperationalIncidentStatus) {
  return ({
    open: 'bg-red-50 text-red-700 ring-red-200',
    acknowledged: 'bg-blue-50 text-blue-700 ring-blue-200',
    investigating: 'bg-violet-50 text-violet-700 ring-violet-200',
    mitigated: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    resolved: 'bg-gray-100 text-gray-700 ring-gray-200',
    false_positive: 'bg-slate-100 text-slate-600 ring-slate-200',
  })[value]
}

export function adminIncidentDomainLabel(value: string) {
  return ({
    supply: '人物供给',
    discovery: '发现推荐',
    messaging: '平台话题',
    membership: '会员权限',
    wallet: '金币钱包',
    notification: '站内通知',
    safety: '安全治理',
    audit: '审计完整性',
    platform: '平台运行',
  } as Record<string, string>)[value] ?? value
}

export function adminIncidentTypeLabel(value: string) {
  return ({
    unauthorized_publication: '未授权人物公开',
    operator_identity_anomaly: '运营身份链异常',
    membership_expiry_not_revoked: '会员到期未失效',
    duplicate_membership_grant: '重复会员发放',
    wallet_balance_mismatch: '钱包余额不一致',
    unreviewed_wallet_adjustment: '金币调整超时未复核',
    audit_integrity_gap: '审计完整性缺口',
    internal_note_exposure: '内部备注暴露风险',
    notification_backlog: '通知投递积压',
    data_rights_overdue: '数据权利请求逾期',
    platform_health_anomaly: '平台健康异常',
  } as Record<string, string>)[value] ?? value
}

export function adminMetricQualityClass(value: AdminOperationMetricQuality) {
  return ({
    known: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    unknown: 'bg-slate-100 text-slate-700 ring-slate-200',
    delayed: 'bg-amber-50 text-amber-800 ring-amber-200',
    partial: 'bg-amber-50 text-amber-800 ring-amber-200',
    invalid: 'bg-red-50 text-red-700 ring-red-200',
    unconfigured: 'bg-violet-50 text-violet-700 ring-violet-200',
  })[value]
}

export function adminOperationTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}
