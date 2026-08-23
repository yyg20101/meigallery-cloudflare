import { generateId } from '../utils/db'
import type { Bindings } from '../index'
import {
  APP_DATA_RIGHTS_POLICY_ID,
  AppDataRightsError,
  appDataRightsRequestSelect,
  getAppDataRightsRuntimeConfig,
  isAppDataRightsStatus,
  requireAppDataRightsRequestRow,
  type AppDataRightsRequestRow,
  type AppDataRightsRuntimeConfig,
} from './app-data-rights'
import {
  dispatchAppDataRightsExport,
  getAdminAppDataRightsExportState,
  prepareAppDataRightsExportStart,
  resolveAppDataRightsExportExecutorReadiness,
} from './app-data-rights-exports'
import {
  dispatchAppDataRightsDeletion,
  getAdminAppDataRightsDeletionState,
  prepareAppDataRightsDeletionStart,
  resolveAppDataRightsDeletionExecutorReadiness,
} from './app-data-rights-deletions'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const REQUEST_ID = /^drr_[A-Za-z0-9_-]{1,92}$/u
const REASON_CODE = /^[a-z0-9_]{3,80}$/u
const EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,191}$/u
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 40

const ADMIN_ACTIONS = ['begin_processing', 'fail', 'retry', 'cancel_verified'] as const
type AdminDataRightsAction = typeof ADMIN_ACTIONS[number]

type AdminDataRightsEnvironment = Pick<
  Bindings,
  | 'DB'
  | 'R2'
  | 'DATA_RIGHTS_EXPORT_QUEUE'
  | 'DATA_RIGHTS_DELETION_QUEUE'
  | 'DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT'
  | 'DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS'
  | 'APP_REALTIME_HUB'
  | 'SESSION_SECRET'
>

export type AdminDataRightsActor = {
  adminId: number
  role: string
  requestId: string
  traceId: string | null
}

export type AdminDataRightsListInput = {
  type?: unknown
  status?: unknown
  assignment?: unknown
  limit?: unknown
}

export type AdminDataRightsClaimInput = {
  expectedVersion?: unknown
}

export type AdminDataRightsActionInput = {
  action?: unknown
  expectedVersion?: unknown
  reasonCode?: unknown
  userMessage?: unknown
  internalNote?: unknown
  evidenceReference?: unknown
  failureCode?: unknown
}

export class AdminAppDataRightsError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

type PolicyOverviewRow = {
  id: string
  version_code: string
  state: string
  production_ready: number
  requests_enabled: number
  export_requests_enabled: number
  deletion_requests_enabled: number
  export_processing_enabled: number
  deletion_processing_enabled: number
  cancellation_enabled: number
  retention_decision_status: string
  owner_sla_decision_status: string
  region_decision_status: string
  retention_policy_reference: string | null
  owner_reference: string | null
  region_policy_reference: string | null
  request_sla_hours: number | null
  deletion_cooling_off_hours: number | null
  status_access_ttl_hours: number
  step_up_ttl_seconds: number
}

type AdminTimelineRow = {
  id: string
  sequence: number
  request_version: number
  status_snapshot: string
  event_type: string
  visibility: 'user' | 'internal'
  actor_type: 'account' | 'admin' | 'system'
  actor_id: number | null
  actor_email: string | null
  actor_nickname: string | null
  actor_role: string | null
  reason_code: string
  user_message: string | null
  internal_note: string | null
  safe_summary_json: string
  created_at: string
}

type CommandRow = {
  request_hash: string
  result_request_id: string
  result_version: number
}

export async function getAdminAppDataRightsOverview(
  db: D1Database,
  config: AppDataRightsRuntimeConfig,
  now = new Date(),
) {
  const policyId = config.policyId || APP_DATA_RIGHTS_POLICY_ID
  const [policy, counts, recent] = await Promise.all([
    readPolicyOverview(db, policyId),
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('completed', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN request_type = 'export' AND status NOT IN ('completed', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS export_open_count,
        SUM(CASE WHEN request_type = 'deletion' AND status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) AS deletion_open_count,
        SUM(CASE WHEN assigned_to IS NULL AND status NOT IN ('completed', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS unassigned_count,
        SUM(CASE WHEN deadline_at IS NOT NULL AND datetime(deadline_at) < datetime(?)
          AND status NOT IN ('completed', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS overdue_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
      FROM app_data_rights_requests
    `).bind(now.toISOString()).first<{
      total: number
      open_count: number | null
      export_open_count: number | null
      deletion_open_count: number | null
      unassigned_count: number | null
      overdue_count: number | null
      failed_count: number | null
    }>(),
    db.prepare(`${appDataRightsRequestSelect()}
      ORDER BY request.updated_at DESC, request.id DESC
      LIMIT 8
    `).all<AppDataRightsRequestRow>(),
  ])
  return {
    runtime: {
      requested: config.requested,
      adminRequested: config.adminRequested,
      configuredPolicyId: config.policyId || null,
      requireProductionReady: config.requireProductionReady,
    },
    policy: policy ? mapPolicyOverview(policy) : null,
    metrics: {
      total: Number(counts?.total ?? 0),
      open: Number(counts?.open_count ?? 0),
      exportOpen: Number(counts?.export_open_count ?? 0),
      deletionOpen: Number(counts?.deletion_open_count ?? 0),
      unassigned: Number(counts?.unassigned_count ?? 0),
      overdue: Number(counts?.overdue_count ?? 0),
      failed: Number(counts?.failed_count ?? 0),
    },
    recent: recent.results.map(row => mapAdminRequest(row, now)),
  }
}

export async function listAdminAppDataRightsRequests(
  db: D1Database,
  actor: AdminDataRightsActor,
  input: AdminDataRightsListInput,
  now = new Date(),
) {
  const conditions: string[] = []
  const values: unknown[] = []
  const type = optionalRequestType(input.type)
  const status = optionalStatus(input.status)
  const assignment = optionalAssignment(input.assignment)
  if (type) {
    conditions.push('request.request_type = ?')
    values.push(type)
  }
  if (status) {
    conditions.push('request.status = ?')
    values.push(status)
  }
  if (assignment === 'mine') {
    conditions.push('request.assigned_to = ?')
    values.push(actor.adminId)
  }
  else if (assignment === 'unassigned') {
    conditions.push('request.assigned_to IS NULL')
  }
  const limit = pageLimit(input.limit)
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await db.prepare(`${appDataRightsRequestSelect()}
    ${where}
    ORDER BY
      CASE WHEN request.deadline_at IS NOT NULL AND datetime(request.deadline_at) < datetime(?)
        AND request.status NOT IN ('completed', 'cancelled', 'expired') THEN 0 ELSE 1 END,
      CASE request.status
        WHEN 'failed' THEN 0
        WHEN 'processing' THEN 1
        WHEN 'collecting' THEN 1
        WHEN 'scheduled' THEN 2
        WHEN 'requested' THEN 3
        ELSE 4
      END,
      request.requested_at ASC,
      request.id ASC
    LIMIT ?
  `).bind(...values, now.toISOString(), limit).all<AppDataRightsRequestRow>()
  return {
    items: rows.results.map(row => mapAdminRequest(row, now)),
    filters: { type, status, assignment },
    limit,
  }
}

export async function getAdminAppDataRightsRequest(
  env: AdminDataRightsEnvironment,
  requestIdValue: unknown,
  actor?: AdminDataRightsActor,
  now = new Date(),
) {
  const db = env.DB
  const requestId = requireRequestId(requestIdValue)
  const request = await requireAdminRequest(db, requestId)
  const [events, exportArtifact, exportExecutor, deletionExecution, deletionExecutor] = await Promise.all([
    db.prepare(`
      SELECT event.id, event.sequence, event.request_version, event.status_snapshot,
             event.event_type, event.visibility, event.actor_type, event.actor_id,
             actor.email AS actor_email, actor.nickname AS actor_nickname, actor.role AS actor_role,
             event.reason_code, event.user_message, event.internal_note,
             event.safe_summary_json, event.created_at
      FROM app_data_rights_request_events event
      LEFT JOIN users actor ON actor.id = event.actor_id
      WHERE event.request_id = ?
      ORDER BY event.sequence ASC
    `).bind(requestId).all<AdminTimelineRow>(),
    request.request_type === 'export'
      ? getAdminAppDataRightsExportState(db, requestId)
      : Promise.resolve(null),
    request.request_type === 'export'
      ? resolveAppDataRightsExportExecutorReadiness(env, request.policy_id)
      : Promise.resolve(null),
    request.request_type === 'deletion'
      ? getAdminAppDataRightsDeletionState(db, requestId)
      : Promise.resolve(null),
    request.request_type === 'deletion'
      ? resolveAppDataRightsDeletionExecutorReadiness(env, request.policy_id)
      : Promise.resolve(null),
  ])
  const mapped = mapAdminRequest(request, now)
  if (exportExecutor && !exportExecutor.ready) {
    mapped.availableActions = mapped.availableActions.filter(
      action => !['begin_processing', 'retry'].includes(action),
    )
  }
  if (deletionExecutor && !deletionExecutor.ready) {
    mapped.availableActions = mapped.availableActions.filter(
      action => !['begin_processing', 'retry'].includes(action),
    )
  }
  return {
    ...mapped,
    timeline: events.results.map(event => ({
      eventId: event.id,
      sequence: event.sequence,
      requestVersion: event.request_version,
      status: event.status_snapshot,
      eventType: event.event_type,
      visibility: event.visibility,
      actor: event.actor_type === 'system'
        ? { type: 'system', id: null, label: '系统' }
        : {
            type: event.actor_type,
            id: event.actor_id,
            label: event.actor_nickname || maskEmail(event.actor_email || '') || `${event.actor_type}#${event.actor_id}`,
            role: event.actor_role,
          },
      reasonCode: event.reason_code,
      userMessage: event.user_message,
      internalNote: event.internal_note,
      safeSummary: safeJsonObject(event.safe_summary_json),
      createdAt: event.created_at,
    })),
    exportArtifact,
    exportExecutor,
    deletionExecution,
    deletionExecutor,
    permissions: {
      canClaim: actor?.role === 'owner' && request.assigned_to === null && !isTerminal(request.status),
      canAct: actor?.role === 'owner' && request.assigned_to === actor.adminId && !isTerminal(request.status),
    },
  }
}

export async function claimAdminAppDataRightsRequest(
  env: AdminDataRightsEnvironment,
  config: AppDataRightsRuntimeConfig,
  requestIdValue: unknown,
  actor: AdminDataRightsActor,
  idempotencyKeyValue: string | null,
  input: AdminDataRightsClaimInput,
  now = new Date(),
) {
  const db = env.DB
  requireAdminControlEnabled(config, actor)
  const requestId = requireRequestId(requestIdValue)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const idempotencyHash = await sha256Hex(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({ requestId, expectedVersion }))
  const operation = 'admin_claim'
  const actorScope = `admin:${actor.adminId}`
  const replay = await findCommand(db, actorScope, operation, idempotencyHash)
  if (replay) return adminReplay(env, replay, requestHash, actor, now)

  const current = await requireAdminRequest(db, requestId)
  if (current.version !== expectedVersion) throw versionConflict()
  if (isTerminal(current.status)) {
    throw new AdminAppDataRightsError(409, 'REQUEST_TERMINAL', '已结束申请不能领取')
  }
  if (current.assigned_to !== null) {
    throw new AdminAppDataRightsError(409, 'REQUEST_ALREADY_ASSIGNED', '申请已由其他负责人领取')
  }
  const nextVersion = current.version + 1
  const mutationToken = crypto.randomUUID()
  const timestamp = now.toISOString()
  const auditId = generateId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_data_rights_requests
      SET assigned_to = ?, assigned_at = ?, version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_to IS NULL
        AND status NOT IN ('completed', 'cancelled', 'expired')
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.role = 'owner' AND actor.status = 'active'
        )
    `).bind(
      actor.adminId,
      timestamp,
      nextVersion,
      mutationToken,
      timestamp,
      requestId,
      current.version,
      current.mutation_token,
      actor.adminId,
    ),
    adminEventStatement(db, requestId, nextVersion, mutationToken, {
      status: current.status,
      eventType: 'assigned',
      visibility: 'internal',
      actor,
      reasonCode: 'owner_claimed',
      userMessage: null,
      internalNote: '申请已由当前 Owner 领取。',
      safeSummary: { assigned: true },
      timestamp,
    }),
    adminCommandStatement(db, requestId, nextVersion, mutationToken, {
      actorScope,
      operation,
      idempotencyHash,
      requestHash,
      timestamp,
    }),
    adminAuditStatement(db, requestId, nextVersion, mutationToken, auditId, actor,
      'app.data_rights.request.claim',
      { assigned: false, version: current.version },
      { assigned: true, version: nextVersion },
      timestamp),
    auditContextStatement(db, auditId, actor, 'owner_claimed', requestId, current.policy_version_snapshot, idempotencyHash, timestamp),
  ])
  const stored = await findCommand(db, actorScope, operation, idempotencyHash)
  if (!stored) throw new AdminAppDataRightsError(409, 'REQUEST_CLAIM_CONFLICT', '申请已被领取，请刷新后重试')
  return { request: await getAdminAppDataRightsRequest(env, requestId, actor, now), replayed: false }
}

export async function actOnAdminAppDataRightsRequest(
  env: AdminDataRightsEnvironment,
  config: AppDataRightsRuntimeConfig,
  requestIdValue: unknown,
  actor: AdminDataRightsActor,
  idempotencyKeyValue: string | null,
  input: AdminDataRightsActionInput,
  now = new Date(),
) {
  const db = env.DB
  requireAdminControlEnabled(config, actor)
  const requestId = requireRequestId(requestIdValue)
  const action = requireAction(input.action)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const reasonCode = requireReasonCode(input.reasonCode)
  const userMessage = requiredText(input.userMessage, 'userMessage', 2, 300)
  const internalNote = optionalText(input.internalNote, 1000)
  const evidenceReference = optionalEvidenceReference(input.evidenceReference)
  const failureCode = action === 'fail' ? requireReasonCode(input.failureCode) : null
  if (action === 'cancel_verified' && !evidenceReference) {
    throw new AdminAppDataRightsError(422, 'CANCEL_EVIDENCE_REQUIRED', '代用户取消必须提供已核验请求的证据引用')
  }
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const idempotencyHash = await sha256Hex(idempotencyKey)
  const requestHash = await sha256Hex(JSON.stringify({
    requestId, action, expectedVersion, reasonCode, userMessage,
    internalNote, evidenceReference, failureCode,
  }))
  const operation = `admin_${action}`
  const actorScope = `admin:${actor.adminId}`
  const replay = await findCommand(db, actorScope, operation, idempotencyHash)
  if (replay) {
    const result = await adminReplay(env, replay, requestHash, actor, now)
    if (
      action === 'begin_processing'
      && result.request.type === 'export'
      && result.request.status === 'collecting'
    ) {
      await dispatchAppDataRightsExport(env, requestId)
    }
    if (
      action === 'begin_processing'
      || (action === 'retry' && result.request.type === 'deletion')
    ) {
      if (result.request.type === 'deletion' && result.request.status === 'processing') {
        await dispatchAppDataRightsDeletion(env, requestId)
      }
    }
    return result
  }

  const current = await requireAdminRequest(db, requestId)
  if (current.version !== expectedVersion) throw versionConflict()
  if (current.assigned_to !== actor.adminId) {
    throw new AdminAppDataRightsError(403, 'REQUEST_NOT_ASSIGNED', '请先领取申请后再执行处置')
  }
  const policy = await readPolicyOverview(db, current.policy_id)
  if (!policy) throw new AdminAppDataRightsError(503, 'DATA_RIGHTS_POLICY_UNAVAILABLE', '申请策略暂时不可用', true)
  const transition = resolveActionTransition(current, policy, action, now)
  const nextVersion = current.version + 1
  const mutationToken = crypto.randomUUID()
  const timestamp = now.toISOString()
  const auditId = generateId('audit')
  const noteHash = internalNote ? await sha256Hex(internalNote) : null
  const messageHash = await sha256Hex(userMessage)
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE app_data_rights_requests
      SET status = ?, status_message_code = ?, version = ?, mutation_token = ?,
          processing_started_at = CASE WHEN ? IN ('collecting', 'processing') THEN ? ELSE processing_started_at END,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
          cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
          failure_code = ?, updated_at = ?
      WHERE id = ? AND version = ? AND mutation_token = ? AND status = ?
        AND assigned_to = ?
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.role = 'owner' AND actor.status = 'active'
        )
    `).bind(
      transition.status,
      transition.statusMessageCode,
      nextVersion,
      mutationToken,
      transition.status,
      timestamp,
      transition.status,
      timestamp,
      transition.status,
      timestamp,
      failureCode,
      timestamp,
      requestId,
      current.version,
      current.mutation_token,
      current.status,
      actor.adminId,
      actor.adminId,
    ),
    adminEventStatement(db, requestId, nextVersion, mutationToken, {
      status: transition.status,
      eventType: transition.eventType,
      visibility: 'user',
      actor,
      reasonCode,
      userMessage,
      internalNote: null,
      safeSummary: {
        previousStatus: current.status,
        messageSha256: messageHash,
        failureCode,
        hasEvidence: Boolean(evidenceReference),
      },
      timestamp,
    }),
    ...(internalNote ? [adminEventStatement(db, requestId, nextVersion, mutationToken, {
      status: transition.status,
      eventType: 'internal_note_added',
      visibility: 'internal',
      actor,
      reasonCode,
      userMessage: null,
      internalNote,
      safeSummary: { noteSha256: noteHash, noteLength: internalNote.length },
      timestamp,
    })] : []),
    adminCommandStatement(db, requestId, nextVersion, mutationToken, {
      actorScope,
      operation,
      idempotencyHash,
      requestHash,
      timestamp,
    }),
    adminAuditStatement(db, requestId, nextVersion, mutationToken, auditId, actor,
      `app.data_rights.request.${action}`,
      { status: current.status, version: current.version },
      {
        status: transition.status,
        version: nextVersion,
        reasonCode,
        failureCode,
        messageSha256: messageHash,
        noteSha256: noteHash,
        hasEvidence: Boolean(evidenceReference),
      },
      timestamp),
    auditContextStatement(db, auditId, actor, reasonCode, requestId, current.policy_version_snapshot, idempotencyHash, timestamp),
  ]
  let exportArtifactId: string | null = null
  let deletionExecutionId: string | null = null
  if (
    current.request_type === 'export'
    && action === 'begin_processing'
    && transition.status === 'collecting'
  ) {
    const preparedExport = await prepareAppDataRightsExportStart(
      env,
      current,
      nextVersion,
      mutationToken,
      timestamp,
    )
    exportArtifactId = preparedExport.artifactId
    statements.push(...preparedExport.statements)
  }
  if (
    current.request_type === 'deletion'
    && ['begin_processing', 'retry'].includes(action)
    && transition.status === 'processing'
  ) {
    const preparedDeletion = await prepareAppDataRightsDeletionStart(
      env,
      current,
      nextVersion,
      mutationToken,
      timestamp,
    )
    deletionExecutionId = preparedDeletion.executionId
    statements.push(...preparedDeletion.statements)
  }
  if (transition.status === 'cancelled') {
    statements.push(
      db.prepare(`
        UPDATE app_data_rights_status_tokens
        SET revoked_at = ?
        WHERE request_id = ? AND account_id = ? AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM app_data_rights_requests request
            WHERE request.id = ? AND request.version = ? AND request.mutation_token = ?
              AND request.status = 'cancelled'
          )
      `).bind(timestamp, requestId, current.account_id, requestId, nextVersion, mutationToken),
    )
    if (current.request_type === 'deletion') {
      statements.push(...restoreCancelledDeletionStatements(
        db,
        current,
        requestId,
        nextVersion,
        mutationToken,
        timestamp,
      ))
    }
  }
  await db.batch(statements)
  const stored = await findCommand(db, actorScope, operation, idempotencyHash)
  if (!stored) throw new AdminAppDataRightsError(409, 'REQUEST_ACTION_CONFLICT', '申请状态已变化，请刷新后重试')
  if (exportArtifactId) await dispatchAppDataRightsExport(env, requestId)
  if (deletionExecutionId) await dispatchAppDataRightsDeletion(env, requestId)
  return { request: await getAdminAppDataRightsRequest(env, requestId, actor, now), replayed: false }
}

function resolveActionTransition(
  current: AppDataRightsRequestRow,
  policy: PolicyOverviewRow,
  action: AdminDataRightsAction,
  now: Date,
) {
  if (action === 'begin_processing') {
    if (current.request_type === 'export') {
      if (current.status !== 'requested') throw invalidTransition()
      if (policy.export_processing_enabled !== 1 || policy.production_ready !== 1) {
        throw new AdminAppDataRightsError(503, 'EXPORT_PROCESSING_NOT_READY', '导出生成器和保留策略尚未通过生产门禁', true)
      }
      return { status: 'collecting' as const, statusMessageCode: 'export_collecting', eventType: 'processing_started' }
    }
    if (current.status !== 'scheduled') throw invalidTransition()
    if (policy.deletion_processing_enabled !== 1 || policy.production_ready !== 1) {
      throw new AdminAppDataRightsError(503, 'DELETION_PROCESSING_NOT_READY', '不可逆注销执行策略尚未通过生产门禁', true)
    }
    if (!current.scheduled_for || Date.parse(current.scheduled_for) > now.getTime()) {
      throw new AdminAppDataRightsError(409, 'DELETION_COOLING_OFF_ACTIVE', '注销仍在可取消等待阶段')
    }
    return { status: 'processing' as const, statusMessageCode: 'deletion_processing', eventType: 'processing_started' }
  }
  if (action === 'fail') {
    const allowed = current.request_type === 'export'
      ? ['requested', 'collecting'].includes(current.status)
      : current.status === 'scheduled'
    if (!allowed) throw invalidTransition()
    return { status: 'failed' as const, statusMessageCode: 'processing_failed', eventType: 'processing_failed' }
  }
  if (action === 'retry') {
    if (current.status !== 'failed') throw invalidTransition()
    if (current.request_type === 'export') {
      if (policy.export_processing_enabled !== 1 || policy.production_ready !== 1) {
        throw new AdminAppDataRightsError(503, 'EXPORT_PROCESSING_NOT_READY', '导出生成器尚未通过生产门禁', true)
      }
      return { status: 'requested' as const, statusMessageCode: 'export_retry_requested', eventType: 'retry_scheduled' }
    }
    if (policy.deletion_processing_enabled !== 1 || policy.production_ready !== 1) {
      throw new AdminAppDataRightsError(503, 'DELETION_PROCESSING_NOT_READY', '注销执行器尚未通过生产门禁', true)
    }
    if (!current.scheduled_for || Date.parse(current.scheduled_for) > now.getTime()) {
      throw new AdminAppDataRightsError(409, 'DELETION_COOLING_OFF_ACTIVE', '注销仍在原可取消等待期内')
    }
    return { status: 'processing' as const, statusMessageCode: 'deletion_processing', eventType: 'retry_scheduled' }
  }
  const cancellable = current.request_type === 'export'
    ? ['requested', 'collecting'].includes(current.status)
    : current.status === 'scheduled' && Boolean(current.scheduled_for) && Date.parse(current.scheduled_for!) > now.getTime()
  if (!cancellable || policy.cancellation_enabled !== 1) throw invalidTransition()
  return { status: 'cancelled' as const, statusMessageCode: 'request_cancelled', eventType: 'cancelled' }
}

function restoreCancelledDeletionStatements(
  db: D1Database,
  current: AppDataRightsRequestRow,
  requestId: string,
  version: number,
  mutationToken: string,
  timestamp: string,
) {
  return [
    db.prepare(`
      UPDATE users SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'deletion_pending'
        AND EXISTS (
          SELECT 1 FROM app_data_rights_requests request
          WHERE request.id = ? AND request.version = ? AND request.mutation_token = ?
            AND request.status = 'cancelled'
        )
    `).bind(current.user_status_before, timestamp, current.account_id, requestId, version, mutationToken),
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
      current.account_id,
      requestId,
      version,
      mutationToken,
    ),
    db.prepare(`
      INSERT INTO app_account_security_events (
        id, account_id, device_id, session_id, event_type, reason_code, request_id, created_at
      )
      SELECT ?, account_id, NULL, NULL, 'account_deletion_cancelled',
             'verified_support_request', ?, ?
      FROM app_data_rights_requests
      WHERE id = ? AND version = ? AND mutation_token = ? AND status = 'cancelled'
    `).bind(generateId('ase'), requestId, timestamp, requestId, version, mutationToken),
  ]
}

function mapAdminRequest(row: AppDataRightsRequestRow, now: Date) {
  const overdue = Boolean(
    row.deadline_at
    && Date.parse(row.deadline_at) < now.getTime()
    && !isTerminal(row.status),
  )
  return {
    requestId: row.id,
    type: row.request_type,
    status: row.status,
    statusMessageCode: row.status_message_code,
    version: row.version,
    account: {
      accountId: row.account_public_id,
      emailMasked: maskEmail(row.account_email),
      nickname: row.account_nickname,
      status: row.account_current_status,
    },
    policy: {
      policyId: row.policy_id,
      version: row.policy_version_snapshot,
      cancellationEnabled: row.cancellation_enabled === 1,
    },
    assignee: row.assigned_to === null
      ? null
      : {
          id: row.assigned_to,
          label: row.assignee_nickname || maskEmail(row.assignee_email || '') || `管理员#${row.assigned_to}`,
        },
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    scheduledFor: row.scheduled_for,
    processingStartedAt: row.processing_started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    failureCode: row.failure_code,
    overdue,
    availableActions: availableActions(row, now),
  }
}

function availableActions(row: AppDataRightsRequestRow, now: Date): AdminDataRightsAction[] {
  if (isTerminal(row.status)) return []
  const actions: AdminDataRightsAction[] = []
  if (row.request_type === 'export') {
    if (row.status === 'requested') {
      if (row.policy_production_ready === 1 && row.policy_export_processing_enabled === 1) {
        actions.push('begin_processing')
      }
      actions.push('fail', 'cancel_verified')
    }
    else if (row.status === 'collecting') actions.push('fail', 'cancel_verified')
    else if (
      row.status === 'failed'
      && row.policy_production_ready === 1
      && row.policy_export_processing_enabled === 1
    ) actions.push('retry')
  }
  else {
    if (row.status === 'scheduled') {
      const processingWindowReached = Boolean(
        row.scheduled_for && Date.parse(row.scheduled_for) <= now.getTime(),
      )
      if (processingWindowReached) {
        if (row.policy_production_ready === 1 && row.policy_deletion_processing_enabled === 1) {
          actions.push('begin_processing')
        }
      }
      else actions.push('cancel_verified')
      actions.push('fail')
    }
    // 不可逆处理开始后仅由执行器写失败或完成，后台不能与正在运行的检查点竞争。
    else if (row.status === 'processing') return []
    else if (
      row.status === 'failed'
      && row.policy_production_ready === 1
      && row.policy_deletion_processing_enabled === 1
    ) actions.push('retry')
  }
  return actions
}

function mapPolicyOverview(row: PolicyOverviewRow) {
  return {
    policyId: row.id,
    version: row.version_code,
    state: row.state,
    productionReady: row.production_ready === 1,
    capabilities: {
      requests: row.requests_enabled === 1,
      exportRequests: row.export_requests_enabled === 1,
      deletionRequests: row.deletion_requests_enabled === 1,
      exportProcessing: row.export_processing_enabled === 1,
      deletionProcessing: row.deletion_processing_enabled === 1,
      cancellation: row.cancellation_enabled === 1,
    },
    governance: {
      retention: row.retention_decision_status,
      ownerAndSla: row.owner_sla_decision_status,
      region: row.region_decision_status,
      retentionReference: row.retention_policy_reference,
      ownerReference: row.owner_reference,
      regionReference: row.region_policy_reference,
    },
    timing: {
      requestSlaHours: row.request_sla_hours,
      deletionCoolingOffHours: row.deletion_cooling_off_hours,
      statusAccessTtlHours: row.status_access_ttl_hours,
      stepUpTtlSeconds: row.step_up_ttl_seconds,
    },
  }
}

async function readPolicyOverview(db: D1Database, policyId: string) {
  return db.prepare(`
    SELECT id, version_code, state, production_ready, requests_enabled,
           export_requests_enabled, deletion_requests_enabled,
           export_processing_enabled, deletion_processing_enabled, cancellation_enabled,
           retention_decision_status, owner_sla_decision_status, region_decision_status,
           retention_policy_reference, owner_reference, region_policy_reference,
           request_sla_hours, deletion_cooling_off_hours,
           status_access_ttl_hours, step_up_ttl_seconds
    FROM app_data_rights_policies WHERE id = ? LIMIT 1
  `).bind(policyId).first<PolicyOverviewRow>()
}

async function requireAdminRequest(db: D1Database, requestId: string) {
  try {
    return await requireAppDataRightsRequestRow(db, requestId)
  }
  catch (error) {
    if (error instanceof AppDataRightsError && error.status === 404) {
      throw new AdminAppDataRightsError(404, error.code, error.message)
    }
    throw error
  }
}

function adminEventStatement(
  db: D1Database,
  requestId: string,
  version: number,
  mutationToken: string,
  input: {
    status: string
    eventType: string
    visibility: 'user' | 'internal'
    actor: AdminDataRightsActor
    reasonCode: string
    userMessage: string | null
    internalNote: string | null
    safeSummary: Record<string, unknown>
    timestamp: string
  },
) {
  return db.prepare(`
    INSERT INTO app_data_rights_request_events (
      id, request_id, sequence, request_version, status_snapshot,
      event_type, visibility, actor_type, actor_id, reason_code,
      user_message, internal_note, safe_summary_json, created_at
    )
    SELECT ?, id,
           COALESCE((SELECT MAX(sequence) FROM app_data_rights_request_events WHERE request_id = app_data_rights_requests.id), 0) + 1,
           version, ?, ?, 'admin', ?, ?, ?, ?, ?, ?
    FROM app_data_rights_requests
    WHERE id = ? AND version = ? AND mutation_token = ? AND status = ?
  `).bind(
    generateId('dre'),
    input.status,
    input.eventType,
    input.visibility,
    input.actor.adminId,
    input.reasonCode,
    input.userMessage,
    input.internalNote,
    JSON.stringify(input.safeSummary),
    input.timestamp,
    requestId,
    version,
    mutationToken,
    input.status,
  )
}

function adminCommandStatement(
  db: D1Database,
  requestId: string,
  version: number,
  mutationToken: string,
  input: {
    actorScope: string
    operation: string
    idempotencyHash: string
    requestHash: string
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
    requestId,
    version,
    mutationToken,
  )
}

function adminAuditStatement(
  db: D1Database,
  requestId: string,
  version: number,
  mutationToken: string,
  auditId: string,
  actor: AdminDataRightsActor,
  action: string,
  before: unknown,
  after: unknown,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_data_rights_request', id, ?, ?, ?
    FROM app_data_rights_requests
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    auditId,
    actor.adminId,
    action,
    JSON.stringify(before),
    JSON.stringify(after),
    timestamp,
    requestId,
    version,
    mutationToken,
  )
}

function auditContextStatement(
  db: D1Database,
  auditId: string,
  actor: AdminDataRightsActor,
  reasonCode: string,
  businessReference: string,
  policyVersion: string,
  idempotencyHash: string,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO app_audit_event_contexts (
      audit_event_id, request_id, trace_id, idempotency_key_hash, reason_code,
      business_reference, policy_version, capability, scope_summary, result, created_at
    )
    SELECT id, ?, ?, ?, ?, ?, ?, 'data_rights_control_plane',
           '单个数据权利申请，不含导出内容或敏感正文', 'succeeded', ?
    FROM admin_audit_logs WHERE id = ?
  `).bind(
    actor.requestId,
    actor.traceId,
    idempotencyHash,
    reasonCode,
    businessReference,
    policyVersion,
    timestamp,
    auditId,
  )
}

async function findCommand(db: D1Database, actorScope: string, operation: string, idempotencyHash: string) {
  return db.prepare(`
    SELECT request_hash, result_request_id, result_version
    FROM app_data_rights_commands
    WHERE actor_scope = ? AND operation = ? AND idempotency_key_hash = ?
  `).bind(actorScope, operation, idempotencyHash).first<CommandRow>()
}

async function adminReplay(
  env: AdminDataRightsEnvironment,
  command: CommandRow,
  requestHash: string,
  actor: AdminDataRightsActor,
  now: Date,
) {
  if (command.request_hash !== requestHash) {
    throw new AdminAppDataRightsError(409, 'IDEMPOTENCY_CONFLICT', '该幂等键已用于不同请求')
  }
  return {
    request: await getAdminAppDataRightsRequest(env, command.result_request_id, actor, now),
    replayed: true,
  }
}

function requireAdminControlEnabled(config: AppDataRightsRuntimeConfig, actor: AdminDataRightsActor) {
  if (actor.role !== 'owner') {
    throw new AdminAppDataRightsError(403, 'OWNER_REQUIRED', '数据权利处置当前仅允许 Owner 操作')
  }
  if (!config.adminRequested) {
    throw new AdminAppDataRightsError(403, 'FEATURE_DISABLED', '数据权利后台处置当前未开放')
  }
}

function optionalRequestType(value: unknown) {
  if (value === undefined || value === null || value === '' || value === 'all') return null
  if (value === 'export' || value === 'deletion') return value
  throw new AdminAppDataRightsError(400, 'REQUEST_TYPE_INVALID', '申请类型无效')
}

function optionalStatus(value: unknown) {
  if (value === undefined || value === null || value === '' || value === 'all') return null
  if (typeof value !== 'string' || !isAppDataRightsStatus(value)) {
    throw new AdminAppDataRightsError(400, 'REQUEST_STATUS_INVALID', '申请状态无效')
  }
  return value
}

function optionalAssignment(value: unknown) {
  if (value === undefined || value === null || value === '' || value === 'all') return 'all' as const
  if (value === 'mine' || value === 'unassigned') return value
  throw new AdminAppDataRightsError(400, 'ASSIGNMENT_FILTER_INVALID', '负责人筛选无效')
}

function requireAction(value: unknown): AdminDataRightsAction {
  if (typeof value === 'string' && ADMIN_ACTIONS.includes(value as AdminDataRightsAction)) {
    return value as AdminDataRightsAction
  }
  throw new AdminAppDataRightsError(400, 'REQUEST_ACTION_INVALID', '处置动作无效')
}

function requireRequestId(value: unknown) {
  const requestId = typeof value === 'string' ? value.trim() : ''
  if (!REQUEST_ID.test(requestId)) throw new AdminAppDataRightsError(400, 'REQUEST_ID_INVALID', '申请编号无效')
  return requestId
}

function requireIdempotencyKey(value: string | null) {
  const key = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new AdminAppDataRightsError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供有效的 Idempotency-Key')
  }
  return key
}

function positiveInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AdminAppDataRightsError(400, 'INVALID_REQUEST', `${field} 必须为正整数`)
  }
  return value
}

function requireReasonCode(value: unknown) {
  const code = typeof value === 'string' ? value.trim() : ''
  if (!REASON_CODE.test(code)) throw new AdminAppDataRightsError(400, 'REASON_CODE_INVALID', '原因代码无效')
  return code
}

function requiredText(value: unknown, field: string, min: number, max: number) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (text.length < min || text.length > max) {
    throw new AdminAppDataRightsError(400, 'INVALID_REQUEST', `${field} 长度需为 ${min}–${max} 个字符`)
  }
  return text
}

function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, 'internalNote', 2, max)
}

function optionalEvidenceReference(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const reference = typeof value === 'string' ? value.trim() : ''
  if (!EVIDENCE_REFERENCE.test(reference)) {
    throw new AdminAppDataRightsError(400, 'EVIDENCE_REFERENCE_INVALID', '证据引用格式无效')
  }
  return reference
}

function pageLimit(value: unknown) {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
}

function isTerminal(status: string) {
  return ['completed', 'cancelled', 'expired'].includes(status)
}

function versionConflict() {
  return new AdminAppDataRightsError(409, 'VERSION_CONFLICT', '申请版本已变化，请刷新后重试')
}

function invalidTransition() {
  return new AdminAppDataRightsError(409, 'REQUEST_TRANSITION_INVALID', '当前申请状态不允许执行该动作')
}

function maskEmail(value: string) {
  const [local = '', domain = ''] = value.split('@')
  if (!domain) return ''
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  }
  catch {
    return {}
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function adminDataRightsConfig(env: Parameters<typeof getAppDataRightsRuntimeConfig>[0]) {
  return getAppDataRightsRuntimeConfig(env)
}
