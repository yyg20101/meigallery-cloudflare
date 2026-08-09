import type {
  AppDataRightsMutationResult,
  AppDataRightsRequestDetail,
  AppDataRightsRequestStatus,
  AppDataRightsRequestSummary,
  AppDataRightsRequestType,
  AppDataRightsStepUpPurpose,
  AppDataRightsStepUpResult,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import { verifyPassword } from '../utils/password'
import type { AppSessionPrincipal } from './app-account-access'

export const APP_DATA_RIGHTS_POLICY_ID = 'drp_app_1_0_privacy_1_dev_1'
export const APP_DATA_RIGHTS_DEFAULT_PAGE_SIZE = 20
export const APP_DATA_RIGHTS_MAX_PAGE_SIZE = 50
export const APP_DATA_RIGHTS_STATUS_HEADER = 'X-Data-Rights-Token' as const

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const REQUEST_ID = /^drr_[A-Za-z0-9_-]{1,92}$/u
const STEP_UP_TOKEN = /^drup_[A-Za-z0-9_-]{43}$/u
const STATUS_TOKEN = /^drat_[A-Za-z0-9_-]{43}$/u
const CURSOR_VERSION = 1
const VERIFICATION_FAILURE_LIMIT = 5
const VERIFICATION_FAILURE_WINDOW_MS = 15 * 60_000

const REQUEST_STATUSES = new Set<AppDataRightsRequestStatus>([
  'requested',
  'verification_required',
  'collecting',
  'ready',
  'expired',
  'scheduled',
  'processing',
  'completed',
  'cancelled',
  'failed',
])

const STATUS_MESSAGES: Record<AppDataRightsRequestStatus, string> = {
  requested: '申请已提交，等待平台开始处理',
  verification_required: '需要重新验证身份后继续',
  collecting: '平台正在汇总可提供的数据',
  ready: '数据副本已准备完成，请在有效期内下载',
  expired: '可下载副本已过期，可重新申请',
  scheduled: '注销申请已进入可取消等待阶段',
  processing: '注销正在处理，账号继续保持受限',
  completed: '数据权利申请已完成',
  cancelled: '申请已取消',
  failed: '处理未完成，平台会继续修复或提供支持',
}

export type AppDataRightsRuntimeConfig = {
  requested: boolean
  adminRequested: boolean
  policyId: string
  requireProductionReady: boolean
}

export type AppDataRightsCapabilities = {
  overview: boolean
  export: boolean
  deletion: boolean
  exportProcessing: boolean
  deletionProcessing: boolean
  cancellationEnabled: boolean
  policy: AppDataRightsPolicy | null
}

export type AppDataRightsPolicy = {
  id: string
  versionCode: string
  state: 'development' | 'published' | 'retired'
  productionReady: boolean
  requestsEnabled: boolean
  exportRequestsEnabled: boolean
  deletionRequestsEnabled: boolean
  exportProcessingEnabled: boolean
  deletionProcessingEnabled: boolean
  cancellationEnabled: boolean
  retentionDecisionStatus: 'unresolved' | 'approved'
  ownerSlaDecisionStatus: 'unresolved' | 'approved'
  regionDecisionStatus: 'unresolved' | 'approved'
  requestSlaHours: number | null
  deletionCoolingOffHours: number | null
  statusAccessTtlHours: number
  stepUpTtlSeconds: number
}

export type AppDataRightsStepUpInput = {
  password?: unknown
  purpose?: unknown
  requestId?: unknown
}

export type AppDataRightsDeletionRequestInput = {
  acknowledgements?: unknown
}

export type AppDataRightsCancelInput = {
  expectedVersion?: unknown
}

export type AppDataRightsListQuery = {
  type: AppDataRightsRequestType | null
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    type: AppDataRightsRequestType | null
    requestedAt: string
    requestId: string
  }
}

export class AppDataRightsError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

type PolicyRow = {
  id: string
  version_code: string
  state: 'development' | 'published' | 'retired'
  production_ready: number
  requests_enabled: number
  export_requests_enabled: number
  deletion_requests_enabled: number
  export_processing_enabled: number
  deletion_processing_enabled: number
  cancellation_enabled: number
  retention_decision_status: 'unresolved' | 'approved'
  owner_sla_decision_status: 'unresolved' | 'approved'
  region_decision_status: 'unresolved' | 'approved'
  request_sla_hours: number | null
  deletion_cooling_off_hours: number | null
  status_access_ttl_hours: number
  step_up_ttl_seconds: number
}

export type AppDataRightsRequestRow = {
  id: string
  request_type: AppDataRightsRequestType
  account_id: number
  policy_id: string
  policy_version_snapshot: string
  status: AppDataRightsRequestStatus
  status_message_code: string
  version: number
  mutation_token: string
  request_hash: string
  requested_session_id: string | null
  requested_device_id: string | null
  account_security_status_before: 'active' | 'restricted'
  account_restriction_reason_before: string | null
  account_restricted_until_before: string | null
  user_status_before: string
  assigned_to: number | null
  assigned_at: string | null
  deadline_at: string | null
  scheduled_for: string | null
  processing_started_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  failure_code: string | null
  requested_at: string
  updated_at: string
  cancellation_enabled: number
  policy_production_ready: number
  policy_export_processing_enabled: number
  policy_deletion_processing_enabled: number
  account_public_id: string
  account_email: string
  account_nickname: string | null
  account_current_status: string
  assignee_email: string | null
  assignee_nickname: string | null
}

type EventRow = {
  sequence: number
  request_version: number
  status_snapshot: AppDataRightsRequestStatus
  event_type: string
  user_message: string | null
  created_at: string
}

type SecuritySnapshotRow = {
  account_id: number
  account_public_id: string
  security_status: 'active' | 'restricted' | 'deletion_pending'
  restriction_reason_code: string | null
  restricted_until: string | null
  user_status: string
  password_hash: string
}

type StepUpRow = {
  id: string
  account_id: number
  session_id: string | null
  request_id: string | null
  purpose: AppDataRightsStepUpPurpose
  expires_at: string
  consumed_at: string | null
}

type StatusAccessRow = {
  request_id: string
  account_id: number
  expires_at: string
  revoked_at: string | null
}

type CommandRow = {
  request_hash: string
  result_request_id: string
  result_version: number
}

export function getAppDataRightsRuntimeConfig(env: Pick<
  Bindings,
  | 'APP_ENV'
  | 'APP_DATA_RIGHTS_ENABLED'
  | 'APP_DATA_RIGHTS_ADMIN_ENABLED'
  | 'APP_DATA_RIGHTS_POLICY_VERSION'
  | 'APP_DATA_RIGHTS_PRODUCTION_READY'
>): AppDataRightsRuntimeConfig {
  return {
    requested: env.APP_DATA_RIGHTS_ENABLED === 'true',
    adminRequested: env.APP_DATA_RIGHTS_ADMIN_ENABLED === 'true',
    policyId: env.APP_DATA_RIGHTS_POLICY_VERSION?.trim() ?? '',
    requireProductionReady: env.APP_ENV === 'production'
      || env.APP_DATA_RIGHTS_PRODUCTION_READY === 'true',
  }
}

export async function resolveAppDataRightsCapabilities(
  db: D1Database,
  config: AppDataRightsRuntimeConfig,
): Promise<AppDataRightsCapabilities> {
  if (!config.requested || !REQUEST_ID_OR_POLICY.test(config.policyId)) {
    return disabledCapabilities()
  }
  const row = await readPolicyRow(db, config.policyId)
  if (!row || row.state === 'retired' || (config.requireProductionReady && row.production_ready !== 1)) {
    return disabledCapabilities(row ? mapPolicy(row) : null)
  }
  const policy = mapPolicy(row)
  const overview = policy.requestsEnabled
  return {
    overview,
    export: overview && policy.exportRequestsEnabled,
    deletion: overview && policy.deletionRequestsEnabled,
    exportProcessing: overview && policy.exportProcessingEnabled,
    deletionProcessing: overview && policy.deletionProcessingEnabled,
    cancellationEnabled: overview && policy.cancellationEnabled,
    policy,
  }
}

const REQUEST_ID_OR_POLICY = /^[A-Za-z0-9_-]{5,96}$/u

export async function requireAppDataRightsPolicy(
  db: D1Database,
  config: AppDataRightsRuntimeConfig,
  capability: 'overview' | 'export' | 'deletion',
): Promise<AppDataRightsPolicy> {
  if (!config.requested) {
    throw new AppDataRightsError(403, 'FEATURE_DISABLED', '数据权利功能当前未开放')
  }
  if (!REQUEST_ID_OR_POLICY.test(config.policyId)) {
    throw new AppDataRightsError(503, 'DATA_RIGHTS_NOT_CONFIGURED', '数据权利策略尚未完成配置', true)
  }
  const capabilities = await resolveAppDataRightsCapabilities(db, config)
  if (!capabilities.policy) {
    throw new AppDataRightsError(503, 'DATA_RIGHTS_POLICY_UNAVAILABLE', '数据权利策略暂时不可用', true)
  }
  if (!capabilities[capability]) {
    const code = config.requireProductionReady && !capabilities.policy.productionReady
      ? 'DATA_RIGHTS_POLICY_NOT_READY'
      : 'FEATURE_DISABLED'
    throw new AppDataRightsError(
      code === 'FEATURE_DISABLED' ? 403 : 503,
      code,
      code === 'FEATURE_DISABLED' ? '该数据权利能力当前未开放' : '数据权利策略尚未通过生产门禁',
      code !== 'FEATURE_DISABLED',
    )
  }
  return capabilities.policy
}

export function parseAppDataRightsListQuery(input: {
  type?: string
  limit?: string
  cursor?: string
  accountScope: string
}): AppDataRightsListQuery {
  const type = input.type === undefined || input.type === ''
    ? null
    : requireRequestType(input.type)
  const parsedLimit = Number.parseInt(input.limit || '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_DATA_RIGHTS_MAX_PAGE_SIZE)
    : APP_DATA_RIGHTS_DEFAULT_PAGE_SIZE
  return {
    type,
    limit,
    cursor: input.cursor ? decodeCursor(input.cursor, input.accountScope, type) : null,
  }
}

export async function issueAppDataRightsStepUp(
  db: D1Database,
  principal: AppSessionPrincipal,
  config: AppDataRightsRuntimeConfig,
  input: AppDataRightsStepUpInput,
  requestTraceId: string,
  now = new Date(),
): Promise<AppDataRightsStepUpResult> {
  const purpose = requireStepUpPurpose(input.purpose)
  const requestId = purpose.endsWith('_cancel') || purpose === 'export_download'
    ? requireRequestId(input.requestId)
    : null
  let policy: AppDataRightsPolicy
  if (requestId) {
    const request = await requireRequestRow(db, requestId, principal.accountInternalId)
    const expectedType = purpose.startsWith('export_') ? 'export' : 'deletion'
    if (request.request_type !== expectedType) {
      throw new AppDataRightsError(400, 'STEP_UP_PURPOSE_INVALID', '二次验证用途与当前申请不一致')
    }
    if (purpose === 'export_download' && request.status !== 'ready') {
      throw new AppDataRightsError(409, 'EXPORT_NOT_READY', '导出文件尚未准备完成')
    }
    policy = await requirePolicyById(db, request.policy_id)
    if (purpose.endsWith('_cancel')) {
      if (!policy.cancellationEnabled) {
        throw new AppDataRightsError(403, 'REQUEST_CANCELLATION_DISABLED', '当前申请不可取消')
      }
      assertRequestCanCancel(request, now)
    }
  }
  else {
    const capability = purpose.startsWith('export_') ? 'export' : 'deletion'
    policy = await requireAppDataRightsPolicy(db, config, capability)
  }
  return issueStepUpForAccount(db, {
    accountId: principal.accountInternalId,
    sessionId: principal.sessionId,
    requestId,
    purpose,
    password: input.password,
    ttlSeconds: policy.stepUpTtlSeconds,
    requestTraceId,
    now,
  })
}

export async function issueAppDataRightsStepUpWithStatusToken(
  db: D1Database,
  requestIdValue: unknown,
  statusTokenValue: unknown,
  input: AppDataRightsStepUpInput,
  requestTraceId: string,
  now = new Date(),
): Promise<AppDataRightsStepUpResult> {
  const requestId = requireRequestId(requestIdValue)
  const access = await authenticateStatusAccess(db, requestId, statusTokenValue, now)
  const request = await requireRequestRow(db, requestId, access.account_id)
  const expectedPurpose: AppDataRightsStepUpPurpose = request.request_type === 'deletion'
    ? 'deletion_cancel'
    : 'export_cancel'
  const purpose = requireStepUpPurpose(input.purpose)
  if (purpose !== expectedPurpose) {
    throw new AppDataRightsError(400, 'STEP_UP_PURPOSE_INVALID', '二次验证用途与当前申请不一致')
  }
  const policy = await requirePolicyById(db, request.policy_id)
  if (!policy.cancellationEnabled) {
    throw new AppDataRightsError(403, 'REQUEST_CANCELLATION_DISABLED', '当前申请不可取消')
  }
  assertRequestCanCancel(request, now)
  return issueStepUpForAccount(db, {
    accountId: access.account_id,
    sessionId: null,
    requestId,
    purpose,
    password: input.password,
    ttlSeconds: policy.stepUpTtlSeconds,
    requestTraceId,
    now,
  })
}

export async function createAppDataExportRequest(
  env: Bindings,
  principal: AppSessionPrincipal,
  config: AppDataRightsRuntimeConfig,
  stepUpTokenValue: unknown,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<AppDataRightsMutationResult> {
  const policy = await requireAppDataRightsPolicy(env.DB, config, 'export')
  return createRequest(env, principal, policy, {
    type: 'export',
    initialStatus: 'requested',
    statusMessageCode: 'export_requested',
    purpose: 'export_request',
    stepUpTokenValue,
    idempotencyKeyValue,
    requestBody: { type: 'export' },
    scheduledFor: null,
    sessionRevoked: false,
    now,
  })
}

export async function createAppAccountDeletionRequest(
  env: Bindings,
  principal: AppSessionPrincipal,
  config: AppDataRightsRuntimeConfig,
  stepUpTokenValue: unknown,
  idempotencyKeyValue: string | null,
  input: AppDataRightsDeletionRequestInput,
  now = new Date(),
): Promise<AppDataRightsMutationResult> {
  const policy = await requireAppDataRightsPolicy(env.DB, config, 'deletion')
  const acknowledgements = requireDeletionAcknowledgements(input.acknowledgements)
  if (policy.deletionCoolingOffHours === null) {
    throw new AppDataRightsError(503, 'DELETION_SCHEDULE_NOT_CONFIGURED', '注销等待规则尚未完成配置', true)
  }
  return createRequest(env, principal, policy, {
    type: 'deletion',
    initialStatus: 'scheduled',
    statusMessageCode: 'deletion_scheduled',
    purpose: 'deletion_request',
    stepUpTokenValue,
    idempotencyKeyValue,
    requestBody: { type: 'deletion', acknowledgements },
    scheduledFor: new Date(now.getTime() + policy.deletionCoolingOffHours * 60 * 60_000).toISOString(),
    sessionRevoked: true,
    now,
  })
}

export async function recoverAppAccountDeletionRequest(
  env: Bindings,
  accessTokenValue: unknown,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<AppDataRightsMutationResult> {
  const accessToken = typeof accessTokenValue === 'string' ? accessTokenValue.trim() : ''
  if (!/^mga_[A-Za-z0-9_-]{43}$/u.test(accessToken)) throw invalidDeletionRecovery()
  const idempotencyHash = await sha256Hex(requireIdempotencyKey(idempotencyKeyValue))
  const session = await env.DB.prepare(`
    SELECT session.id, session.account_id
    FROM app_sessions session
    JOIN users ON users.id = session.account_id
    JOIN app_account_security security ON security.account_id = session.account_id
    WHERE session.access_token_hash = ?
      AND session.status = 'revoked'
      AND session.revoke_reason = 'account_deletion_requested'
      AND users.status = 'deletion_pending'
      AND security.status = 'deletion_pending'
    LIMIT 1
  `).bind(await sha256Hex(accessToken)).first<{ id: string; account_id: number }>()
  if (!session) throw invalidDeletionRecovery()
  const command = await findCommand(
    env.DB,
    `account:${session.account_id}`,
    'create_deletion',
    idempotencyHash,
  )
  if (!command) throw invalidDeletionRecovery()
  const request = await requireRequestRow(env.DB, command.result_request_id, session.account_id)
  if (
    request.request_type !== 'deletion'
    || request.requested_session_id !== session.id
    || !['scheduled', 'processing', 'failed'].includes(request.status)
  ) throw invalidDeletionRecovery()
  const result = await withDeterministicStatusAccess(env, {
    request: await mapRequestDetail(env.DB, request, true, now),
    statusAccess: null,
    replayed: true,
    sessionRevoked: true,
  }, request.id, now)
  if (!result.statusAccess) throw invalidDeletionRecovery()
  return result
}

export async function listAppDataRightsRequests(
  db: D1Database,
  accountId: number,
  accountScope: string,
  query: AppDataRightsListQuery,
  now = new Date(),
): Promise<{ data: AppDataRightsRequestSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = ['request.account_id = ?']
  const values: unknown[] = [accountId]
  if (query.type) {
    conditions.push('request.request_type = ?')
    values.push(query.type)
  }
  if (query.cursor) {
    conditions.push('(request.requested_at < ? OR (request.requested_at = ? AND request.id < ?))')
    values.push(query.cursor.requestedAt, query.cursor.requestedAt, query.cursor.requestId)
  }
  const rows = await db.prepare(`${requestSelect()}
    WHERE ${conditions.join(' AND ')}
    ORDER BY request.requested_at DESC, request.id DESC
    LIMIT ?
  `).bind(...values, query.limit + 1).all<AppDataRightsRequestRow>()
  const hasMore = rows.results.length > query.limit
  const pageRows = rows.results.slice(0, query.limit)
  const last = pageRows.at(-1)
  return {
    data: pageRows.map(row => mapRequestSummary(row, now)),
    nextCursor: hasMore && last
      ? encodeCursor({
          v: CURSOR_VERSION,
          accountScope,
          type: query.type,
          requestedAt: last.requested_at,
          requestId: last.id,
        })
      : null,
    hasMore,
  }
}

export async function getAppDataRightsRequest(
  db: D1Database,
  accountId: number,
  requestIdValue: unknown,
  now = new Date(),
): Promise<AppDataRightsRequestDetail> {
  const request = await requireRequestRow(db, requireRequestId(requestIdValue), accountId)
  return mapRequestDetail(db, request, false, now)
}

export async function getAppDataRightsRequestWithStatusToken(
  db: D1Database,
  requestIdValue: unknown,
  statusTokenValue: unknown,
  now = new Date(),
): Promise<AppDataRightsRequestDetail> {
  const requestId = requireRequestId(requestIdValue)
  const access = await authenticateStatusAccess(db, requestId, statusTokenValue, now)
  const request = await requireRequestRow(db, requestId, access.account_id)
  return mapRequestDetail(db, request, true, now)
}

export async function cancelAppDataRightsRequest(
  db: D1Database,
  access: { accountId: number; sessionId: string | null; statusToken?: unknown },
  requestIdValue: unknown,
  stepUpTokenValue: unknown,
  idempotencyKeyValue: string | null,
  input: AppDataRightsCancelInput,
  now = new Date(),
): Promise<AppDataRightsMutationResult> {
  const requestId = requireRequestId(requestIdValue)
  const statusTokenUsed = access.statusToken !== undefined
  const expectedVersion = requirePositiveInteger(input.expectedVersion, 'expectedVersion')
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const operation = 'cancel_request'
  const actorScope = `account:${access.accountId}`
  const idempotencyHash = await sha256Hex(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({ requestId, expectedVersion }))
  const replay = await findCommand(db, actorScope, operation, idempotencyHash)
  if (replay) {
    if (statusTokenUsed) {
      const statusAccess = await authenticateStatusAccess(
        db,
        requestId,
        access.statusToken,
        now,
        { allowRevokedForReplay: true },
      )
      if (statusAccess.account_id !== access.accountId) throw invalidStatusAccess()
    }
    return mutationReplay(db, replay, requestHash, statusTokenUsed, now)
  }
  if (statusTokenUsed) {
    const statusAccess = await authenticateStatusAccess(db, requestId, access.statusToken, now)
    if (statusAccess.account_id !== access.accountId) throw invalidStatusAccess()
  }

  const current = await requireRequestRow(db, requestId, access.accountId)
  if (current.version !== expectedVersion) {
    throw new AppDataRightsError(409, 'VERSION_CONFLICT', '申请状态已变化，请刷新后重试')
  }
  const policy = await requirePolicyById(db, current.policy_id)
  if (!policy.cancellationEnabled) {
    throw new AppDataRightsError(403, 'REQUEST_CANCELLATION_DISABLED', '当前申请不可取消')
  }
  assertRequestCanCancel(current, now)
  const purpose: AppDataRightsStepUpPurpose = current.request_type === 'deletion'
    ? 'deletion_cancel'
    : 'export_cancel'
  const stepUp = await requireStepUpToken(
    db,
    stepUpTokenValue,
    access.accountId,
    purpose,
    requestId,
    access.sessionId,
    now,
  )
  const timestamp = now.toISOString()
  const nextVersion = current.version + 1
  const mutationToken = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE app_data_rights_requests
      SET status = 'cancelled', status_message_code = 'request_cancelled',
          version = ?, mutation_token = ?, cancelled_at = ?, failure_code = NULL, updated_at = ?
      WHERE id = ? AND account_id = ? AND version = ?
        AND status = ? AND mutation_token = ?
    `).bind(
      nextVersion,
      mutationToken,
      timestamp,
      timestamp,
      requestId,
      access.accountId,
      current.version,
      current.status,
      current.mutation_token,
    ),
    requestEventStatement(db, requestId, nextVersion, mutationToken, {
      status: 'cancelled',
      eventType: 'cancelled',
      visibility: 'user',
      actorType: 'account',
      actorId: access.accountId,
      reasonCode: 'account_cancelled',
      userMessage: '申请已取消。若此前已退出登录，请重新登录后继续使用。',
      internalNote: null,
      safeSummary: { previousStatus: current.status },
      timestamp,
    }),
    consumeStepUpStatement(db, stepUp, requestId, timestamp),
    db.prepare(`
      UPDATE app_data_rights_status_tokens
      SET revoked_at = ?
      WHERE request_id = ? AND account_id = ? AND revoked_at IS NULL
    `).bind(timestamp, requestId, access.accountId),
    commandStatement(db, {
      actorScope,
      operation,
      idempotencyHash,
      requestHash,
      requestId,
      resultVersion: nextVersion,
      mutationToken,
      timestamp,
    }),
  ]
  if (current.request_type === 'deletion') {
    statements.push(
      db.prepare(`
        UPDATE users
        SET status = ?, updated_at = ?
        WHERE id = ? AND status = 'deletion_pending'
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.version = ? AND request.mutation_token = ?
              AND request.status = 'cancelled'
          )
      `).bind(current.user_status_before, timestamp, access.accountId, requestId, nextVersion, mutationToken),
      db.prepare(`
        UPDATE app_account_security
        SET status = ?, restriction_reason_code = ?, restricted_until = ?,
            session_version = session_version + 1, updated_at = ?
        WHERE account_id = ? AND status = 'deletion_pending'
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.version = ? AND request.mutation_token = ?
              AND request.status = 'cancelled'
          )
      `).bind(
        current.account_security_status_before,
        current.account_restriction_reason_before,
        current.account_restricted_until_before,
        timestamp,
        access.accountId,
        requestId,
        nextVersion,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO app_account_security_events (
          id, account_id, device_id, session_id, event_type, reason_code, request_id, created_at
        )
        SELECT ?, account_id, NULL, NULL, 'account_deletion_cancelled', 'verified_account_request', ?, ?
        FROM app_data_rights_requests
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = 'cancelled'
      `).bind(generateId('ase'), requestId, timestamp, requestId, nextVersion, mutationToken),
    )
  }
  await db.batch(statements)
  const stored = await findCommand(db, actorScope, operation, idempotencyHash)
  if (!stored) throw new AppDataRightsError(409, 'REQUEST_CANCEL_CONFLICT', '申请状态已变化，请刷新后重试')
  return {
    request: await getAppDataRightsRequest(db, access.accountId, requestId, now),
    statusAccess: null,
    replayed: false,
    sessionRevoked: current.request_type === 'deletion',
  }
}

export async function resolveAppDataRightsStatusAccount(
  db: D1Database,
  requestIdValue: unknown,
  statusTokenValue: unknown,
  now = new Date(),
  options: { allowRevokedForReplay?: boolean } = {},
): Promise<{ accountId: number }> {
  const requestId = requireRequestId(requestIdValue)
  const access = await authenticateStatusAccess(db, requestId, statusTokenValue, now, options)
  return { accountId: access.account_id }
}

async function createRequest(
  env: Bindings,
  principal: AppSessionPrincipal,
  policy: AppDataRightsPolicy,
  options: {
    type: AppDataRightsRequestType
    initialStatus: 'requested' | 'scheduled'
    statusMessageCode: string
    purpose: 'export_request' | 'deletion_request'
    stepUpTokenValue: unknown
    idempotencyKeyValue: string | null
    requestBody: Record<string, unknown>
    scheduledFor: string | null
    sessionRevoked: boolean
    now: Date
  },
): Promise<AppDataRightsMutationResult> {
  const idempotencyKey = requireIdempotencyKey(options.idempotencyKeyValue)
  const idempotencyHash = await sha256Hex(idempotencyKey)
  const actorScope = `account:${principal.accountInternalId}`
  const operation = options.type === 'export' ? 'create_export' : 'create_deletion'
  const requestHash = await sha256Hex(JSON.stringify({
    policyId: policy.id,
    policyVersion: policy.versionCode,
    ...options.requestBody,
  }))
  const replay = await findCommand(env.DB, actorScope, operation, idempotencyHash)
  if (replay) {
    const result = await mutationReplay(env.DB, replay, requestHash, false, options.now)
    return withDeterministicStatusAccess(env, result, replay.result_request_id, options.now)
  }

  const active = await findActiveRequest(env.DB, principal.accountInternalId, options.type)
  const stepUp = await requireStepUpToken(
    env.DB,
    options.stepUpTokenValue,
    principal.accountInternalId,
    options.purpose,
    null,
    principal.sessionId,
    options.now,
  )
  if (active) {
    const merged = await mergeActiveRequest(env, active, stepUp, {
      actorScope,
      operation,
      idempotencyHash,
      requestHash,
      now: options.now,
    })
    return merged
  }

  const security = await requireSecuritySnapshot(env.DB, principal.accountInternalId)
  if (security.security_status === 'deletion_pending') {
    throw new AppDataRightsError(409, 'ACCOUNT_DELETION_ALREADY_PENDING', '账号已有注销申请，请使用申请状态凭证查看')
  }
  const requestId = generateId('drr')
  const timestamp = options.now.toISOString()
  const deadlineAt = policy.requestSlaHours === null
    ? null
    : new Date(options.now.getTime() + policy.requestSlaHours * 60 * 60_000).toISOString()
  const statusAccessAnchorMs = Math.max(
    options.now.getTime(),
    deadlineAt ? Date.parse(deadlineAt) : 0,
    options.scheduledFor ? Date.parse(options.scheduledFor) : 0,
  )
  const statusExpiresAt = new Date(
    statusAccessAnchorMs + policy.statusAccessTtlHours * 60 * 60_000,
  ).toISOString()
  const statusToken = await deriveStatusToken(env.SESSION_SECRET, requestId, principal.accountInternalId, requestHash)
  const statusTokenHash = await sha256Hex(statusToken)
  const mutationToken = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    dbInsertRequest(env.DB, {
      requestId,
      accountId: principal.accountInternalId,
      policy,
      type: options.type,
      status: options.initialStatus,
      statusMessageCode: options.statusMessageCode,
      requestHash,
      sessionId: principal.sessionId,
      deviceId: principal.deviceId,
      security,
      deadlineAt,
      scheduledFor: options.scheduledFor,
      mutationToken,
      timestamp,
      stepUp,
    }),
    dbInsertStatusToken(env.DB, {
      requestId,
      accountId: principal.accountInternalId,
      tokenHash: statusTokenHash,
      expiresAt: statusExpiresAt,
      timestamp,
      mutationToken,
    }),
    requestEventStatement(env.DB, requestId, 1, mutationToken, {
      status: options.initialStatus,
      eventType: 'requested',
      visibility: 'user',
      actorType: 'account',
      actorId: principal.accountInternalId,
      reasonCode: 'fresh_verification_succeeded',
      userMessage: options.type === 'export'
        ? '数据导出申请已提交，可在 App 内查询进度。'
        : '注销申请已提交，账号已停止新增互动、话题、会员和金币操作。',
      internalNote: null,
      safeSummary: { policyVersion: policy.versionCode },
      timestamp,
      sequence: 1,
    }),
    consumeStepUpStatement(env.DB, stepUp, requestId, timestamp, mutationToken),
    commandStatement(env.DB, {
      actorScope,
      operation,
      idempotencyHash,
      requestHash,
      requestId,
      resultVersion: 1,
      mutationToken,
      timestamp,
    }),
  ]

  if (options.type === 'deletion') {
    statements.push(
      requestEventStatement(env.DB, requestId, 1, mutationToken, {
        status: 'scheduled',
        eventType: 'account_access_restricted',
        visibility: 'user',
        actorType: 'system',
        actorId: null,
        reasonCode: 'deletion_request_verified',
        userMessage: '账号会话已退出；在不可逆处理开始前，可使用本次申请的状态凭证取消。',
        internalNote: null,
        safeSummary: { sessionsRevoked: true },
        timestamp,
        sequence: 2,
      }),
      env.DB.prepare(`
        UPDATE users
        SET status = 'deletion_pending', updated_at = ?
        WHERE id = ? AND status = ?
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.mutation_token = ? AND request.status = 'scheduled'
          )
      `).bind(timestamp, principal.accountInternalId, security.user_status, requestId, mutationToken),
      env.DB.prepare(`
        UPDATE app_account_security
        SET status = 'deletion_pending', session_version = session_version + 1,
            restriction_reason_code = 'account_deletion_requested', restricted_until = NULL, updated_at = ?
        WHERE account_id = ? AND status = ?
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.mutation_token = ? AND request.status = 'scheduled'
          )
      `).bind(timestamp, principal.accountInternalId, security.security_status, requestId, mutationToken),
      env.DB.prepare(`
        UPDATE app_sessions
        SET status = 'revoked', revoked_at = ?, revoke_reason = 'account_deletion_requested', updated_at = ?
        WHERE account_id = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.mutation_token = ? AND request.status = 'scheduled'
          )
      `).bind(timestamp, timestamp, principal.accountInternalId, requestId, mutationToken),
      env.DB.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.mutation_token = ? AND request.status = 'scheduled'
          )
      `).bind(principal.accountInternalId, requestId, mutationToken),
      env.DB.prepare(`
        INSERT INTO app_account_security_events (
          id, account_id, device_id, session_id, event_type, reason_code, request_id, created_at
        )
        SELECT ?, account_id, requested_device_id, requested_session_id,
               'account_deletion_requested', 'fresh_verification', ?, ?
        FROM app_data_rights_requests
        WHERE id = ? AND mutation_token = ? AND status = 'scheduled'
      `).bind(generateId('ase'), requestId, timestamp, requestId, mutationToken),
    )
  }

  try {
    await env.DB.batch(statements)
  }
  catch {
    const raced = await findCommand(env.DB, actorScope, operation, idempotencyHash)
    if (raced) {
      const result = await mutationReplay(env.DB, raced, requestHash, false, options.now)
      return withDeterministicStatusAccess(env, result, raced.result_request_id, options.now)
    }
    throw new AppDataRightsError(409, 'DATA_RIGHTS_REQUEST_CONFLICT', '已有申请或账号状态发生变化，请刷新后重试')
  }
  const stored = await findCommand(env.DB, actorScope, operation, idempotencyHash)
  if (!stored) throw new AppDataRightsError(409, 'DATA_RIGHTS_REQUEST_CONFLICT', '申请未写入，请刷新后重试')
  return {
    request: await getAppDataRightsRequest(env.DB, principal.accountInternalId, requestId, options.now),
    statusAccess: { token: statusToken, expiresAt: statusExpiresAt },
    replayed: false,
    sessionRevoked: options.sessionRevoked,
  }
}

async function mergeActiveRequest(
  env: Bindings,
  active: AppDataRightsRequestRow,
  stepUp: StepUpRow,
  input: {
    actorScope: string
    operation: string
    idempotencyHash: string
    requestHash: string
    now: Date
  },
): Promise<AppDataRightsMutationResult> {
  const timestamp = input.now.toISOString()
  const statusToken = await deriveStatusToken(env.SESSION_SECRET, active.id, active.account_id, active.request_hash)
  const statusTokenHash = await sha256Hex(statusToken)
  const access = await env.DB.prepare(`
    SELECT expires_at FROM app_data_rights_status_tokens
    WHERE request_id = ? AND account_id = ? AND token_hash = ? AND revoked_at IS NULL
  `).bind(active.id, active.account_id, statusTokenHash).first<{ expires_at: string }>()
  await env.DB.batch([
    consumeStepUpStatement(env.DB, stepUp, active.id, timestamp),
    env.DB.prepare(`
      INSERT INTO app_data_rights_commands (
        id, actor_scope, operation, idempotency_key_hash, request_hash,
        result_request_id, result_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('drc'),
      input.actorScope,
      input.operation,
      input.idempotencyHash,
      input.requestHash,
      active.id,
      active.version,
      timestamp,
    ),
  ])
  return {
    request: await getAppDataRightsRequest(env.DB, active.account_id, active.id, input.now),
    statusAccess: access && Date.parse(access.expires_at) > input.now.getTime()
      ? { token: statusToken, expiresAt: access.expires_at }
      : null,
    replayed: true,
    sessionRevoked: active.request_type === 'deletion',
  }
}

async function withDeterministicStatusAccess(
  env: Bindings,
  result: AppDataRightsMutationResult,
  requestId: string,
  now: Date,
): Promise<AppDataRightsMutationResult> {
  const row = await requireRequestRow(env.DB, requestId)
  const token = await deriveStatusToken(env.SESSION_SECRET, row.id, row.account_id, row.request_hash)
  const tokenHash = await sha256Hex(token)
  const access = await env.DB.prepare(`
    SELECT expires_at FROM app_data_rights_status_tokens
    WHERE request_id = ? AND account_id = ? AND token_hash = ? AND revoked_at IS NULL
  `).bind(row.id, row.account_id, tokenHash).first<{ expires_at: string }>()
  return {
    ...result,
    statusAccess: access && Date.parse(access.expires_at) > now.getTime()
      ? { token, expiresAt: access.expires_at }
      : null,
  }
}

async function issueStepUpForAccount(
  db: D1Database,
  input: {
    accountId: number
    sessionId: string | null
    requestId: string | null
    purpose: AppDataRightsStepUpPurpose
    password: unknown
    ttlSeconds: number
    requestTraceId: string
    now: Date
  },
): Promise<AppDataRightsStepUpResult> {
  const password = typeof input.password === 'string' ? input.password : ''
  const windowStart = new Date(input.now.getTime() - VERIFICATION_FAILURE_WINDOW_MS).toISOString()
  const failure = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_data_rights_verification_attempts
    WHERE account_id = ? AND outcome = 'failed' AND datetime(created_at) >= datetime(?)
  `).bind(input.accountId, windowStart).first<{ count: number }>()
  if (Number(failure?.count ?? 0) >= VERIFICATION_FAILURE_LIMIT) {
    await recordVerificationAttempt(db, input, 'rate_limited')
    throw new AppDataRightsError(429, 'STEP_UP_RATE_LIMITED', '验证尝试过多，请稍后再试', true)
  }
  const account = await db.prepare(`
    SELECT password_hash, status FROM users WHERE id = ?
  `).bind(input.accountId).first<{ password_hash: string; status: string }>()
  const valid = Boolean(
    account
    && ['active', 'deletion_pending'].includes(account.status)
    && password.length >= 8
    && password.length <= 128
    && await verifyPassword(password, account.password_hash),
  )
  if (!valid) {
    await recordVerificationAttempt(db, input, 'failed')
    throw new AppDataRightsError(401, 'STEP_UP_FAILED', '身份验证失败，请检查密码后重试')
  }
  const token = randomOpaqueToken('drup')
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000).toISOString()
  const timestamp = input.now.toISOString()
  await db.batch([
    db.prepare(`
      INSERT INTO app_data_rights_verification_attempts (
        id, account_id, session_id, request_id, purpose, outcome, request_trace_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?)
    `).bind(
      generateId('drva'),
      input.accountId,
      input.sessionId,
      input.requestId,
      input.purpose,
      normalizeTraceId(input.requestTraceId),
      timestamp,
    ),
    db.prepare(`
      INSERT INTO app_data_rights_step_up_tokens (
        id, token_hash, account_id, session_id, request_id, purpose,
        expires_at, consumed_at, consumed_operation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).bind(
      generateId('drsu'),
      await sha256Hex(token),
      input.accountId,
      input.sessionId,
      input.requestId,
      input.purpose,
      expiresAt,
      timestamp,
    ),
  ])
  return { purpose: input.purpose, token, expiresAt }
}

async function recordVerificationAttempt(
  db: D1Database,
  input: {
    accountId: number
    sessionId: string | null
    requestId: string | null
    purpose: AppDataRightsStepUpPurpose
    requestTraceId: string
    now: Date
  },
  outcome: 'failed' | 'rate_limited',
) {
  await db.prepare(`
    INSERT INTO app_data_rights_verification_attempts (
      id, account_id, session_id, request_id, purpose, outcome, request_trace_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    generateId('drva'),
    input.accountId,
    input.sessionId,
    input.requestId,
    input.purpose,
    outcome,
    normalizeTraceId(input.requestTraceId),
    input.now.toISOString(),
  ).run()
}

async function authenticateStatusAccess(
  db: D1Database,
  requestId: string,
  tokenValue: unknown,
  now: Date,
  options: { allowRevokedForReplay?: boolean } = {},
): Promise<StatusAccessRow> {
  const token = typeof tokenValue === 'string' ? tokenValue.trim() : ''
  if (!STATUS_TOKEN.test(token)) throw invalidStatusAccess()
  const tokenHash = await sha256Hex(token)
  const row = await db.prepare(`
    SELECT request_id, account_id, expires_at, revoked_at
    FROM app_data_rights_status_tokens
    WHERE request_id = ? AND token_hash = ?
  `).bind(requestId, tokenHash).first<StatusAccessRow>()
  if (
    !row
    || (row.revoked_at && !options.allowRevokedForReplay)
    || Date.parse(row.expires_at) <= now.getTime()
  ) throw invalidStatusAccess()
  if (!row.revoked_at) {
    await db.prepare(`
      UPDATE app_data_rights_status_tokens
      SET last_used_at = ?
      WHERE request_id = ? AND token_hash = ? AND revoked_at IS NULL
        AND datetime(expires_at) > datetime(?)
    `).bind(now.toISOString(), requestId, tokenHash, now.toISOString()).run()
  }
  return row
}

async function requireStepUpToken(
  db: D1Database,
  tokenValue: unknown,
  accountId: number,
  purpose: AppDataRightsStepUpPurpose,
  requestId: string | null,
  sessionId: string | null,
  now: Date,
): Promise<StepUpRow> {
  const token = typeof tokenValue === 'string' ? tokenValue.trim() : ''
  if (!STEP_UP_TOKEN.test(token)) {
    throw new AppDataRightsError(401, 'STEP_UP_REQUIRED', '请重新验证身份后继续')
  }
  const row = await db.prepare(`
    SELECT id, account_id, session_id, request_id, purpose, expires_at, consumed_at
    FROM app_data_rights_step_up_tokens
    WHERE token_hash = ?
  `).bind(await sha256Hex(token)).first<StepUpRow>()
  const sessionMatches = sessionId === null || row?.session_id === sessionId
  if (
    !row
    || row.account_id !== accountId
    || row.purpose !== purpose
    || row.request_id !== requestId
    || !sessionMatches
    || row.consumed_at
    || Date.parse(row.expires_at) <= now.getTime()
  ) {
    throw new AppDataRightsError(401, 'STEP_UP_EXPIRED', '身份验证已失效，请重新验证')
  }
  return row
}

function consumeStepUpStatement(
  db: D1Database,
  stepUp: StepUpRow,
  operationId: string,
  timestamp: string,
  requestMutationToken?: string,
) {
  return db.prepare(`
    UPDATE app_data_rights_step_up_tokens
    SET consumed_at = ?, consumed_operation_id = ?
    WHERE id = ? AND consumed_at IS NULL AND datetime(expires_at) > datetime(?)
      ${requestMutationToken ? `AND EXISTS (
        SELECT 1 FROM app_data_rights_requests request
        WHERE request.id = ? AND request.mutation_token = ?
      )` : ''}
  `).bind(
    timestamp,
    operationId,
    stepUp.id,
    timestamp,
    ...(requestMutationToken ? [operationId, requestMutationToken] : []),
  )
}

function dbInsertRequest(
  db: D1Database,
  input: {
    requestId: string
    accountId: number
    policy: AppDataRightsPolicy
    type: AppDataRightsRequestType
    status: 'requested' | 'scheduled'
    statusMessageCode: string
    requestHash: string
    sessionId: string
    deviceId: string
    security: SecuritySnapshotRow
    deadlineAt: string | null
    scheduledFor: string | null
    mutationToken: string
    timestamp: string
    stepUp: StepUpRow
  },
) {
  return db.prepare(`
    INSERT INTO app_data_rights_requests (
      id, request_type, account_id, policy_id, policy_version_snapshot,
      status, status_message_code, version, mutation_token, request_hash,
      requested_session_id, requested_device_id,
      account_security_status_before, account_restriction_reason_before,
      account_restricted_until_before, user_status_before,
      assigned_to, assigned_at, deadline_at, scheduled_for,
      processing_started_at, completed_at, cancelled_at, failure_code,
      requested_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?,
           NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM app_data_rights_step_up_tokens token
      WHERE token.id = ? AND token.account_id = ? AND token.purpose = ?
        AND token.consumed_at IS NULL AND datetime(token.expires_at) > datetime(?)
    )
      AND NOT EXISTS (
        SELECT 1 FROM app_data_rights_requests active
        WHERE active.account_id = ? AND active.request_type = ?
          AND (
            (? = 'export' AND active.status IN ('requested', 'verification_required', 'collecting', 'ready'))
            OR (? = 'deletion' AND active.status IN (
              'requested', 'verification_required', 'scheduled', 'processing', 'failed'
            ))
          )
      )
  `).bind(
    input.requestId,
    input.type,
    input.accountId,
    input.policy.id,
    input.policy.versionCode,
    input.status,
    input.statusMessageCode,
    input.mutationToken,
    input.requestHash,
    input.sessionId,
    input.deviceId,
    input.security.security_status,
    input.security.restriction_reason_code,
    input.security.restricted_until,
    input.security.user_status,
    input.deadlineAt,
    input.scheduledFor,
    input.timestamp,
    input.timestamp,
    input.stepUp.id,
    input.accountId,
    input.stepUp.purpose,
    input.timestamp,
    input.accountId,
    input.type,
    input.type,
    input.type,
  )
}

function dbInsertStatusToken(
  db: D1Database,
  input: {
    requestId: string
    accountId: number
    tokenHash: string
    expiresAt: string
    timestamp: string
    mutationToken: string
  },
) {
  return db.prepare(`
    INSERT INTO app_data_rights_status_tokens (
      id, token_hash, request_id, account_id, expires_at, revoked_at, last_used_at, created_at
    )
    SELECT ?, ?, id, account_id, ?, NULL, NULL, ?
    FROM app_data_rights_requests
    WHERE id = ? AND account_id = ? AND mutation_token = ?
  `).bind(
    generateId('drst'),
    input.tokenHash,
    input.expiresAt,
    input.timestamp,
    input.requestId,
    input.accountId,
    input.mutationToken,
  )
}

function requestEventStatement(
  db: D1Database,
  requestId: string,
  requestVersion: number,
  requestMutationToken: string,
  input: {
    status: AppDataRightsRequestStatus
    eventType: string
    visibility: 'user' | 'internal'
    actorType: 'account' | 'admin' | 'system'
    actorId: number | null
    reasonCode: string
    userMessage: string | null
    internalNote: string | null
    safeSummary: Record<string, unknown>
    timestamp: string
    sequence?: number
  },
) {
  return db.prepare(`
    INSERT INTO app_data_rights_request_events (
      id, request_id, sequence, request_version, status_snapshot,
      event_type, visibility, actor_type, actor_id, reason_code,
      user_message, internal_note, safe_summary_json, created_at
    )
    SELECT ?, id,
           ${input.sequence === undefined
             ? `COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = app_data_rights_requests.id), 0) + 1`
             : '?'},
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM app_data_rights_requests
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    generateId('dre'),
    ...(input.sequence === undefined ? [] : [input.sequence]),
    requestVersion,
    input.status,
    input.eventType,
    input.visibility,
    input.actorType,
    input.actorId,
    input.reasonCode,
    input.userMessage,
    input.internalNote,
    JSON.stringify(input.safeSummary),
    input.timestamp,
    requestId,
    requestVersion,
    requestMutationToken,
  )
}

function commandStatement(
  db: D1Database,
  input: {
    actorScope: string
    operation: string
    idempotencyHash: string
    requestHash: string
    requestId: string
    resultVersion: number
    mutationToken: string
    timestamp: string
  },
) {
  return db.prepare(`
    INSERT INTO app_data_rights_commands (
      id, actor_scope, operation, idempotency_key_hash, request_hash,
      result_request_id, result_version, created_at
    )
    SELECT ?, ?, ?, ?, ?, id, version, ?
    FROM app_data_rights_requests
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    generateId('drc'),
    input.actorScope,
    input.operation,
    input.idempotencyHash,
    input.requestHash,
    input.timestamp,
    input.requestId,
    input.resultVersion,
    input.mutationToken,
  )
}

async function requireSecuritySnapshot(db: D1Database, accountId: number): Promise<SecuritySnapshotRow> {
  const row = await db.prepare(`
    SELECT security.account_id, security.account_public_id,
           security.status AS security_status,
           security.restriction_reason_code, security.restricted_until,
           users.status AS user_status, users.password_hash
    FROM app_account_security security
    JOIN users ON users.id = security.account_id
    WHERE security.account_id = ?
  `).bind(accountId).first<SecuritySnapshotRow>()
  if (
    !row
    || row.user_status !== 'active'
    || !['active', 'restricted'].includes(row.security_status)
  ) {
    throw new AppDataRightsError(403, 'ACCOUNT_DATA_RIGHTS_UNAVAILABLE', '账号当前无法创建新的数据权利申请')
  }
  return row
}

export async function requireAppDataRightsRequestRow(
  db: D1Database,
  requestId: string,
): Promise<AppDataRightsRequestRow> {
  return requireRequestRow(db, requestId)
}

async function requireRequestRow(
  db: D1Database,
  requestId: string,
  accountId?: number,
): Promise<AppDataRightsRequestRow> {
  const row = await db.prepare(`${requestSelect()}
    WHERE request.id = ? ${accountId === undefined ? '' : 'AND request.account_id = ?'}
    LIMIT 1
  `).bind(requestId, ...(accountId === undefined ? [] : [accountId])).first<AppDataRightsRequestRow>()
  if (!row) throw new AppDataRightsError(404, 'DATA_RIGHTS_REQUEST_NOT_FOUND', '数据权利申请不存在')
  return row
}

async function findActiveRequest(
  db: D1Database,
  accountId: number,
  type: AppDataRightsRequestType,
): Promise<AppDataRightsRequestRow | null> {
  return db.prepare(`${requestSelect()}
    WHERE request.account_id = ? AND request.request_type = ?
      AND (
        (? = 'export' AND request.status IN ('requested', 'verification_required', 'collecting', 'ready'))
        OR (? = 'deletion' AND request.status IN (
          'requested', 'verification_required', 'scheduled', 'processing', 'failed'
        ))
      )
    ORDER BY request.requested_at DESC, request.id DESC
    LIMIT 1
  `).bind(accountId, type, type, type).first<AppDataRightsRequestRow>()
}

export function appDataRightsRequestSelect() {
  return requestSelect()
}

function requestSelect() {
  return `
    SELECT request.id, request.request_type, request.account_id, request.policy_id,
           request.policy_version_snapshot, request.status, request.status_message_code,
           request.version, request.mutation_token, request.request_hash,
           request.requested_session_id, request.requested_device_id,
           request.account_security_status_before, request.account_restriction_reason_before,
           request.account_restricted_until_before, request.user_status_before,
           request.assigned_to, request.assigned_at, request.deadline_at, request.scheduled_for,
           request.processing_started_at, request.completed_at, request.cancelled_at,
           request.failure_code, request.requested_at, request.updated_at,
           policy.cancellation_enabled,
           policy.production_ready AS policy_production_ready,
           policy.export_processing_enabled AS policy_export_processing_enabled,
           policy.deletion_processing_enabled AS policy_deletion_processing_enabled,
           security.account_public_id,
           users.email AS account_email, users.nickname AS account_nickname,
           security.status AS account_current_status,
           assignee.email AS assignee_email, assignee.nickname AS assignee_nickname
    FROM app_data_rights_requests request
    JOIN app_data_rights_policies policy ON policy.id = request.policy_id
    JOIN users ON users.id = request.account_id
    JOIN app_account_security security ON security.account_id = request.account_id
    LEFT JOIN users assignee ON assignee.id = request.assigned_to
  `
}

async function mapRequestDetail(
  db: D1Database,
  row: AppDataRightsRequestRow,
  statusTokenUsed: boolean,
  now: Date,
): Promise<AppDataRightsRequestDetail> {
  const events = await db.prepare(`
    SELECT sequence, request_version, status_snapshot, event_type, user_message, created_at
    FROM app_data_rights_request_events
    WHERE request_id = ? AND visibility = 'user'
    ORDER BY sequence ASC
  `).bind(row.id).all<EventRow>()
  return {
    ...mapRequestSummary(row, now),
    requiresStatusToken: statusTokenUsed || row.account_current_status === 'deletion_pending',
    timeline: events.results.map(event => ({
      sequence: event.sequence,
      eventType: event.event_type,
      status: event.status_snapshot,
      message: event.user_message ?? STATUS_MESSAGES[event.status_snapshot],
      createdAt: event.created_at,
    })),
  }
}

function mapRequestSummary(row: AppDataRightsRequestRow, now: Date): AppDataRightsRequestSummary {
  return {
    requestId: row.id,
    type: row.request_type,
    status: row.status,
    statusMessage: STATUS_MESSAGES[row.status],
    version: row.version,
    policyVersion: row.policy_version_snapshot,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    scheduledFor: row.scheduled_for,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    failureCode: row.failure_code,
    canCancel: canCancel(row, now),
    requiresStatusToken: row.account_current_status === 'deletion_pending',
  }
}

function canCancel(row: AppDataRightsRequestRow, now: Date) {
  if (row.cancellation_enabled !== 1) return false
  if (row.request_type === 'export') return ['requested', 'collecting'].includes(row.status)
  return row.status === 'scheduled'
    && Boolean(row.scheduled_for)
    && Date.parse(row.scheduled_for!) > now.getTime()
}

function assertRequestCanCancel(row: AppDataRightsRequestRow, now: Date) {
  if (canCancel(row, now)) return
  throw new AppDataRightsError(409, 'REQUEST_NOT_CANCELLABLE', '当前申请阶段不可取消')
}

async function readPolicyRow(db: D1Database, policyId: string) {
  return db.prepare(`
    SELECT id, version_code, state, production_ready, requests_enabled,
           export_requests_enabled, deletion_requests_enabled,
           export_processing_enabled, deletion_processing_enabled, cancellation_enabled,
           retention_decision_status, owner_sla_decision_status, region_decision_status,
           request_sla_hours, deletion_cooling_off_hours,
           status_access_ttl_hours, step_up_ttl_seconds
    FROM app_data_rights_policies WHERE id = ? LIMIT 1
  `).bind(policyId).first<PolicyRow>()
}

async function requirePolicyById(db: D1Database, policyId: string) {
  const row = await readPolicyRow(db, policyId)
  if (!row) throw new AppDataRightsError(503, 'DATA_RIGHTS_POLICY_UNAVAILABLE', '数据权利策略暂时不可用', true)
  return mapPolicy(row)
}

function mapPolicy(row: PolicyRow): AppDataRightsPolicy {
  return {
    id: row.id,
    versionCode: row.version_code,
    state: row.state,
    productionReady: row.production_ready === 1,
    requestsEnabled: row.requests_enabled === 1,
    exportRequestsEnabled: row.export_requests_enabled === 1,
    deletionRequestsEnabled: row.deletion_requests_enabled === 1,
    exportProcessingEnabled: row.export_processing_enabled === 1,
    deletionProcessingEnabled: row.deletion_processing_enabled === 1,
    cancellationEnabled: row.cancellation_enabled === 1,
    retentionDecisionStatus: row.retention_decision_status,
    ownerSlaDecisionStatus: row.owner_sla_decision_status,
    regionDecisionStatus: row.region_decision_status,
    requestSlaHours: row.request_sla_hours,
    deletionCoolingOffHours: row.deletion_cooling_off_hours,
    statusAccessTtlHours: row.status_access_ttl_hours,
    stepUpTtlSeconds: row.step_up_ttl_seconds,
  }
}

function disabledCapabilities(policy: AppDataRightsPolicy | null = null): AppDataRightsCapabilities {
  return {
    overview: false,
    export: false,
    deletion: false,
    exportProcessing: false,
    deletionProcessing: false,
    cancellationEnabled: false,
    policy,
  }
}

async function findCommand(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyHash: string,
) {
  return db.prepare(`
    SELECT request_hash, result_request_id, result_version
    FROM app_data_rights_commands
    WHERE actor_scope = ? AND operation = ? AND idempotency_key_hash = ?
  `).bind(actorScope, operation, idempotencyHash).first<CommandRow>()
}

async function mutationReplay(
  db: D1Database,
  command: CommandRow,
  requestHash: string,
  statusTokenUsed: boolean,
  now: Date,
): Promise<AppDataRightsMutationResult> {
  if (command.request_hash !== requestHash) {
    throw new AppDataRightsError(409, 'IDEMPOTENCY_CONFLICT', '该幂等键已用于不同请求')
  }
  const row = await requireRequestRow(db, command.result_request_id)
  return {
    request: await mapRequestDetail(db, row, statusTokenUsed, now),
    statusAccess: null,
    replayed: true,
    sessionRevoked: row.request_type === 'deletion' && row.status !== 'cancelled',
  }
}

function requireDeletionAcknowledgements(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const result = {
    membershipAndCoins: record.membershipAndCoins === true,
    messagesAndRetention: record.messagesAndRetention === true,
    sessionRevocation: record.sessionRevocation === true,
  }
  if (!Object.values(result).every(Boolean)) {
    throw new AppDataRightsError(422, 'DELETION_ACKNOWLEDGEMENTS_REQUIRED', '请确认会员金币、消息保留和退出登录影响')
  }
  return result
}

function requireStepUpPurpose(value: unknown): AppDataRightsStepUpPurpose {
  const purpose = typeof value === 'string' ? value : ''
  if (![
    'export_request',
    'deletion_request',
    'export_cancel',
    'deletion_cancel',
    'export_download',
  ].includes(purpose)) {
    throw new AppDataRightsError(400, 'STEP_UP_PURPOSE_INVALID', '二次验证用途无效')
  }
  return purpose as AppDataRightsStepUpPurpose
}

function requireRequestType(value: unknown): AppDataRightsRequestType {
  if (value === 'export' || value === 'deletion') return value
  throw new AppDataRightsError(400, 'REQUEST_TYPE_INVALID', '申请类型无效')
}

function requireRequestId(value: unknown) {
  const requestId = typeof value === 'string' ? value.trim() : ''
  if (!REQUEST_ID.test(requestId)) {
    throw new AppDataRightsError(400, 'REQUEST_ID_INVALID', '申请编号无效')
  }
  return requestId
}

function requireIdempotencyKey(value: string | null) {
  const key = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new AppDataRightsError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供有效的 Idempotency-Key')
  }
  return key
}

function requirePositiveInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppDataRightsError(400, 'INVALID_REQUEST', `${field} 必须为正整数`)
  }
  return value
}

function invalidStatusAccess() {
  return new AppDataRightsError(401, 'DATA_RIGHTS_ACCESS_INVALID', '申请状态凭证无效或已过期')
}

function invalidDeletionRecovery() {
  return new AppDataRightsError(401, 'DELETION_RECOVERY_INVALID', '注销申请恢复凭证无效或已过期')
}

function randomOpaqueToken(prefix: 'drup') {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `${prefix}_${base64Url(bytes)}`
}

async function deriveStatusToken(
  secret: string,
  requestId: string,
  accountId: number,
  requestHash: string,
) {
  if (!secret || secret.length < 16) {
    throw new AppDataRightsError(503, 'DATA_RIGHTS_SIGNING_UNAVAILABLE', '数据权利凭证签发暂时不可用', true)
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`data-rights-status:v1:${requestId}:${accountId}:${requestHash}`),
  )
  return `drat_${base64Url(new Uint8Array(signature))}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function encodeCursor(cursor: NonNullable<AppDataRightsListQuery['cursor']>) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  return base64Url(bytes)
}

function decodeCursor(
  value: string,
  accountScope: string,
  type: AppDataRightsRequestType | null,
): NonNullable<AppDataRightsListQuery['cursor']> {
  try {
    if (value.length > 1000) throw new Error('CURSOR_TOO_LONG')
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<NonNullable<AppDataRightsListQuery['cursor']>>
    if (
      parsed.v !== CURSOR_VERSION
      || parsed.accountScope !== accountScope
      || parsed.type !== type
      || typeof parsed.requestedAt !== 'string'
      || Number.isNaN(Date.parse(parsed.requestedAt))
      || typeof parsed.requestId !== 'string'
      || !REQUEST_ID.test(parsed.requestId)
    ) throw new Error('CURSOR_INVALID')
    return parsed as NonNullable<AppDataRightsListQuery['cursor']>
  }
  catch {
    throw new AppDataRightsError(400, 'INVALID_CURSOR', '分页游标无效')
  }
}

function normalizeTraceId(value: string) {
  const trace = value.trim()
  return trace.length >= 8 && trace.length <= 128 ? trace : crypto.randomUUID()
}

export function isAppDataRightsStatus(value: string): value is AppDataRightsRequestStatus {
  return REQUEST_STATUSES.has(value as AppDataRightsRequestStatus)
}
