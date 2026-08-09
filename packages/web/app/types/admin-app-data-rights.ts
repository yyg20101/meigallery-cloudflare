export type AdminDataRightsRequestType = 'export' | 'deletion'

export type AdminDataRightsRequestStatus =
  | 'requested'
  | 'verification_required'
  | 'collecting'
  | 'ready'
  | 'expired'
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type AdminDataRightsAction = 'begin_processing' | 'fail' | 'retry' | 'cancel_verified'

export interface AdminDataRightsRequestSummary {
  requestId: string
  type: AdminDataRightsRequestType
  status: AdminDataRightsRequestStatus
  statusMessageCode: string
  version: number
  account: {
    accountId: string
    emailMasked: string
    nickname: string | null
    status: string
  }
  policy: {
    policyId: string
    version: string
    cancellationEnabled: boolean
  }
  assignee: null | { id: number; label: string }
  requestedAt: string
  updatedAt: string
  deadlineAt: string | null
  scheduledFor: string | null
  processingStartedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  failureCode: string | null
  overdue: boolean
  availableActions: AdminDataRightsAction[]
}

export interface AdminDataRightsPolicyOverview {
  policyId: string
  version: string
  state: string
  productionReady: boolean
  capabilities: {
    requests: boolean
    exportRequests: boolean
    deletionRequests: boolean
    exportProcessing: boolean
    deletionProcessing: boolean
    cancellation: boolean
  }
  governance: {
    retention: 'unresolved' | 'approved'
    ownerAndSla: 'unresolved' | 'approved'
    region: 'unresolved' | 'approved'
    retentionReference: string | null
    ownerReference: string | null
    regionReference: string | null
  }
  timing: {
    requestSlaHours: number | null
    deletionCoolingOffHours: number | null
    statusAccessTtlHours: number
    stepUpTtlSeconds: number
  }
}

export interface AdminDataRightsOverview {
  runtime: {
    requested: boolean
    adminRequested: boolean
    configuredPolicyId: string | null
    requireProductionReady: boolean
  }
  policy: AdminDataRightsPolicyOverview | null
  metrics: {
    total: number
    open: number
    exportOpen: number
    deletionOpen: number
    unassigned: number
    overdue: number
    failed: number
  }
  recent: AdminDataRightsRequestSummary[]
}

export interface AdminDataRightsRequestList {
  items: AdminDataRightsRequestSummary[]
  filters: {
    type: AdminDataRightsRequestType | null
    status: AdminDataRightsRequestStatus | null
    assignment: 'all' | 'mine' | 'unassigned'
  }
  limit: number
}

export interface AdminDataRightsTimelineEvent {
  eventId: string
  sequence: number
  requestVersion: number
  status: AdminDataRightsRequestStatus
  eventType: string
  visibility: 'user' | 'internal'
  actor: {
    type: 'account' | 'admin' | 'system'
    id: number | null
    label: string
    role?: string | null
  }
  reasonCode: string
  userMessage: string | null
  internalNote: string | null
  safeSummary: Record<string, unknown>
  createdAt: string
}

export interface AdminDataRightsRequestDetail extends AdminDataRightsRequestSummary {
  timeline: AdminDataRightsTimelineEvent[]
  permissions: {
    canClaim: boolean
    canAct: boolean
  }
}

export function adminDataRightsTypeLabel(value: AdminDataRightsRequestType) {
  return value === 'export' ? '数据导出' : '账号注销'
}

export function adminDataRightsStatusLabel(value: AdminDataRightsRequestStatus) {
  return ({
    requested: '待处理',
    verification_required: '待重新验证',
    collecting: '正在收集',
    ready: '可下载',
    expired: '已过期',
    scheduled: '等待执行',
    processing: '执行中',
    completed: '已完成',
    cancelled: '已取消',
    failed: '处理失败',
  })[value]
}

export function adminDataRightsStatusClass(value: AdminDataRightsRequestStatus) {
  if (value === 'failed') return 'bg-red-100 text-red-800 ring-red-200'
  if (value === 'cancelled' || value === 'expired') return 'bg-slate-100 text-slate-700 ring-slate-200'
  if (value === 'completed' || value === 'ready') return 'bg-emerald-100 text-emerald-800 ring-emerald-200'
  if (value === 'processing' || value === 'collecting') return 'bg-blue-100 text-blue-800 ring-blue-200'
  return 'bg-amber-100 text-amber-800 ring-amber-200'
}

export function adminDataRightsActionLabel(value: AdminDataRightsAction) {
  return ({
    begin_processing: '开始受控处理',
    fail: '记录处理失败',
    retry: '重新排入处理',
    cancel_verified: '核验后代用户取消',
  })[value]
}

export function adminDataRightsTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}
