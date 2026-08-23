import type { AppAppealReviewState, AppSafetyAppealStatus, AppServiceAppealSourceType } from '@meigallery/shared'
import { AppSafetyError } from './app-safety'

const APPEAL_ID_PATTERN = /^(?:apl|bap)_[A-Za-z0-9_-]{1,76}$/u
const FINAL_STATUSES = new Set(['upheld', 'changed', 'closed'])
const SOURCE_TYPES = new Set(['all', 'report', 'account_restriction', 'wallet_entry'])
const ASSIGNMENTS = new Set(['all', 'mine', 'unassigned', 'other', 'isolation_blocked'])
const STATUSES = new Set(['open', 'all', 'submitted', 'processing', 'upheld', 'changed', 'closed'])

export type AdminAppealQueueSourceFilter = 'all' | 'report' | AppServiceAppealSourceType
export type AdminAppealQueueAssignmentFilter = 'all' | 'mine' | 'unassigned' | 'other' | 'isolation_blocked'

export interface AdminAppealQueueQuery {
  status: 'open' | 'all' | AppSafetyAppealStatus
  sourceType: AdminAppealQueueSourceFilter
  assignment: AdminAppealQueueAssignmentFilter
  query: string
  page: number
  pageSize: number
}

export interface AdminAppealQueueItem {
  appealId: string
  accountPublicId: string
  type: 'report_no_violation_review' | 'account_restriction_review' | 'wallet_entry_review'
  reportId?: string
  originalReportVersion?: number
  source?: {
    type: AppServiceAppealSourceType
    sourceId: string
    sourceVersion: string
    reference: string
    label: string
  }
  status: AppSafetyAppealStatus
  workflowStatus: string
  reviewState: AppAppealReviewState
  userVisibleMessage: string
  version: number
  assignedToMe: boolean
  canClaim: boolean
  isolationBlocked: boolean
  overdue: boolean
  submittedAt: string
  updatedAt: string
  reviewDueAt: string | null
  supplementDueAt: string | null
  resolvedAt: string | null
}

type QueueRow = {
  appeal_id: string
  account_public_id: string
  source_type: string
  source_id: string
  source_version: string
  source_reference: string
  source_label: string
  workflow_status: string
  review_state: string
  user_visible_status: string
  user_visible_message: string
  assigned_admin_id: number | null
  original_decision_admin_id: number | null
  version: number
  submitted_at: string
  updated_at: string
  review_due_at: string | null
  supplement_due_at: string | null
  resolved_at: string | null
}

export function parseAdminAppealQueueQuery(input: {
  status?: string
  sourceType?: string
  assignment?: string
  query?: string
  page?: string
  pageSize?: string
}): AdminAppealQueueQuery {
  const status = input.status ?? 'open'
  const sourceType = input.sourceType ?? 'all'
  const assignment = input.assignment ?? 'all'
  if (!STATUSES.has(status)) throw new AppSafetyError(400, 'APPEAL_STATUS_INVALID', '申诉状态筛选无效')
  if (!SOURCE_TYPES.has(sourceType)) throw new AppSafetyError(400, 'APPEAL_SOURCE_FILTER_INVALID', '申诉来源筛选无效')
  if (!ASSIGNMENTS.has(assignment)) throw new AppSafetyError(400, 'APPEAL_ASSIGNMENT_FILTER_INVALID', '申诉分配筛选无效')

  const query = (input.query ?? '').trim()
  if (query.length > 80 || containsControl(query)) {
    throw new AppSafetyError(400, 'APPEAL_QUERY_INVALID', '搜索文字不能超过 80 个字符且不能包含控制字符')
  }
  const parsedPage = Number.parseInt(input.page ?? '', 10)
  const parsedPageSize = Number.parseInt(input.pageSize ?? '', 10)
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, 250) : 1
  const pageSize = Number.isFinite(parsedPageSize) && parsedPageSize > 0
    ? Math.min(parsedPageSize, 50)
    : 20
  return {
    status: status as AdminAppealQueueQuery['status'],
    sourceType: sourceType as AdminAppealQueueSourceFilter,
    assignment: assignment as AdminAppealQueueAssignmentFilter,
    query,
    page,
    pageSize,
  }
}

export async function listAdminAppealQueue(
  db: D1Database,
  adminId: number,
  query: AdminAppealQueueQuery,
): Promise<{
  items: AdminAppealQueueItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const { where, params } = buildWhere(query, adminId)
  const count = await db.prepare(`${APPEAL_QUEUE_CTE}
    SELECT COUNT(*) AS total
    FROM appeal_queue queue
    ${where}
  `).bind(...params).first<{ total: number }>()
  const total = Number(count?.total ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize))
  const page = Math.min(query.page, totalPages)
  const offset = (page - 1) * query.pageSize
  const rows = await db.prepare(`${APPEAL_QUEUE_CTE}
    SELECT *
    FROM appeal_queue queue
    ${where}
    ORDER BY
      CASE
        WHEN queue.workflow_status IN ('submitted', 'triaged', 'investigating')
          AND queue.review_due_at IS NOT NULL
          AND julianday(queue.review_due_at) < julianday('now') THEN 0
        ELSE 1
      END,
      CASE
        WHEN queue.workflow_status IN ('upheld', 'changed', 'closed') THEN 3
        WHEN queue.assigned_admin_id = ? THEN 0
        WHEN queue.assigned_admin_id IS NULL
          AND (queue.original_decision_admin_id IS NULL OR queue.original_decision_admin_id <> ?) THEN 1
        ELSE 2
      END,
      queue.submitted_at ASC,
      queue.appeal_id ASC
    LIMIT ? OFFSET ?
  `).bind(...params, adminId, adminId, query.pageSize, offset).all<QueueRow>()
  return {
    items: rows.results.map(row => mapQueueItem(row, adminId)),
    total,
    page,
    pageSize: query.pageSize,
    totalPages,
  }
}

export async function getAdminAppealQueueSummary(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
): Promise<AdminAppealQueueItem> {
  const appealId = normalizeAppealId(appealIdValue)
  const row = await db.prepare(`${APPEAL_QUEUE_CTE}
    SELECT * FROM appeal_queue queue WHERE queue.appeal_id = ? LIMIT 1
  `).bind(appealId).first<QueueRow>()
  if (!row) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return mapQueueItem(row, adminId)
}

const APPEAL_QUEUE_CTE = `
  WITH appeal_queue AS (
    SELECT appeal.id AS appeal_id,
           security.account_public_id,
           'report' AS source_type,
           appeal.report_id AS source_id,
           CAST(appeal.original_report_version AS TEXT) AS source_version,
           appeal.report_id AS source_reference,
           '举报结论' AS source_label,
           appeal.status AS workflow_status,
           appeal.review_state,
           appeal.user_visible_status,
           appeal.user_visible_message,
           appeal.assigned_admin_id,
           appeal.original_decision_admin_id,
           appeal.version,
           appeal.submitted_at,
           appeal.updated_at,
           appeal.review_due_at,
           appeal.supplement_due_at,
           appeal.resolved_at
    FROM app_safety_appeals appeal
    INNER JOIN app_account_security security ON security.account_id = appeal.account_id

    UNION ALL

    SELECT appeal.id AS appeal_id,
           security.account_public_id,
           appeal.source_type,
           appeal.source_id,
           appeal.source_version,
           appeal.source_reference,
           appeal.source_label,
           appeal.status AS workflow_status,
           appeal.review_state,
           appeal.user_visible_status,
           appeal.user_visible_message,
           appeal.assigned_admin_id,
           appeal.original_decision_admin_id,
           appeal.version,
           appeal.submitted_at,
           appeal.updated_at,
           appeal.review_due_at,
           appeal.supplement_due_at,
           appeal.resolved_at
    FROM app_service_appeals appeal
    INNER JOIN app_account_security security ON security.account_id = appeal.account_id
  )
`

function buildWhere(query: AdminAppealQueueQuery, adminId: number) {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.status === 'open') {
    conditions.push("queue.workflow_status IN ('submitted', 'triaged', 'investigating')")
  }
  else if (query.status !== 'all') {
    conditions.push('queue.user_visible_status = ?')
    params.push(query.status)
  }
  if (query.sourceType !== 'all') {
    conditions.push('queue.source_type = ?')
    params.push(query.sourceType)
  }
  if (query.assignment === 'mine') {
    conditions.push('queue.assigned_admin_id = ?')
    params.push(adminId)
  }
  else if (query.assignment === 'unassigned') {
    conditions.push("queue.workflow_status IN ('submitted', 'triaged', 'investigating')")
    conditions.push('queue.assigned_admin_id IS NULL')
    conditions.push('(queue.original_decision_admin_id IS NULL OR queue.original_decision_admin_id <> ?)')
    params.push(adminId)
  }
  else if (query.assignment === 'other') {
    conditions.push('queue.assigned_admin_id IS NOT NULL AND queue.assigned_admin_id <> ?')
    params.push(adminId)
  }
  else if (query.assignment === 'isolation_blocked') {
    conditions.push("queue.workflow_status IN ('submitted', 'triaged', 'investigating')")
    conditions.push('queue.original_decision_admin_id = ?')
    params.push(adminId)
  }
  if (query.query) {
    const pattern = `%${escapeLike(query.query.toLowerCase())}%`
    conditions.push(`(
      lower(queue.appeal_id) LIKE ? ESCAPE '\\'
      OR lower(queue.source_reference) LIKE ? ESCAPE '\\'
      OR lower(queue.account_public_id) LIKE ? ESCAPE '\\'
    )`)
    params.push(pattern, pattern, pattern)
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function mapQueueItem(row: QueueRow, adminId: number): AdminAppealQueueItem {
  const status = normalizeVisibleStatus(row.user_visible_status)
  const final = FINAL_STATUSES.has(row.workflow_status)
  const assignedToMe = row.assigned_admin_id === adminId
  const isolationBlocked = !final && row.original_decision_admin_id === adminId
  const reviewDueAtMs = row.review_due_at ? Date.parse(row.review_due_at) : Number.NaN
  const common = {
    appealId: row.appeal_id,
    accountPublicId: row.account_public_id,
    status,
    workflowStatus: row.workflow_status,
    reviewState: normalizeReviewState(row.review_state),
    userVisibleMessage: row.user_visible_message,
    version: Number(row.version),
    assignedToMe,
    canClaim: !final && row.assigned_admin_id === null && !isolationBlocked,
    isolationBlocked,
    overdue: !final && Number.isFinite(reviewDueAtMs) && reviewDueAtMs < Date.now(),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    reviewDueAt: row.review_due_at,
    supplementDueAt: row.supplement_due_at,
    resolvedAt: row.resolved_at,
  }
  if (row.source_type === 'report') {
    return {
      ...common,
      type: 'report_no_violation_review',
      reportId: row.source_id,
      originalReportVersion: Number(row.source_version),
    }
  }
  const sourceType = normalizeSourceType(row.source_type)
  return {
    ...common,
    type: sourceType === 'account_restriction' ? 'account_restriction_review' : 'wallet_entry_review',
    source: {
      type: sourceType,
      sourceId: row.source_id,
      sourceVersion: row.source_version,
      reference: row.source_reference,
      label: row.source_label,
    },
  }
}

function normalizeReviewState(value: string): AppAppealReviewState {
  if (value === 'normal' || value === 'evidence_insufficient' || value === 'needs_escalation') return value
  return 'normal'
}

function normalizeAppealId(value: string) {
  if (!APPEAL_ID_PATTERN.test(value)) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return value
}

function normalizeSourceType(value: string): AppServiceAppealSourceType {
  if (value === 'account_restriction' || value === 'wallet_entry') return value
  throw new AppSafetyError(503, 'APPEAL_DATA_INVALID', '申诉来源类型异常', true)
}

function normalizeVisibleStatus(value: string): AppSafetyAppealStatus {
  if (value === 'submitted' || value === 'processing' || value === 'upheld' || value === 'changed' || value === 'closed') {
    return value
  }
  return 'processing'
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

function containsControl(value: string) {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point === 0x7f || point < 0x20
  })
}
