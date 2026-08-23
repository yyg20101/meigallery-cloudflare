import type {
  AppMembershipApplication,
  AppMembershipApplicationStatus,
  AppMembershipSnapshot,
} from '@meigallery/shared'
import {
  createAdminAppMembershipGrantChangeRequest,
  getAdminAppMembershipChangeRequest,
  type AdminAppMembershipChangeRequestView,
} from './admin-app-membership-reviews'
import {
  getAppMembershipApplicationForAdmin,
} from './app-membership-applications'
import {
  AppMembershipError,
  resolveAppMembershipSnapshot,
} from './app-membership'

export interface AdminAppMembershipApplicationView {
  application: AppMembershipApplication
  account: {
    userId: number
    accountId: string | null
    email: string
    emailMasked: string
    status: string
  }
  assignedTo: number | null
  currentMembership: AppMembershipSnapshot
  grantReview: null | {
    requestId: string
    status: AdminAppMembershipChangeRequestView['status']
    version: number
    requestedBy: number
    createdAt: string
    reviewedAt: string | null
  }
}

export interface AdminAppMembershipApplicationListQuery {
  status?: unknown
  tierId?: unknown
  assignedTo?: unknown
  submittedFrom?: unknown
  submittedTo?: unknown
  limit?: unknown
}

export interface AdminAppMembershipApplicationMutationInput {
  expectedVersion?: unknown
  reasonCode?: unknown
  message?: unknown
}

export interface AdminAppMembershipApplicationApproveInput {
  expectedVersion?: unknown
  startsAt?: unknown
  durationDays?: unknown
  userVisibleNote?: unknown
  internalNote?: unknown
}

interface AdminApplicationRow {
  id: string
  user_id: number
  catalog_version_id: string
  tier_id: string
  status: string
  version: number
  assigned_to: number | null
  approval_request_key: string | null
  account_public_id: string | null
  email: string
  account_status: string
}

type AdminTransition = 'request_information' | 'reject' | 'expire' | 'cancel'

export async function listAdminAppMembershipApplications(
  db: D1Database,
  catalogVersionId: string,
  query: AdminAppMembershipApplicationListQuery,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipApplicationView[]> {
  const filters = normalizeListQuery(query)
  const where = ['1 = 1']
  const bindings: Array<string | number> = []
  if (filters.status) {
    where.push('a.status = ?')
    bindings.push(filters.status)
  }
  if (filters.tierId) {
    where.push('a.tier_id = ?')
    bindings.push(filters.tierId)
  }
  if (filters.assignedTo !== null) {
    where.push('a.assigned_to = ?')
    bindings.push(filters.assignedTo)
  }
  if (filters.submittedFrom) {
    where.push('a.submitted_at >= ?')
    bindings.push(filters.submittedFrom)
  }
  if (filters.submittedTo) {
    where.push('a.submitted_at < ?')
    bindings.push(filters.submittedTo)
  }
  bindings.push(filters.limit)
  const result = await db.prepare(`
    ${adminApplicationSelect()}
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE a.status
        WHEN 'submitted' THEN 1
        WHEN 'processing' THEN 2
        WHEN 'needs_information' THEN 3
        ELSE 4
      END,
      a.submitted_at ASC,
      a.id ASC
    LIMIT ?
  `).bind(...bindings).all<AdminApplicationRow>()
  return Promise.all(result.results.map(row => adminApplicationView(
    db,
    catalogVersionId,
    row,
    now,
    requireProductionReady,
    false,
  )))
}

export async function getAdminAppMembershipApplication(
  db: D1Database,
  catalogVersionId: string,
  applicationId: string,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipApplicationView> {
  const row = await getAdminApplicationRow(db, applicationId)
  return adminApplicationView(db, catalogVersionId, row, now, requireProductionReady, true)
}

export async function claimAdminAppMembershipApplication(
  db: D1Database,
  catalogVersionId: string,
  applicationId: string,
  adminId: number,
  expectedVersionInput: unknown,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipApplicationView> {
  const expectedVersion = normalizeExpectedVersion(expectedVersionInput)
  const current = await getAdminApplicationRow(db, applicationId)
  if (
    current.status === 'processing'
    && Number(current.assigned_to) === adminId
    && Number(current.version) === expectedVersion
  ) {
    return getAdminAppMembershipApplication(db, catalogVersionId, applicationId, now, requireProductionReady)
  }
  if (current.status !== 'submitted' || current.approval_request_key) throw stateConflict()
  if (Number(current.version) !== expectedVersion) throw versionConflict()
  if (current.assigned_to !== null && Number(current.assigned_to) !== adminId) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_ALREADY_ASSIGNED', '该申请已由其他管理员领取')
  }

  const nextVersion = expectedVersion + 1
  const createdAt = now.toISOString()
  const eventId = secureId('amae')
  const auditId = secureId('audit')
  const results = await db.batch([
    db.prepare(`
      UPDATE app_membership_applications
      SET status = 'processing', assigned_to = ?, version = ?, updated_at = ?
      WHERE id = ? AND status = 'submitted' AND version = ?
        AND (assigned_to IS NULL OR assigned_to = ?) AND approval_request_key IS NULL
    `).bind(adminId, nextVersion, createdAt, applicationId, expectedVersion, adminId),
    transitionEventStatement(db, {
      eventId,
      applicationId,
      sequence: nextVersion,
      eventType: 'claimed',
      fromStatus: 'submitted',
      toStatus: 'processing',
      message: '平台已开始人工处理；申请尚未产生任何会员权限。',
      adminId,
      createdAt,
    }),
    auditStatement(db, {
      auditId,
      adminId,
      action: 'app_membership_application_claim',
      applicationId,
      before: { status: 'submitted', version: expectedVersion },
      after: { status: 'processing', version: nextVersion, assignedTo: adminId },
      createdAt,
      expectedStatus: 'processing',
      expectedVersion: nextVersion,
    }),
  ])
  assertBatchChanged(results)
  return getAdminAppMembershipApplication(db, catalogVersionId, applicationId, now, requireProductionReady)
}

export async function transitionAdminAppMembershipApplication(
  db: D1Database,
  catalogVersionId: string,
  applicationId: string,
  adminId: number,
  transition: AdminTransition,
  body: AdminAppMembershipApplicationMutationInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AdminAppMembershipApplicationView> {
  const expectedVersion = normalizeExpectedVersion(body.expectedVersion)
  const current = await getAdminApplicationRow(db, applicationId)
  if (Number(current.version) !== expectedVersion) throw versionConflict()
  if (current.approval_request_key) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_APPROVAL_IN_PROGRESS', '申请正在执行会员发放，不能改为其他状态')
  }
  const definition = transitionDefinition(transition, body, current)
  if (!definition.allowedFrom.includes(current.status)) throw stateConflict()
  if (current.assigned_to !== null && Number(current.assigned_to) !== adminId) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_NOT_ASSIGNED', '请先由当前管理员领取申请')
  }

  const nextVersion = expectedVersion + 1
  const createdAt = now.toISOString()
  const resolvedAt = ['rejected', 'cancelled', 'expired'].includes(definition.toStatus) ? createdAt : null
  const eventId = secureId('amae')
  const auditId = secureId('audit')
  const results = await db.batch([
    db.prepare(`
      UPDATE app_membership_applications
      SET status = ?, version = ?, information_request_code = ?, information_request_message = ?,
          decision_reason_code = ?, decision_message = ?, updated_at = ?, resolved_at = ?
      WHERE id = ? AND status = ? AND version = ? AND approval_request_key IS NULL
        AND (? != 'processing' OR assigned_to = ?)
    `).bind(
      definition.toStatus,
      nextVersion,
      definition.informationCode,
      definition.toStatus === 'needs_information' ? definition.message : null,
      definition.decisionCode,
      definition.toStatus === 'needs_information' ? null : definition.message,
      createdAt,
      resolvedAt,
      applicationId,
      current.status,
      expectedVersion,
      current.status,
      adminId,
    ),
    transitionEventStatement(db, {
      eventId,
      applicationId,
      sequence: nextVersion,
      eventType: definition.eventType,
      fromStatus: normalizeStatus(current.status),
      toStatus: definition.toStatus,
      message: definition.message,
      adminId,
      createdAt,
    }),
    auditStatement(db, {
      auditId,
      adminId,
      action: `app_membership_application_${transition}`,
      applicationId,
      before: { status: current.status, version: expectedVersion },
      after: {
        status: definition.toStatus,
        version: nextVersion,
        reasonCode: definition.informationCode ?? definition.decisionCode,
        hasUserVisibleMessage: true,
      },
      createdAt,
      expectedStatus: definition.toStatus,
      expectedVersion: nextVersion,
    }),
  ])
  assertBatchChanged(results)
  return getAdminAppMembershipApplication(db, catalogVersionId, applicationId, now, requireProductionReady)
}

export async function approveAdminAppMembershipApplication(
  db: D1Database,
  catalogVersionId: string,
  applicationId: string,
  adminId: number,
  idempotencyKey: string | null,
  body: AdminAppMembershipApplicationApproveInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{
  application: AdminAppMembershipApplicationView
  review: AdminAppMembershipChangeRequestView
  replayed: boolean
}> {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  const expectedVersion = normalizeExpectedVersion(body.expectedVersion)
  const current = await getAdminApplicationRow(db, applicationId)
  const grantInput = {
    userId: current.user_id,
    tierId: current.tier_id,
    action: 'grant',
    startsAt: normalizeOptionalIso(body.startsAt),
    durationDays: body.durationDays,
    reasonCode: 'manual_review',
    userVisibleNote: normalizeVisibleNote(body.userVisibleNote),
    internalNote: body.internalNote,
    businessReference: `membership-application:${applicationId}`,
  } as const
  const applicationCatalogVersionId = current.catalog_version_id

  if (current.status === 'approved') {
    if (current.approval_request_key !== normalizedKey) {
      throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_ALREADY_APPROVED', '该申请已经完成会员发放')
    }
    const replayed = await db.prepare(`
      SELECT id FROM app_membership_change_requests
      WHERE source_application_id = ? AND requested_by = ? AND request_idempotency_key = ?
      LIMIT 1
    `).bind(applicationId, adminId, normalizedKey).first<{ id: string }>()
    if (!replayed) {
      throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_ALREADY_APPROVED', '该申请已经完成会员发放')
    }
    return {
      application: await getAdminAppMembershipApplication(
        db,
        catalogVersionId,
        applicationId,
        now,
        requireProductionReady,
      ),
      review: await getAdminAppMembershipChangeRequest(
        db,
        replayed.id,
        adminId,
        now,
        requireProductionReady,
      ),
      replayed: true,
    }
  }
  if (current.status !== 'processing' || Number(current.assigned_to) !== adminId) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_NOT_ASSIGNED', '只有领取该申请的管理员可以完成发放')
  }
  if (Number(current.version) !== expectedVersion) throw versionConflict()
  if (current.approval_request_key && current.approval_request_key !== normalizedKey) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_APPROVAL_IN_PROGRESS', '该申请已有另一笔发放正在处理')
  }
  if (!current.approval_request_key && applicationCatalogVersionId !== catalogVersionId) {
    throw new AppMembershipError(
      409,
      'MEMBERSHIP_APPLICATION_CATALOG_CHANGED',
      '会员目录已切换，不能把旧目录申请静默发放为当前等级；请结束旧申请并由用户重新提交',
    )
  }

  const reviewResult = await createAdminAppMembershipGrantChangeRequest(
    db,
    applicationCatalogVersionId,
    adminId,
    normalizedKey,
    grantInput,
    now,
    requireProductionReady,
    { applicationId, expectedVersion },
  )
  return {
    application: await getAdminAppMembershipApplication(
      db,
      catalogVersionId,
      applicationId,
      now,
      requireProductionReady,
    ),
    review: reviewResult.request,
    replayed: reviewResult.replayed,
  }
}

async function adminApplicationView(
  db: D1Database,
  catalogVersionId: string,
  row: AdminApplicationRow,
  now: Date,
  requireProductionReady: boolean,
  revealEmail: boolean,
): Promise<AdminAppMembershipApplicationView> {
  const [application, currentMembership, reviewRow] = await Promise.all([
    getAppMembershipApplicationForAdmin(db, row.id),
    resolveAppMembershipSnapshot(db, row.user_id, catalogVersionId, now, { requireProductionReady }),
    db.prepare(`
      SELECT id, status, version, requested_by, created_at, reviewed_at
      FROM app_membership_change_requests
      WHERE source_application_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).bind(row.id).first<{
      id: string
      status: AdminAppMembershipChangeRequestView['status']
      version: number
      requested_by: number
      created_at: string
      reviewed_at: string | null
    }>(),
  ])
  return {
    application,
    account: {
      userId: Number(row.user_id),
      accountId: row.account_public_id,
      email: revealEmail ? row.email : maskEmail(row.email),
      emailMasked: maskEmail(row.email),
      status: row.account_status,
    },
    assignedTo: row.assigned_to === null ? null : Number(row.assigned_to),
    currentMembership,
    grantReview: reviewRow
      ? {
          requestId: reviewRow.id,
          status: reviewRow.status,
          version: Number(reviewRow.version),
          requestedBy: Number(reviewRow.requested_by),
          createdAt: reviewRow.created_at,
          reviewedAt: reviewRow.reviewed_at,
        }
      : null,
  }
}

async function getAdminApplicationRow(db: D1Database, applicationId: string) {
  validateApplicationId(applicationId)
  const row = await db.prepare(`
    ${adminApplicationSelect()}
    WHERE a.id = ?
    LIMIT 1
  `).bind(applicationId).first<AdminApplicationRow>()
  if (!row) throw new AppMembershipError(404, 'MEMBERSHIP_APPLICATION_NOT_FOUND', '会员申请不存在')
  return row
}

function adminApplicationSelect() {
  return `
    SELECT a.id, a.user_id, a.catalog_version_id, a.tier_id, a.status, a.version, a.assigned_to,
           a.approval_request_key, s.account_public_id, u.email, u.status AS account_status
    FROM app_membership_applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN app_account_security s ON s.account_id = a.user_id
  `
}

function transitionDefinition(
  transition: AdminTransition,
  body: AdminAppMembershipApplicationMutationInput,
  current: AdminApplicationRow,
) {
  const message = normalizeMessage(body.message)
  switch (transition) {
    case 'request_information':
      return {
        allowedFrom: ['processing'],
        toStatus: 'needs_information' as const,
        eventType: 'information_requested' as const,
        informationCode: normalizeInformationCode(body.reasonCode),
        decisionCode: null,
        message,
      }
    case 'reject':
      return {
        allowedFrom: ['processing'],
        toStatus: 'rejected' as const,
        eventType: 'rejected' as const,
        informationCode: null,
        decisionCode: normalizeDecisionCode(body.reasonCode, ['requirements_not_met', 'tier_unavailable', 'account_restricted', 'unable_to_verify', 'other']),
        message,
      }
    case 'expire':
      return {
        allowedFrom: ['submitted', 'processing', 'needs_information'],
        toStatus: 'expired' as const,
        eventType: 'expired' as const,
        informationCode: null,
        decisionCode: normalizeDecisionCode(body.reasonCode, ['application_stale', 'other']),
        message,
      }
    case 'cancel':
      return {
        allowedFrom: ['submitted', 'processing', 'needs_information'],
        toStatus: 'cancelled' as const,
        eventType: 'cancelled' as const,
        informationCode: null,
        decisionCode: normalizeDecisionCode(body.reasonCode, ['user_request', 'other']),
        message,
      }
    default:
      return neverTransition(transition, current)
  }
}

function transitionEventStatement(db: D1Database, input: {
  eventId: string
  applicationId: string
  sequence: number
  eventType: string
  fromStatus: AppMembershipApplicationStatus
  toStatus: AppMembershipApplicationStatus
  message: string
  adminId: number
  createdAt: string
}) {
  return db.prepare(`
    INSERT INTO app_membership_application_events (
      id, application_id, sequence, event_type, from_status, to_status,
      public_message, actor_type, actor_user_id, created_at
    )
    SELECT ?, id, ?, ?, ?, ?, ?, 'admin', ?, ?
    FROM app_membership_applications
    WHERE id = ? AND status = ? AND version = ?
  `).bind(
    input.eventId,
    input.sequence,
    input.eventType,
    input.fromStatus,
    input.toStatus,
    input.message,
    input.adminId,
    input.createdAt,
    input.applicationId,
    input.toStatus,
    input.sequence,
  )
}

function auditStatement(db: D1Database, input: {
  auditId: string
  adminId: number
  action: string
  applicationId: string
  before: unknown
  after: unknown
  createdAt: string
  expectedStatus: AppMembershipApplicationStatus
  expectedVersion: number
}) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_membership_application', id, ?, ?, ?
    FROM app_membership_applications
    WHERE id = ? AND status = ? AND version = ?
  `).bind(
    input.auditId,
    input.adminId,
    input.action,
    JSON.stringify(input.before),
    JSON.stringify(input.after),
    input.createdAt,
    input.applicationId,
    input.expectedStatus,
    input.expectedVersion,
  )
}

function assertBatchChanged(results: D1Result[]) {
  if (results.some(result => Number(result.meta.changes ?? 0) !== 1)) throw versionConflict()
}

function normalizeListQuery(query: AdminAppMembershipApplicationListQuery) {
  const status = query.status === undefined || query.status === '' ? null : normalizeStatus(query.status)
  const tierId = query.tierId === undefined || query.tierId === '' ? null : String(query.tierId)
  if (tierId && !/^amt_[A-Za-z0-9_-]{1,76}$/u.test(tierId)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_TIER_INVALID', 'tierId 格式无效')
  }
  let assignedTo: number | null = null
  if (query.assignedTo !== undefined && query.assignedTo !== '') {
    assignedTo = Number(query.assignedTo)
    if (!Number.isInteger(assignedTo) || assignedTo <= 0) {
      throw new AppMembershipError(400, 'ACCOUNT_ID_INVALID', 'assignedTo 必须为正整数')
    }
  }
  const limit = query.limit === undefined ? 30 : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppMembershipError(400, 'PAGE_SIZE_INVALID', 'limit 必须为 1–100 的整数')
  }
  return {
    status,
    tierId,
    assignedTo,
    submittedFrom: normalizeOptionalTimestamp(query.submittedFrom),
    submittedTo: normalizeOptionalTimestamp(query.submittedTo),
    limit,
  }
}

function normalizeStatus(value: unknown): AppMembershipApplicationStatus {
  if (
    value === 'submitted' || value === 'processing' || value === 'needs_information'
    || value === 'approved' || value === 'rejected' || value === 'cancelled' || value === 'expired'
  ) return value
  throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_STATUS_INVALID', '申请状态筛选无效')
}

function normalizeInformationCode(value: unknown) {
  if (value === 'contact_window' || value === 'application_statement' || value === 'account_confirmation' || value === 'other') return value
  throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_REASON_INVALID', '补充信息原因无效')
}

function normalizeDecisionCode(value: unknown, allowed: string[]) {
  if (typeof value === 'string' && allowed.includes(value)) return value
  throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_REASON_INVALID', '处理原因无效')
}

function normalizeMessage(value: unknown) {
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_MESSAGE_INVALID', '用户可见说明为必填')
  }
  const message = value.trim()
  if (!message || message.length > 240 || hasControlCharacter(message)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_MESSAGE_INVALID', '用户可见说明长度或字符无效')
  }
  return message
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
  })
}

function normalizeVisibleNote(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return '会员申请审核通过，会员权益已由平台正式发放。'
  }
  return normalizeMessage(value)
}

function normalizeExpectedVersion(value: unknown) {
  const version = Number(value)
  if (!Number.isInteger(version) || version < 1) {
    throw new AppMembershipError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return version
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (normalized.length < 16 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 必须为 16–128 位安全字符')
  }
  return normalized
}

function normalizeOptionalIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new AppMembershipError(400, 'MEMBERSHIP_DATE_INVALID', '开始时间格式无效')
  }
  return value
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new AppMembershipError(400, 'MEMBERSHIP_DATE_INVALID', '时间筛选格式无效')
  }
  return new Date(value).toISOString()
}

function validateApplicationId(value: string) {
  if (!/^ama_[A-Za-z0-9_-]{1,76}$/u.test(value)) {
    throw new AppMembershipError(404, 'MEMBERSHIP_APPLICATION_NOT_FOUND', '会员申请不存在')
  }
}

function versionConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_VERSION_CONFLICT', '申请状态已变化，请刷新后重试')
}

function stateConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_STATE_CONFLICT', '当前申请状态不允许此操作')
}

function maskEmail(email: string) {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(1, local.length - 2))}${email.slice(at)}`
}

function secureId(prefix: 'amae' | 'audit') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

function neverTransition(value: never, _current: AdminApplicationRow): never {
  throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_ACTION_INVALID', `未知处理动作：${String(value)}`)
}
