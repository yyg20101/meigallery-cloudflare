import type {
  AppMembershipApplication,
  AppMembershipApplicationMutationResult,
  AppMembershipApplicationStatus,
  AppMembershipContactWindow,
  AppMembershipTier,
} from '@meigallery/shared'
import {
  AppMembershipError,
  getAppMembershipCatalog,
  type AppMembershipRuntimeConfig,
} from './app-membership'

export const APP_MEMBERSHIP_APPLICATION_DISCLOSURE_VERSION = 'membership-application-development-1'
export const APP_MEMBERSHIP_APPLICATION_DISCLOSURE_TEXT =
  '提交申请不代表已获得会员。平台会进行人工审核，只有管理员完成正式发放后权益才生效；当前不提供 App 内支付，也不承诺固定处理时效或必然通过。'
export const APP_MEMBERSHIP_APPLICATION_MAX_STATEMENT_LENGTH = 300
export const APP_MEMBERSHIP_APPLICATION_CONTACT_WINDOWS = [
  { code: 'anytime', label: '时间不限' },
  { code: 'morning', label: '上午' },
  { code: 'afternoon', label: '下午' },
  { code: 'evening', label: '晚间' },
] as const satisfies ReadonlyArray<{ code: AppMembershipContactWindow; label: string }>

export interface SubmitAppMembershipApplicationInput {
  tierId?: unknown
  preferredContactWindow?: unknown
  statement?: unknown
  disclosureVersion?: unknown
  disclosureConfirmed?: unknown
}

export interface ResubmitAppMembershipApplicationInput {
  preferredContactWindow?: unknown
  statement?: unknown
  disclosureVersion?: unknown
  disclosureConfirmed?: unknown
  expectedVersion?: unknown
}

interface ApplicationRow {
  id: string
  user_id: number
  catalog_version_id: string
  tier_id: string
  tier_code_snapshot: string
  tier_name_snapshot: string
  rank_snapshot: number
  contact_method: string
  preferred_contact_window: string
  statement: string | null
  disclosure_version: string
  status: string
  version: number
  assigned_to: number | null
  information_request_message: string | null
  decision_message: string | null
  approval_request_key: string | null
  grant_id: string | null
  submitted_at: string
  updated_at: string
  resolved_at: string | null
  email: string
}

interface EventRow {
  sequence: number
  event_type: string
  to_status: string
  public_message: string
  created_at: string
}

interface RequestRow {
  operation: string
  request_hash: string
  application_id: string
}

interface AccountRow {
  email: string
  email_verified: number
  status: string
}

interface NormalizedApplicationInput {
  preferredContactWindow: AppMembershipContactWindow
  statement: string | null
  disclosureVersion: string
}

export function requireAppMembershipApplicationsEnabled(
  config: AppMembershipRuntimeConfig,
): asserts config is AppMembershipRuntimeConfig & { catalogVersionId: string } {
  if (!config.applicationsEnabled || !config.catalogVersionId) {
    throw new AppMembershipError(403, 'FEATURE_DISABLED', '站内会员申请尚未开放')
  }
}

export async function listAppMembershipApplications(
  db: D1Database,
  userId: number,
): Promise<AppMembershipApplication[]> {
  const result = await db.prepare(`${applicationSelect()}
    WHERE a.user_id = ?
    ORDER BY a.submitted_at DESC, a.id ASC
    LIMIT 20
  `).bind(userId).all<ApplicationRow>()
  return Promise.all(result.results.map(row => applicationView(db, row)))
}

export async function getAppMembershipApplication(
  db: D1Database,
  userId: number,
  applicationId: string,
): Promise<AppMembershipApplication> {
  validateApplicationId(applicationId)
  const row = await db.prepare(`${applicationSelect()}
    WHERE a.id = ? AND a.user_id = ?
    LIMIT 1
  `).bind(applicationId, userId).first<ApplicationRow>()
  if (!row) throw applicationNotFound()
  return applicationView(db, row)
}

export async function getAppMembershipApplicationForAdmin(
  db: D1Database,
  applicationId: string,
): Promise<AppMembershipApplication> {
  validateApplicationId(applicationId)
  const row = await getApplicationRowForAdmin(db, applicationId)
  return applicationView(db, row)
}

export async function submitAppMembershipApplication(
  db: D1Database,
  userId: number,
  catalogVersionId: string,
  idempotencyKey: string | null,
  body: SubmitAppMembershipApplicationInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AppMembershipApplicationMutationResult> {
  const tierId = normalizeTierId(body.tierId)
  const input = normalizeApplicationInput(body)
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'submit', tierId, ...input }))
  const replay = await findRequest(db, userId, normalizedKey)
  if (replay) return resolveRequestReplay(db, userId, replay, 'submit', requestHash)

  const active = await findActiveApplicationRow(db, userId)
  if (active) {
    await recordDuplicateSubmitRequest(db, userId, normalizedKey, requestHash, active.id, now)
    return { application: await applicationView(db, active), created: false, replayed: true }
  }

  const [, catalog] = await Promise.all([
    getVerifiedAccount(db, userId),
    getAppMembershipCatalog(db, catalogVersionId, {
      requireProductionReady,
      applicationEnabled: true,
    }),
  ])
  const tier = catalog.tiers.find(item => item.tierId === tierId)
  if (!tier) throw new AppMembershipError(400, 'MEMBERSHIP_TIER_INVALID', '申请的会员等级不存在')

  const applicationId = secureId('ama')
  const requestId = secureId('amar')
  const eventId = secureId('amae')
  const createdAt = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_membership_applications (
          id, user_id, catalog_version_id, tier_id, tier_code_snapshot,
          tier_name_snapshot, rank_snapshot, contact_method, preferred_contact_window,
          statement, disclosure_version, disclosure_confirmed_at, status, version,
          submitted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'verified_email', ?, ?, ?, ?, 'submitted', 1, ?, ?)
      `).bind(
        applicationId,
        userId,
        catalogVersionId,
        tier.tierId,
        tier.code,
        tier.displayName,
        tier.rank,
        input.preferredContactWindow,
        input.statement,
        input.disclosureVersion,
        createdAt,
        createdAt,
        createdAt,
      ),
      db.prepare(`
        INSERT INTO app_membership_application_events (
          id, application_id, sequence, event_type, from_status, to_status,
          public_message, actor_type, actor_user_id, created_at
        ) VALUES (?, ?, 1, 'submitted', NULL, 'submitted', ?, 'viewer', ?, ?)
      `).bind(eventId, applicationId, submittedMessage(tier), userId, createdAt),
      db.prepare(`
        INSERT INTO app_membership_application_requests (
          id, user_id, idempotency_key, operation, request_hash, application_id, created_at
        ) VALUES (?, ?, ?, 'submit', ?, ?, ?)
      `).bind(requestId, userId, normalizedKey, requestHash, applicationId, createdAt),
    ])
  } catch (error) {
    const racedRequest = await findRequest(db, userId, normalizedKey)
    if (racedRequest) return resolveRequestReplay(db, userId, racedRequest, 'submit', requestHash)
    const racedActive = await findActiveApplicationRow(db, userId)
    if (racedActive) {
      await recordDuplicateSubmitRequest(db, userId, normalizedKey, requestHash, racedActive.id, now)
      return { application: await applicationView(db, racedActive), created: false, replayed: true }
    }
    throw error
  }

  return {
    application: await getAppMembershipApplication(db, userId, applicationId),
    created: true,
    replayed: false,
  }
}

export async function resubmitAppMembershipApplication(
  db: D1Database,
  userId: number,
  applicationId: string,
  idempotencyKey: string | null,
  body: ResubmitAppMembershipApplicationInput,
  now = new Date(),
): Promise<AppMembershipApplicationMutationResult> {
  validateApplicationId(applicationId)
  const input = normalizeApplicationInput(body)
  const expectedVersion = normalizeExpectedVersion(body.expectedVersion)
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({
    operation: 'resubmit', applicationId, expectedVersion, ...input,
  }))
  const replay = await findRequest(db, userId, normalizedKey)
  if (replay) return resolveRequestReplay(db, userId, replay, 'resubmit', requestHash)
  await getVerifiedAccount(db, userId)
  const current = await getOwnedApplicationRow(db, userId, applicationId)
  if (current.status !== 'needs_information' || current.approval_request_key) {
    throw stateConflict()
  }
  if (Number(current.version) !== expectedVersion) throw versionConflict()

  const nextVersion = expectedVersion + 1
  const createdAt = now.toISOString()
  const eventId = secureId('amae')
  const requestId = secureId('amar')
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE app_membership_applications
        SET preferred_contact_window = ?, statement = ?, disclosure_version = ?,
            disclosure_confirmed_at = ?, status = 'submitted', version = ?,
            information_request_code = NULL, information_request_message = NULL,
            updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'needs_information'
          AND version = ? AND approval_request_key IS NULL
      `).bind(
        input.preferredContactWindow,
        input.statement,
        input.disclosureVersion,
        createdAt,
        nextVersion,
        createdAt,
        applicationId,
        userId,
        expectedVersion,
      ),
      db.prepare(`
        INSERT INTO app_membership_application_events (
          id, application_id, sequence, event_type, from_status, to_status,
          public_message, actor_type, actor_user_id, created_at
        )
        SELECT ?, id, ?, 'resubmitted', 'needs_information', 'submitted',
               '补充信息已提交，申请已重新进入待处理队列。', 'viewer', ?, ?
        FROM app_membership_applications
        WHERE id = ? AND user_id = ? AND status = 'submitted' AND version = ?
      `).bind(eventId, nextVersion, userId, createdAt, applicationId, userId, nextVersion),
      db.prepare(`
        INSERT INTO app_membership_application_requests (
          id, user_id, idempotency_key, operation, request_hash, application_id, created_at
        )
        SELECT ?, user_id, ?, 'resubmit', ?, id, ?
        FROM app_membership_applications
        WHERE id = ? AND user_id = ? AND status = 'submitted' AND version = ?
      `).bind(requestId, normalizedKey, requestHash, createdAt, applicationId, userId, nextVersion),
    ])
    if (results.some(result => Number(result.meta.changes ?? 0) !== 1)) throw versionConflict()
  } catch (error) {
    const raced = await findRequest(db, userId, normalizedKey)
    if (raced) return resolveRequestReplay(db, userId, raced, 'resubmit', requestHash)
    throw error
  }
  return {
    application: await getAppMembershipApplication(db, userId, applicationId),
    created: false,
    replayed: false,
  }
}

export async function cancelAppMembershipApplication(
  db: D1Database,
  userId: number,
  applicationId: string,
  idempotencyKey: string | null,
  expectedVersionInput: unknown,
  now = new Date(),
): Promise<AppMembershipApplicationMutationResult> {
  validateApplicationId(applicationId)
  const expectedVersion = normalizeExpectedVersion(expectedVersionInput)
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({ operation: 'cancel', applicationId, expectedVersion }))
  const replay = await findRequest(db, userId, normalizedKey)
  if (replay) return resolveRequestReplay(db, userId, replay, 'cancel', requestHash)
  const current = await getOwnedApplicationRow(db, userId, applicationId)
  if (!['submitted', 'needs_information'].includes(current.status) || current.approval_request_key) {
    throw new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_CANNOT_CANCEL', '当前处理阶段不能取消申请')
  }
  if (Number(current.version) !== expectedVersion) throw versionConflict()

  const nextVersion = expectedVersion + 1
  const createdAt = now.toISOString()
  const eventId = secureId('amae')
  const requestId = secureId('amar')
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE app_membership_applications
        SET status = 'cancelled', version = ?, decision_reason_code = 'user_request',
            decision_message = '你已取消本次会员申请。', updated_at = ?, resolved_at = ?
        WHERE id = ? AND user_id = ? AND status IN ('submitted', 'needs_information')
          AND version = ? AND approval_request_key IS NULL
      `).bind(nextVersion, createdAt, createdAt, applicationId, userId, expectedVersion),
      db.prepare(`
        INSERT INTO app_membership_application_events (
          id, application_id, sequence, event_type, from_status, to_status,
          public_message, actor_type, actor_user_id, created_at
        )
        SELECT ?, id, ?, 'cancelled', ?, 'cancelled',
               '你已取消本次会员申请。', 'viewer', ?, ?
        FROM app_membership_applications
        WHERE id = ? AND user_id = ? AND status = 'cancelled' AND version = ?
      `).bind(eventId, nextVersion, current.status, userId, createdAt, applicationId, userId, nextVersion),
      db.prepare(`
        INSERT INTO app_membership_application_requests (
          id, user_id, idempotency_key, operation, request_hash, application_id, created_at
        )
        SELECT ?, user_id, ?, 'cancel', ?, id, ?
        FROM app_membership_applications
        WHERE id = ? AND user_id = ? AND status = 'cancelled' AND version = ?
      `).bind(requestId, normalizedKey, requestHash, createdAt, applicationId, userId, nextVersion),
    ])
    if (results.some(result => Number(result.meta.changes ?? 0) !== 1)) throw versionConflict()
  } catch (error) {
    const raced = await findRequest(db, userId, normalizedKey)
    if (raced) return resolveRequestReplay(db, userId, raced, 'cancel', requestHash)
    throw error
  }
  return {
    application: await getAppMembershipApplication(db, userId, applicationId),
    created: false,
    replayed: false,
  }
}

export async function getApplicationRowForAdmin(
  db: D1Database,
  applicationId: string,
): Promise<ApplicationRow> {
  const row = await db.prepare(`${applicationSelect()}
    WHERE a.id = ?
    LIMIT 1
  `).bind(applicationId).first<ApplicationRow>()
  if (!row) throw applicationNotFound()
  return row
}

async function getOwnedApplicationRow(db: D1Database, userId: number, applicationId: string) {
  const row = await db.prepare(`${applicationSelect()}
    WHERE a.id = ? AND a.user_id = ?
    LIMIT 1
  `).bind(applicationId, userId).first<ApplicationRow>()
  if (!row) throw applicationNotFound()
  return row
}

async function findActiveApplicationRow(db: D1Database, userId: number) {
  return db.prepare(`${applicationSelect()}
    WHERE a.user_id = ? AND a.status IN ('submitted', 'processing', 'needs_information')
    ORDER BY a.submitted_at DESC, a.id ASC
    LIMIT 1
  `).bind(userId).first<ApplicationRow>()
}

async function applicationView(db: D1Database, row: ApplicationRow): Promise<AppMembershipApplication> {
  const status = normalizeStatus(row.status)
  const contactWindow = normalizeContactWindow(row.preferred_contact_window)
  const eventResult = await db.prepare(`
    SELECT sequence, event_type, to_status, public_message, created_at
    FROM app_membership_application_events
    WHERE application_id = ?
    ORDER BY sequence ASC
  `).bind(row.id).all<EventRow>()
  return {
    applicationId: row.id,
    catalogVersionId: row.catalog_version_id,
    intendedTier: {
      tierId: row.tier_id,
      code: row.tier_code_snapshot,
      displayName: row.tier_name_snapshot,
      rank: Number(row.rank_snapshot),
      accentToken: accentForRank(Number(row.rank_snapshot)),
    },
    contact: {
      method: 'verified_email',
      maskedValue: maskEmail(row.email),
    },
    preferredContactWindow: contactWindow,
    statement: row.statement,
    disclosureVersion: row.disclosure_version,
    status,
    statusMessage: statusMessage(row),
    version: Number(row.version),
    canCancel: ['submitted', 'needs_information'].includes(status) && !row.approval_request_key,
    canResubmit: status === 'needs_information' && !row.approval_request_key,
    grantId: row.grant_id,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    timeline: eventResult.results.map(event => ({
      sequence: Number(event.sequence),
      eventType: normalizeEventType(event.event_type),
      status: normalizeStatus(event.to_status),
      message: event.public_message,
      createdAt: event.created_at,
    })),
  }
}

function applicationSelect() {
  return `
    SELECT a.id, a.user_id, a.catalog_version_id, a.tier_id, a.tier_code_snapshot,
           a.tier_name_snapshot, a.rank_snapshot, a.contact_method,
           a.preferred_contact_window, a.statement, a.disclosure_version, a.status,
           a.version, a.assigned_to, a.information_request_message, a.decision_message,
           a.approval_request_key, a.grant_id, a.submitted_at, a.updated_at, a.resolved_at,
           u.email
    FROM app_membership_applications a
    JOIN users u ON u.id = a.user_id
  `
}

async function getVerifiedAccount(db: D1Database, userId: number) {
  const account = await db.prepare(`
    SELECT email, email_verified, status FROM users WHERE id = ? LIMIT 1
  `).bind(userId).first<AccountRow>()
  if (!account || account.status !== 'active') {
    throw new AppMembershipError(409, 'ACCOUNT_RESTRICTED', '账号当前不能提交会员申请')
  }
  if (Number(account.email_verified) !== 1) {
    throw new AppMembershipError(409, 'VERIFIED_CONTACT_REQUIRED', '请先完成登录邮箱验证')
  }
  return account
}

async function findRequest(db: D1Database, userId: number, idempotencyKey: string) {
  return db.prepare(`
    SELECT operation, request_hash, application_id
    FROM app_membership_application_requests
    WHERE user_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(userId, idempotencyKey).first<RequestRow>()
}

async function recordDuplicateSubmitRequest(
  db: D1Database,
  userId: number,
  idempotencyKey: string,
  requestHash: string,
  applicationId: string,
  now: Date,
) {
  try {
    await db.prepare(`
      INSERT INTO app_membership_application_requests (
        id, user_id, idempotency_key, operation, request_hash, application_id, created_at
      ) VALUES (?, ?, ?, 'submit', ?, ?, ?)
    `).bind(secureId('amar'), userId, idempotencyKey, requestHash, applicationId, now.toISOString()).run()
  } catch (error) {
    const raced = await findRequest(db, userId, idempotencyKey)
    if (!raced) throw error
    if (raced.operation !== 'submit' || raced.request_hash !== requestHash || raced.application_id !== applicationId) {
      throw new AppMembershipError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被其他会员申请操作使用')
    }
  }
}

async function resolveRequestReplay(
  db: D1Database,
  userId: number,
  request: RequestRow,
  operation: RequestRow['operation'],
  requestHash: string,
): Promise<AppMembershipApplicationMutationResult> {
  if (request.operation !== operation || request.request_hash !== requestHash) {
    throw new AppMembershipError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已被其他会员申请操作使用')
  }
  return {
    application: await getAppMembershipApplication(db, userId, request.application_id),
    created: false,
    replayed: true,
  }
}

function normalizeApplicationInput(
  body: SubmitAppMembershipApplicationInput | ResubmitAppMembershipApplicationInput,
): NormalizedApplicationInput {
  const preferredContactWindow = normalizeContactWindow(body.preferredContactWindow)
  const disclosureVersion = typeof body.disclosureVersion === 'string'
    ? body.disclosureVersion.trim()
    : ''
  if (
    body.disclosureConfirmed !== true
    || disclosureVersion !== APP_MEMBERSHIP_APPLICATION_DISCLOSURE_VERSION
  ) {
    throw new AppMembershipError(409, 'DISCLOSURE_CONFIRMATION_REQUIRED', '请阅读并确认当前会员申请服务说明')
  }
  return {
    preferredContactWindow,
    statement: normalizeStatement(body.statement),
    disclosureVersion,
  }
}

function normalizeStatement(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_INPUT_INVALID', '申请说明格式无效')
  }
  const normalized = value.trim()
  if (!normalized) return null
  if (
    normalized.length > APP_MEMBERSHIP_APPLICATION_MAX_STATEMENT_LENGTH
    || hasControlCharacter(normalized)
  ) {
    throw new AppMembershipError(400, 'MEMBERSHIP_APPLICATION_INPUT_INVALID', '申请说明包含无效字符或超过长度限制')
  }
  return normalized
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

function normalizeContactWindow(value: unknown): AppMembershipContactWindow {
  if (value === 'anytime' || value === 'morning' || value === 'afternoon' || value === 'evening') return value
  throw new AppMembershipError(400, 'MEMBERSHIP_CONTACT_WINDOW_INVALID', '联系时段选项无效')
}

function normalizeTierId(value: unknown): string {
  const tierId = typeof value === 'string' ? value.trim() : ''
  if (!/^amt_[A-Za-z0-9_-]{1,76}$/u.test(tierId)) {
    throw new AppMembershipError(400, 'MEMBERSHIP_TIER_INVALID', 'tierId 格式无效')
  }
  return tierId
}

function normalizeExpectedVersion(value: unknown): number {
  const version = Number(value)
  if (!Number.isInteger(version) || version < 1) {
    throw new AppMembershipError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  return version
}

function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length < 16 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
    throw new AppMembershipError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 必须为 16–128 位安全字符')
  }
  return normalized
}

function normalizeStatus(value: string): AppMembershipApplicationStatus {
  if (
    value === 'submitted' || value === 'processing' || value === 'needs_information'
    || value === 'approved' || value === 'rejected' || value === 'cancelled' || value === 'expired'
  ) return value
  throw new AppMembershipError(503, 'MEMBERSHIP_APPLICATION_INVALID', '会员申请状态异常')
}

function normalizeEventType(value: string): AppMembershipApplication['timeline'][number]['eventType'] {
  if (
    value === 'submitted' || value === 'claimed' || value === 'information_requested'
    || value === 'resubmitted' || value === 'approved' || value === 'rejected'
    || value === 'cancelled' || value === 'expired'
  ) return value
  throw new AppMembershipError(503, 'MEMBERSHIP_APPLICATION_INVALID', '会员申请时间线异常')
}

function statusMessage(row: ApplicationRow): string {
  switch (row.status) {
    case 'submitted': return '申请已提交，尚未产生任何会员权限。'
    case 'processing': return '平台正在人工处理，尚未产生任何会员权限。'
    case 'needs_information': return row.information_request_message ?? '平台需要你补充申请信息。'
    case 'approved': return row.decision_message ?? '管理员已完成会员发放，请刷新本人权益。'
    case 'rejected': return row.decision_message ?? '本次申请未通过，你可以查看原因后重新申请。'
    case 'cancelled': return row.decision_message ?? '本次申请已取消。'
    case 'expired': return row.decision_message ?? '本次申请已过期，你可以重新提交。'
    default: throw new AppMembershipError(503, 'MEMBERSHIP_APPLICATION_INVALID', '会员申请状态异常')
  }
}

function submittedMessage(tier: AppMembershipTier) {
  return `${tier.displayName}会员申请已提交；申请不代表已获得会员，以管理员实际发放结果为准。`
}

function validateApplicationId(value: string) {
  if (!/^ama_[A-Za-z0-9_-]{1,76}$/u.test(value)) throw applicationNotFound()
}

function applicationNotFound() {
  return new AppMembershipError(404, 'MEMBERSHIP_APPLICATION_NOT_FOUND', '会员申请不存在')
}

function versionConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_VERSION_CONFLICT', '申请状态已变化，请刷新后重试')
}

function stateConflict() {
  return new AppMembershipError(409, 'MEMBERSHIP_APPLICATION_STATE_CONFLICT', '当前申请状态不允许此操作')
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(1, local.length - 2))}${domain}`
}

function accentForRank(rank: number) {
  if (rank >= 50) return 'gold'
  if (rank >= 40) return 'plum'
  if (rank >= 30) return 'violet'
  if (rank >= 20) return 'coral'
  return 'rose'
}

function secureId(prefix: 'ama' | 'amae' | 'amar') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
