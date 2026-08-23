import type { Bindings } from '../index'
import { generateId } from '../utils/db'
import { verifyPassword } from '../utils/password'
import {
  AdminAppAuditError,
  prepareAdminAppAuditQuery,
  redactAdminAppAuditPayload,
  safeAdminAppAuditContextValue,
  type ActorRow,
  type AdminAppAuditListInput,
  type AdminAppAuditPreparedQuery,
  type AdminAppAuditPurpose,
  type AdminAppAuditRequestContext,
  type NormalizedAuditQuery,
} from './admin-app-audit'

const EXPORT_REQUEST_ID = /^aexr_[A-Za-z0-9_-]{1,75}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const CASE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}$/u
const STEP_UP_TOKEN = /^aesu_[0-9a-f]{64}$/u
const DOWNLOAD_TOKEN = /^aedt\.aext_[A-Za-z0-9_-]{1,75}\.[0-9a-f]{64}$/u
const MAX_EXPORT_ROWS = 5_000
const MAX_EXPORT_BYTES = 25_000_000
const STEP_UP_TTL_MS = 5 * 60_000
const DOWNLOAD_TICKET_TTL_MS = 5 * 60_000
const EXPORT_FILE_TTL_MS = 24 * 60 * 60_000
const STEP_UP_FAILURE_WINDOW_MS = 15 * 60_000
const STEP_UP_FAILURE_LIMIT = 5

const EXPORT_STATUSES = new Set([
  'pending_review',
  'rejected',
  'scope_changed',
  'generating',
  'ready',
  'failed',
  'expired',
  'revoked',
])
const ACTION_SCOPES = new Set(['request', 'review', 'download_ticket'])
const REVIEW_DECISIONS = new Set(['approve', 'reject'])
const APPROVE_REASONS = new Set(['approved_business_need'])
const REJECT_REASONS = new Set([
  'insufficient_business_need',
  'scope_too_broad',
  'wrong_scope',
  'policy_restriction',
])

export type AdminAppAuditExportStatus =
  | 'pending_review'
  | 'rejected'
  | 'scope_changed'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'revoked'

export type AdminAppAuditExportActionScope = 'request' | 'review' | 'download_ticket'
export type AdminAppAuditExportReviewDecision = 'approve' | 'reject'

export interface AdminAppAuditExportStepUpInput {
  password?: unknown
  actionScope?: unknown
}

export interface AdminAppAuditExportCreateInput {
  purpose?: unknown
  caseReference?: unknown
  requestExplanation?: unknown
  query?: unknown
}

export interface AdminAppAuditExportReviewInput {
  expectedVersion?: unknown
  decision?: unknown
  reasonCode?: unknown
  note?: unknown
}

export interface AdminAppAuditExportListInput {
  status?: unknown
  limit?: unknown
}

export interface AdminAppAuditExportActor {
  id: number
  role: string
  label: string
}

export interface AdminAppAuditExportRequest {
  requestId: string
  version: number
  status: AdminAppAuditExportStatus
  storedStatus: AdminAppAuditExportStatus
  purpose: AdminAppAuditPurpose
  caseReference: string
  requestExplanation: string
  range: { from: string; to: string }
  scope: {
    query: Omit<NormalizedAuditQuery, 'cursor' | 'limit'>
    fingerprint: string
    digest: string
    eventCount: number
    firstSequence: number
    lastSequence: number
  }
  requester: AdminAppAuditExportActor
  requestedAt: string
  review: null | {
    decision: AdminAppAuditExportReviewDecision
    reasonCode: string
    note: string
    reviewer: AdminAppAuditExportActor
    reviewedAt: string
  }
  file: null | {
    available: boolean
    sha256: string
    size: number
    rowCount: number
    generatedAt: string
    expiresAt: string
  }
  failureCode: string | null
  canReview: boolean
  canDownload: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminAppAuditExportTimelineEvent {
  eventId: string
  sequence: number
  eventType: string
  actor: AdminAppAuditExportActor | null
  resultCode: string
  summary: Record<string, unknown>
  createdAt: string
}

export interface AdminAppAuditExportDetail {
  request: AdminAppAuditExportRequest
  timeline: AdminAppAuditExportTimelineEvent[]
}

export class AdminAppAuditExportError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type ExportRequestRow = {
  id: string
  version: number
  status: AdminAppAuditExportStatus
  purpose: AdminAppAuditPurpose
  case_reference: string
  request_explanation: string
  range_from: string
  range_to: string
  scope_query_json: string
  scope_fingerprint: string
  scope_event_count: number
  scope_first_sequence: number
  scope_last_sequence: number
  scope_digest: string
  requested_by: number
  requested_role_snapshot: string
  requested_at: string
  review_decision: AdminAppAuditExportReviewDecision | null
  review_reason_code: string | null
  review_note: string | null
  reviewed_by: number | null
  reviewed_role_snapshot: string | null
  reviewed_at: string | null
  generation_token: string | null
  r2_key: string | null
  r2_etag: string | null
  file_sha256: string | null
  file_size: number | null
  row_count: number | null
  generated_at: string | null
  expires_at: string | null
  failure_code: string | null
  created_at: string
  updated_at: string
  requester_email: string | null
  requester_nickname: string | null
  reviewer_email: string | null
  reviewer_nickname: string | null
}

type ExportEventRow = {
  id: string
  sequence: number
  event_type: string
  actor_type: 'admin' | 'system'
  actor_id: number | null
  actor_role_snapshot: string | null
  actor_email: string | null
  actor_nickname: string | null
  result_code: string
  safe_summary_json: string
  created_at: string
}

type ExportCommandRow = {
  request_hash: string
  result_request_id: string
  result_ticket_id: string | null
}

type ExportScopeReferenceRow = {
  sequence: number
  audit_event_id: string
}

type ExportTicketRow = {
  id: string
  request_id: string
  request_version: number
  created_for: number
  created_for_role_snapshot: string
  file_sha256_snapshot: string
  scope_digest_snapshot: string
  expires_at: string
  consumed_at: string | null
  request_status: AdminAppAuditExportStatus
  request_current_version: number
  request_scope_digest: string
  requested_by: number
  request_expires_at: string | null
  r2_key: string | null
  r2_etag: string | null
  file_sha256: string | null
  file_size: number | null
  row_count: number | null
}

type ExportCsvRow = {
  sequence: number
  audit_event_id: string
  actor_role_snapshot: string
  action_domain: string
  risk_level: string
  result: string
  occurred_at: string
  admin_id: number
  action: string
  target_type: string
  target_id: string | null
  before_value: string | null
  after_value: string | null
  request_id: string | null
  trace_id: string | null
  reason_code: string | null
  business_reference: string | null
  target_version: string | null
  approval_request_id: string | null
  approval_step_id: string | null
  policy_version: string | null
  capability: string | null
  scope_summary: string | null
  error_code: string | null
  registry_schema_version: number | null
  registry_display_name: string | null
  registry_sensitivity: string | null
}

type ActiveAdminWithPassword = ActorRow & { password_hash: string }

export async function issueAdminAppAuditExportStepUp(
  db: D1Database,
  adminId: number,
  input: AdminAppAuditExportStepUpInput,
  requestContext: AdminAppAuditRequestContext,
  now = new Date(),
) {
  const actor = await requireActiveAdminWithPassword(db, adminId)
  const actionScope = normalizeActionScope(input.actionScope)
  const password = normalizePassword(input.password)
  const windowStart = new Date(now.getTime() - STEP_UP_FAILURE_WINDOW_MS).toISOString()
  const recentFailures = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM admin_audit_logs audit
    LEFT JOIN app_audit_event_contexts context ON context.audit_event_id = audit.id
    WHERE audit.admin_id = ?
      AND audit.action = 'app.audit.export.step_up_denied'
      AND audit.created_at >= ?
      AND context.result = 'denied'
  `).bind(actor.id, windowStart).first<{ count: number }>()
  if (Number(recentFailures?.count ?? 0) >= STEP_UP_FAILURE_LIMIT) {
    throw new AdminAppAuditExportError(429, 'APP_AUDIT_EXPORT_STEP_UP_RATE_LIMITED', '密码验证失败次数过多，请稍后再试')
  }

  const verified = await verifyPassword(password, actor.password_hash)
  if (!verified) {
    await writeStandaloneAudit(
      db,
      actor,
      'app.audit.export.step_up_denied',
      'app_audit_export_step_up',
      String(actor.id),
      null,
      { actionScope, verified: false },
      requestContext,
      { capability: `audit.export.${actionScope}`, result: 'denied', errorCode: 'password_invalid' },
      now,
    )
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_PASSWORD_INVALID', '当前账户密码验证失败')
  }

  const tokenId = generateId('aexs')
  const token = `aesu_${randomHex(32)}`
  const tokenHash = await sha256Hex(token)
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + STEP_UP_TTL_MS).toISOString()
  const auditId = generateId('audit')
  const statements = [
    db.prepare(`
      INSERT INTO app_audit_export_step_up_tokens (
        id, token_hash, admin_id, action_scope, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(tokenId, tokenHash, actor.id, actionScope, expiresAt, createdAt),
    ...auditStatements(db, {
      auditId,
      actorId: actor.id,
      action: 'app.audit.export.step_up_issue',
      targetType: 'app_audit_export_step_up',
      targetId: tokenId,
      before: null,
      after: { actionScope, expiresAt },
      requestContext,
      reasonCode: 'password_reauthenticated',
      capability: `audit.export.${actionScope}`,
      result: 'succeeded',
      now: createdAt,
    }),
  ]
  await db.batch(statements)
  return { token, actionScope, expiresAt }
}

export async function listAdminAppAuditExportRequests(
  db: D1Database,
  adminId: number,
  input: AdminAppAuditExportListInput,
  now = new Date(),
) {
  const actor = await requireActiveAdmin(db, adminId)
  const status = normalizeOptionalStatus(input.status)
  const limit = normalizeLimit(input.limit)
  const conditions = [actor.role === 'owner' ? '1 = 1' : 'request.requested_by = ?']
  const params: unknown[] = actor.role === 'owner' ? [] : [actor.id]
  if (status) {
    if (status === 'expired') {
      conditions.push("(request.status = 'expired' OR (request.status = 'ready' AND request.expires_at <= ?))")
      params.push(now.toISOString())
    }
    else if (status === 'ready') {
      conditions.push("request.status = 'ready' AND request.expires_at > ?")
      params.push(now.toISOString())
    }
    else {
      conditions.push('request.status = ?')
      params.push(status)
    }
  }
  const result = await db.prepare(`
    ${exportRequestSelect()}
    WHERE ${conditions.join(' AND ')}
    ORDER BY request.requested_at DESC, request.id DESC
    LIMIT ?
  `).bind(...params, limit).all<ExportRequestRow>()
  return {
    requests: result.results.map(row => mapExportRequest(row, actor, now)),
    visibility: actor.role === 'owner' ? 'all' as const : 'self' as const,
  }
}

export async function getAdminAppAuditExportRequest(
  db: D1Database,
  adminId: number,
  requestIdValue: string,
  now = new Date(),
): Promise<AdminAppAuditExportDetail> {
  const actor = await requireActiveAdmin(db, adminId)
  const row = await requireExportRequest(db, actor, normalizeRequestId(requestIdValue))
  const events = await db.prepare(`
    SELECT event.id, event.sequence, event.event_type, event.actor_type, event.actor_id,
           event.actor_role_snapshot, actor.email AS actor_email, actor.nickname AS actor_nickname,
           event.result_code, event.safe_summary_json, event.created_at
    FROM app_audit_export_request_events event
    LEFT JOIN users actor ON actor.id = event.actor_id
    WHERE event.request_id = ?
    ORDER BY event.sequence ASC, event.id ASC
  `).bind(row.id).all<ExportEventRow>()
  return {
    request: mapExportRequest(row, actor, now),
    timeline: events.results.map(mapExportTimelineEvent),
  }
}

export async function createAdminAppAuditExportRequest(
  db: D1Database,
  adminId: number,
  idempotencyKeyValue: string | null,
  stepUpTokenValue: string | null,
  input: AdminAppAuditExportCreateInput,
  requestContext: AdminAppAuditRequestContext,
  now = new Date(),
) {
  const actor = await requireActiveAdmin(db, adminId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const stepUpToken = normalizeStepUpToken(stepUpTokenValue)
  const normalizedInput = normalizeCreateInput(input)
  const requestHash = await sha256Hex(stableStringify(normalizedInput))
  const replay = await findExportCommand(db, actor.id, 'request', idempotencyKey)
  if (replay) {
    assertCommandHash(replay, requestHash)
    const replayed = await requireExportRequest(db, actor, replay.result_request_id)
    return { request: mapExportRequest(replayed, actor, now), replayed: true }
  }

  const cutoff = new Date(now.getTime() - 1)
  const suppliedTo = new Date(normalizedInput.query.to)
  if (suppliedTo.getTime() > now.getTime() + 5 * 60_000) {
    throw new AdminAppAuditExportError(400, 'APP_AUDIT_EXPORT_FUTURE_RANGE_FORBIDDEN', '导出范围结束时间不能晚于当前时间')
  }
  const queryInput: AdminAppAuditListInput = {
    ...normalizedInput.query,
    purpose: normalizedInput.purpose,
    to: new Date(Math.min(suppliedTo.getTime(), cutoff.getTime())).toISOString(),
    cursor: undefined,
    limit: 1,
  }
  const prepared = await prepareAdminAppAuditQuery(db, actor.id, queryInput, cutoff)
  const snapshot = await snapshotPreparedScope(db, prepared)
  if (snapshot.references.length === 0) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_SCOPE_EMPTY', '当前筛选范围没有可导出的审计事件')
  }
  if (snapshot.references.length > MAX_EXPORT_ROWS) {
    throw new AdminAppAuditExportError(413, 'APP_AUDIT_EXPORT_SCOPE_TOO_LARGE', `单次最多导出 ${MAX_EXPORT_ROWS} 条审计事件`)
  }

  const requestId = generateId('aexr')
  const commandId = generateId('aexc')
  const eventId = generateId('aexe')
  const auditId = generateId('audit')
  const nowIso = now.toISOString()
  const tokenHash = await sha256Hex(stepUpToken)
  const storedQuery = exportableQuery(prepared.query)
  const statements = [
    db.prepare(`
      UPDATE app_audit_export_step_up_tokens
      SET consumed_at = ?, consumed_operation_id = ?
      WHERE token_hash = ? AND admin_id = ? AND action_scope = 'request'
        AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = 'active')
    `).bind(nowIso, requestId, tokenHash, actor.id, nowIso, actor.id, actor.role),
    db.prepare(`
      INSERT INTO app_audit_export_requests (
        id, version, status, purpose, case_reference, request_explanation,
        range_from, range_to, scope_query_json, scope_fingerprint,
        scope_event_count, scope_first_sequence, scope_last_sequence, scope_digest,
        requested_by, requested_role_snapshot, requested_at, created_at, updated_at
      )
      SELECT ?, 1, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM app_audit_export_step_up_tokens
      WHERE token_hash = ? AND admin_id = ? AND action_scope = 'request'
        AND consumed_operation_id = ? AND consumed_at = ?
    `).bind(
      requestId,
      prepared.query.purpose,
      normalizedInput.caseReference,
      normalizedInput.requestExplanation,
      prepared.query.from,
      prepared.query.to,
      JSON.stringify(storedQuery),
      prepared.fingerprint,
      snapshot.references.length,
      snapshot.references[0]!.sequence,
      snapshot.references.at(-1)!.sequence,
      snapshot.digest,
      actor.id,
      actor.role,
      nowIso,
      nowIso,
      nowIso,
      tokenHash,
      actor.id,
      requestId,
      nowIso,
    ),
    db.prepare(`
      INSERT INTO app_audit_export_request_events (
        id, request_id, sequence, event_type, actor_type, actor_id, actor_role_snapshot,
        result_code, safe_summary_json, created_at
      )
      SELECT ?, id, 1, 'requested', 'admin', ?, ?, 'pending_review', ?, ?
      FROM app_audit_export_requests WHERE id = ?
    `).bind(eventId, actor.id, actor.role, JSON.stringify({ eventCount: snapshot.references.length, scopeDigest: snapshot.digest }), nowIso, requestId),
    db.prepare(`
      INSERT INTO app_audit_export_commands (
        id, admin_id, operation, idempotency_key, request_hash,
        result_request_id, result_ticket_id, created_at
      )
      SELECT ?, ?, 'request', ?, ?, id, NULL, ?
      FROM app_audit_export_requests WHERE id = ?
    `).bind(commandId, actor.id, idempotencyKey, requestHash, nowIso, requestId),
    ...auditStatements(db, {
      auditId,
      actorId: actor.id,
      action: 'app.audit.export.request',
      targetType: 'app_audit_export_request',
      targetId: requestId,
      before: null,
      after: {
        status: 'pending_review',
        purpose: prepared.query.purpose,
        caseReference: normalizedInput.caseReference,
        eventCount: snapshot.references.length,
        scopeDigest: snapshot.digest,
      },
      requestContext,
      idempotencyKeyHash: await sha256Hex(idempotencyKey),
      reasonCode: 'export_requested',
      businessReference: normalizedInput.caseReference,
      targetVersion: '1',
      capability: 'audit.export.request',
      scopeSummary: JSON.stringify({ visibility: prepared.visibility, query: storedQuery }),
      result: 'succeeded',
      now: nowIso,
      guardRequestId: requestId,
    }),
  ]
  const results = await db.batch(statements)
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_STEP_UP_INVALID', '密码验证凭证已失效或已使用，请重新验证密码')
  }
  const created = await requireExportRequest(db, actor, requestId)
  return { request: mapExportRequest(created, actor, now), replayed: false }
}

export async function reviewAdminAppAuditExportRequest(
  env: Pick<Bindings, 'DB' | 'R2'>,
  adminId: number,
  requestIdValue: string,
  idempotencyKeyValue: string | null,
  stepUpTokenValue: string | null,
  input: AdminAppAuditExportReviewInput,
  requestContext: AdminAppAuditRequestContext,
  now = new Date(),
) {
  const actor = await requireActiveOwner(env.DB, adminId)
  const requestId = normalizeRequestId(requestIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const stepUpToken = normalizeStepUpToken(stepUpTokenValue)
  const review = normalizeReviewInput(input)
  const requestHash = await sha256Hex(stableStringify({ requestId, ...review }))
  const replay = await findExportCommand(env.DB, actor.id, 'review', idempotencyKey)
  if (replay) {
    assertCommandHash(replay, requestHash)
    const replayed = await requireExportRequest(env.DB, actor, replay.result_request_id)
    return { request: mapExportRequest(replayed, actor, now), replayed: true }
  }

  const current = await requireExportRequest(env.DB, actor, requestId)
  if (current.requested_by === actor.id) {
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_REVIEWER_SEPARATION_REQUIRED', '申请人不能复核自己的导出申请')
  }
  if (current.status !== 'pending_review') {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_NOT_PENDING', '该申请已形成复核结论，不能重复复核')
  }
  if (current.version !== review.expectedVersion) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_VERSION_CONFLICT', '申请状态已变化，请刷新后重试')
  }

  let prepared: AdminAppAuditPreparedQuery | null = null
  let observedDigest = current.scope_digest
  let scopeMatches = true
  if (review.decision === 'approve') {
    try {
      prepared = await prepareAdminAppAuditQuery(
        env.DB,
        current.requested_by,
        parseStoredScopeQuery(current.scope_query_json),
        now,
      )
      const observed = await snapshotPreparedScope(env.DB, prepared)
      observedDigest = observed.digest
      scopeMatches = prepared.fingerprint === current.scope_fingerprint
        && observed.references.length === current.scope_event_count
        && observed.references[0]?.sequence === current.scope_first_sequence
        && observed.references.at(-1)?.sequence === current.scope_last_sequence
        && observed.digest === current.scope_digest
    }
    catch (error) {
      if (!(error instanceof AdminAppAuditError) && !(error instanceof AdminAppAuditExportError)) throw error
      observedDigest = await sha256Hex(stableStringify({ requestId, state: 'authorization_or_scope_unavailable' }))
      scopeMatches = false
    }
  }

  const terminalStatus: 'rejected' | 'scope_changed' | 'generating'
    = review.decision === 'reject' ? 'rejected' : scopeMatches ? 'generating' : 'scope_changed'
  const decisionId = generateId('aexd')
  const eventId = generateId('aexe')
  const commandId = generateId('aexc')
  const auditId = generateId('audit')
  const generationToken = terminalStatus === 'generating' ? crypto.randomUUID() : null
  const nowIso = now.toISOString()
  const tokenHash = await sha256Hex(stepUpToken)
  const reviewDecision = review.decision
  const requestReasonCode = terminalStatus === 'scope_changed'
    ? 'approved_business_need'
    : review.reasonCode
  const requestNote = terminalStatus === 'scope_changed'
    ? '复核时授权范围、筛选口径或事件集合已变化，原申请已失效。'
    : review.note
  const eventType = terminalStatus === 'rejected'
    ? 'review_rejected'
    : terminalStatus === 'scope_changed'
      ? 'scope_changed'
      : 'generation_started'
  const decisionFact = terminalStatus === 'scope_changed' ? 'scope_changed' : reviewDecision
  const decisionReason = terminalStatus === 'scope_changed' ? 'wrong_scope' : review.reasonCode
  const nextVersion = current.version + 1
  const auditAction = terminalStatus === 'rejected'
    ? 'app.audit.export.review_reject'
    : terminalStatus === 'scope_changed'
      ? 'app.audit.export.review_scope_changed'
      : 'app.audit.export.review_approve'
  const resultCode = terminalStatus === 'generating' ? 'generation_started' : terminalStatus

  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_audit_export_step_up_tokens
      SET consumed_at = ?, consumed_operation_id = ?
      WHERE token_hash = ? AND admin_id = ? AND action_scope = 'review'
        AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'owner' AND status = 'active')
        AND EXISTS (
          SELECT 1
          FROM app_audit_export_requests request
          JOIN users requester ON requester.id = request.requested_by
          WHERE request.id = ? AND request.status = 'pending_review'
            AND request.version = ? AND request.requested_by <> ?
            AND requester.status = 'active'
            AND requester.role = request.requested_role_snapshot
        )
    `).bind(nowIso, decisionId, tokenHash, actor.id, nowIso, actor.id, requestId, current.version, actor.id),
    env.DB.prepare(`
      UPDATE app_audit_export_requests
      SET version = ?, status = ?, review_decision = ?, review_reason_code = ?,
          review_note = ?, reviewed_by = ?, reviewed_role_snapshot = ?,
          reviewed_at = ?, generation_token = ?,
          failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_review' AND version = ? AND requested_by <> ?
        AND EXISTS (
          SELECT 1 FROM app_audit_export_step_up_tokens
          WHERE token_hash = ? AND admin_id = ? AND action_scope = 'review'
            AND consumed_operation_id = ? AND consumed_at = ?
        )
    `).bind(
      nextVersion,
      terminalStatus,
      reviewDecision,
      requestReasonCode,
      requestNote,
      actor.id,
      actor.role,
      nowIso,
      generationToken,
      terminalStatus === 'scope_changed' ? 'scope_changed' : null,
      nowIso,
      requestId,
      current.version,
      actor.id,
      tokenHash,
      actor.id,
      decisionId,
      nowIso,
    ),
    env.DB.prepare(`
      INSERT INTO app_audit_export_review_decisions (
        id, request_id, reviewer_id, decision, expected_request_version,
        reason_code, note_sha256, observed_scope_digest, created_at
      )
      SELECT ?, id, ?, ?, ?, ?, ?, ?, ?
      FROM app_audit_export_requests
      WHERE id = ? AND version = ? AND reviewed_by = ? AND reviewed_at = ?
    `).bind(
      decisionId,
      actor.id,
      decisionFact,
      current.version,
      decisionReason,
      await sha256Hex(requestNote),
      observedDigest,
      nowIso,
      requestId,
      nextVersion,
      actor.id,
      nowIso,
    ),
    exportEventInsertStatement(env.DB, {
      id: eventId,
      requestId,
      eventType,
      actorId: actor.id,
      resultCode,
      summary: { expectedVersion: current.version, nextVersion, observedDigest },
      now: nowIso,
      guardVersion: nextVersion,
      guardUpdatedAt: nowIso,
      requiredDecisionId: decisionId,
    }),
    env.DB.prepare(`
      INSERT INTO app_audit_export_commands (
        id, admin_id, operation, idempotency_key, request_hash,
        result_request_id, result_ticket_id, created_at
      )
      SELECT ?, ?, 'review', ?, ?, id, NULL, ?
      FROM app_audit_export_requests
      WHERE id = ? AND version = ? AND reviewed_by = ?
        AND EXISTS (SELECT 1 FROM app_audit_export_review_decisions WHERE id = ?)
    `).bind(commandId, actor.id, idempotencyKey, requestHash, nowIso, requestId, nextVersion, actor.id, decisionId),
    ...auditStatements(env.DB, {
      auditId,
      actorId: actor.id,
      action: auditAction,
      targetType: 'app_audit_export_request',
      targetId: requestId,
      before: { status: current.status, version: current.version },
      after: { status: terminalStatus, version: nextVersion, observedScopeDigest: observedDigest },
      requestContext,
      idempotencyKeyHash: await sha256Hex(idempotencyKey),
      reasonCode: decisionReason,
      businessReference: current.case_reference,
      targetVersion: String(nextVersion),
      approvalRequestId: requestId,
      approvalStepId: decisionId,
      capability: 'audit.export.review',
      result: terminalStatus === 'scope_changed' ? 'denied' : 'succeeded',
      errorCode: terminalStatus === 'scope_changed' ? 'scope_changed' : null,
      now: nowIso,
      guardRequestId: requestId,
      guardVersion: nextVersion,
      guardUpdatedAt: nowIso,
      requiredDecisionId: decisionId,
    }),
  ])
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_REVIEW_CONFLICT', '密码验证凭证已失效，或申请已由其他复核人处理')
  }

  if (terminalStatus !== 'generating') {
    const completed = await requireExportRequest(env.DB, actor, requestId)
    return { request: mapExportRequest(completed, actor, now), replayed: false }
  }

  try {
    await generateApprovedExport(env, actor, current, nextVersion, generationToken!, prepared!, requestContext, now)
  }
  catch {
    // 生成失败已由 generateApprovedExport 转为可见终态，不把 R2 或内部异常暴露给客户端。
  }
  const completed = await requireExportRequest(env.DB, actor, requestId)
  return { request: mapExportRequest(completed, actor, now), replayed: false }
}

export async function issueAdminAppAuditExportDownloadTicket(
  env: Pick<Bindings, 'DB' | 'R2' | 'SESSION_SECRET'>,
  adminId: number,
  requestIdValue: string,
  idempotencyKeyValue: string | null,
  stepUpTokenValue: string | null,
  requestContext: AdminAppAuditRequestContext,
  now = new Date(),
) {
  const actor = await requireActiveAdmin(env.DB, adminId)
  const requestId = normalizeRequestId(requestIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const stepUpToken = normalizeStepUpToken(stepUpTokenValue)
  const requestHash = await sha256Hex(stableStringify({ requestId }))
  const replay = await findExportCommand(env.DB, actor.id, 'download_ticket', idempotencyKey)
  if (replay) {
    assertCommandHash(replay, requestHash)
    if (!replay.result_ticket_id) throw commandConflict()
    const ticket = await requireTicketById(env.DB, replay.result_ticket_id)
    ensureTicketCanBeReturned(ticket, actor, now)
    return {
      ticket: await materializeDownloadTicket(env.SESSION_SECRET, ticket),
      replayed: true,
    }
  }

  const current = await requireExportRequest(env.DB, actor, requestId)
  if (current.requested_by !== actor.id) {
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_DOWNLOAD_OWNER_REQUIRED', '只有原申请人可以下载该审计导出')
  }
  if (effectiveStatus(current, now) !== 'ready' || !current.file_sha256 || !current.r2_key || !current.r2_etag || !current.expires_at) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_NOT_READY', '导出文件尚未就绪或已失效')
  }

  const tokenHash = await sha256Hex(stepUpToken)
  let observedDigest = await sha256Hex(stableStringify({ requestId, state: 'scope_unavailable' }))
  let scopeMatches = false
  try {
    const prepared = await prepareAdminAppAuditQuery(
      env.DB,
      current.requested_by,
      parseStoredScopeQuery(current.scope_query_json),
      now,
    )
    const observed = await snapshotPreparedScope(env.DB, prepared)
    observedDigest = observed.digest
    scopeMatches = prepared.fingerprint === current.scope_fingerprint
      && observed.references.length === current.scope_event_count
      && observed.references[0]?.sequence === current.scope_first_sequence
      && observed.references.at(-1)?.sequence === current.scope_last_sequence
      && observed.digest === current.scope_digest
  }
  catch (error) {
    if (!(error instanceof AdminAppAuditError) && !(error instanceof AdminAppAuditExportError)) throw error
  }
  if (!scopeMatches) {
    await closeReadyRequest(
      env.DB,
      actor,
      current,
      tokenHash,
      'scope_changed',
      'scope_changed_before_download',
      observedDigest,
      requestContext,
      now,
    )
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_SCOPE_CHANGED', '申请范围或当前授权已变化，原导出已失效')
  }

  const object = await env.R2.head(current.r2_key)
  if (!object || !r2ObjectMatchesRequest(object, current)) {
    await closeReadyRequest(
      env.DB,
      actor,
      current,
      tokenHash,
      'failed',
      'r2_object_integrity_mismatch',
      current.scope_digest,
      requestContext,
      now,
    )
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_OBJECT_INVALID', '导出文件完整性校验失败，已禁止下载')
  }

  const ticketId = generateId('aext')
  const nowIso = now.toISOString()
  const expiresAt = new Date(Math.min(now.getTime() + DOWNLOAD_TICKET_TTL_MS, new Date(current.expires_at).getTime())).toISOString()
  const ticketToken = await buildDownloadToken(env.SESSION_SECRET, {
    ticketId,
    requestId,
    createdFor: actor.id,
    createdForRole: actor.role,
    expiresAt,
  })
  const ticketTokenHash = await sha256Hex(ticketToken)
  const commandId = generateId('aexc')
  const eventId = generateId('aexe')
  const auditId = generateId('audit')
  const operationId = `${ticketId}:issue`
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_audit_export_step_up_tokens
      SET consumed_at = ?, consumed_operation_id = ?
      WHERE token_hash = ? AND admin_id = ? AND action_scope = 'download_ticket'
        AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = 'active')
        AND EXISTS (
          SELECT 1 FROM app_audit_export_requests
          WHERE id = ? AND status = 'ready' AND version = ? AND requested_by = ?
            AND expires_at > ? AND file_sha256 = ? AND scope_digest = ?
        )
    `).bind(
      nowIso,
      operationId,
      tokenHash,
      actor.id,
      nowIso,
      actor.id,
      actor.role,
      requestId,
      current.version,
      actor.id,
      nowIso,
      current.file_sha256,
      current.scope_digest,
    ),
    env.DB.prepare(`
      INSERT INTO app_audit_export_download_tickets (
        id, token_hash, request_id, request_version, created_for, created_for_role_snapshot,
        file_sha256_snapshot, scope_digest_snapshot, expires_at, created_at
      )
      SELECT ?, ?, id, version, ?, ?, file_sha256, scope_digest, ?, ?
      FROM app_audit_export_requests
      WHERE id = ? AND status = 'ready' AND version = ? AND requested_by = ?
        AND expires_at > ? AND file_sha256 = ? AND scope_digest = ?
        AND EXISTS (
          SELECT 1 FROM app_audit_export_step_up_tokens
          WHERE token_hash = ? AND admin_id = ? AND action_scope = 'download_ticket'
            AND consumed_operation_id = ? AND consumed_at = ?
        )
    `).bind(
      ticketId,
      ticketTokenHash,
      actor.id,
      actor.role,
      expiresAt,
      nowIso,
      requestId,
      current.version,
      actor.id,
      nowIso,
      current.file_sha256,
      current.scope_digest,
      tokenHash,
      actor.id,
      operationId,
      nowIso,
    ),
    exportEventInsertStatement(env.DB, {
      id: eventId,
      requestId,
      eventType: 'download_ticket_issued',
      actorId: actor.id,
      resultCode: 'ticket_issued',
      summary: { ticketId, expiresAt, fileSha256: current.file_sha256 },
      now: nowIso,
      guardVersion: current.version,
      requiredTicketId: ticketId,
    }),
    env.DB.prepare(`
      INSERT INTO app_audit_export_commands (
        id, admin_id, operation, idempotency_key, request_hash,
        result_request_id, result_ticket_id, created_at
      )
      SELECT ?, ?, 'download_ticket', ?, ?, request_id, id, ?
      FROM app_audit_export_download_tickets WHERE id = ?
    `).bind(commandId, actor.id, idempotencyKey, requestHash, nowIso, ticketId),
    ...auditStatements(env.DB, {
      auditId,
      actorId: actor.id,
      action: 'app.audit.export.download_ticket_issue',
      targetType: 'app_audit_export_request',
      targetId: requestId,
      before: null,
      after: { ticketId, expiresAt, fileSha256: current.file_sha256 },
      requestContext,
      idempotencyKeyHash: await sha256Hex(idempotencyKey),
      reasonCode: 'download_ticket_issued',
      businessReference: current.case_reference,
      targetVersion: String(current.version),
      approvalRequestId: requestId,
      capability: 'audit.export.download',
      result: 'succeeded',
      now: nowIso,
      requiredTicketId: ticketId,
    }),
  ])
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_TICKET_CONFLICT', '密码验证凭证已失效，或导出状态已变化')
  }
  const ticket = await requireTicketById(env.DB, ticketId)
  return { ticket: await materializeDownloadTicket(env.SESSION_SECRET, ticket), replayed: false }
}

export async function downloadAdminAppAuditExport(
  env: Pick<Bindings, 'DB' | 'R2'>,
  adminId: number,
  ticketTokenValue: string | null,
  requestContext: AdminAppAuditRequestContext,
  now = new Date(),
) {
  const actor = await requireActiveAdmin(env.DB, adminId)
  const ticketToken = normalizeDownloadToken(ticketTokenValue)
  const tokenHash = await sha256Hex(ticketToken)
  const ticket = await env.DB.prepare(`
    ${ticketSelect()}
    WHERE ticket.token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first<ExportTicketRow>()
  if (!ticket || ticket.created_for !== actor.id) {
    throw new AdminAppAuditExportError(404, 'APP_AUDIT_EXPORT_TICKET_NOT_FOUND', '下载票据不存在或不属于当前账户')
  }
  ensureTicketCanBeReturned(ticket, actor, now)
  if (!ticket.r2_key || !ticket.r2_etag || !ticket.file_sha256 || ticket.file_size == null || ticket.row_count == null) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_FILE_STATE_INVALID', '导出文件状态不完整，已禁止下载')
  }

  const object = await env.R2.get(ticket.r2_key)
  if (!object || !r2TicketObjectMatches(object, ticket)) {
    if (object) await object.body.cancel().catch(() => undefined)
    await invalidateReadyRequestByTicket(
      env.DB,
      actor,
      ticket,
      requestContext,
      now,
      'r2_object_integrity_mismatch',
    )
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_OBJECT_INVALID', '导出文件完整性校验失败，已禁止下载')
  }
  const nowIso = now.toISOString()
  const consumedRequestId = normalizeRequestContextId(requestContext.requestId)
  const eventId = generateId('aexe')
  const auditId = generateId('audit')
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_audit_export_download_tickets
      SET consumed_at = ?, consumed_request_id = ?
      WHERE id = ? AND token_hash = ? AND created_for = ?
        AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = 'active')
        AND EXISTS (
          SELECT 1 FROM app_audit_export_requests
          WHERE id = ? AND status = 'ready' AND version = ? AND requested_by = ?
            AND expires_at > ? AND file_sha256 = ? AND scope_digest = ?
        )
    `).bind(
      nowIso,
      consumedRequestId,
      ticket.id,
      tokenHash,
      actor.id,
      nowIso,
      actor.id,
      actor.role,
      ticket.request_id,
      ticket.request_version,
      actor.id,
      nowIso,
      ticket.file_sha256_snapshot,
      ticket.scope_digest_snapshot,
    ),
    exportEventInsertStatement(env.DB, {
      id: eventId,
      requestId: ticket.request_id,
      eventType: 'downloaded',
      actorId: actor.id,
      resultCode: 'download_started',
      summary: { ticketId: ticket.id, fileSha256: ticket.file_sha256_snapshot, rowCount: ticket.row_count },
      now: nowIso,
      guardVersion: ticket.request_version,
      consumedTicketId: ticket.id,
      consumedRequestId,
    }),
    ...auditStatements(env.DB, {
      auditId,
      actorId: actor.id,
      action: 'app.audit.export.download',
      targetType: 'app_audit_export_request',
      targetId: ticket.request_id,
      before: null,
      after: { ticketId: ticket.id, fileSha256: ticket.file_sha256_snapshot, rowCount: ticket.row_count },
      requestContext,
      reasonCode: 'one_time_ticket_consumed',
      targetVersion: String(ticket.request_version),
      approvalRequestId: ticket.request_id,
      capability: 'audit.export.download',
      result: 'succeeded',
      now: nowIso,
      consumedTicketId: ticket.id,
      consumedRequestId,
    }),
  ])
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    await object.body.cancel().catch(() => undefined)
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_TICKET_CONSUMED', '下载票据已使用、已过期或导出状态已变化')
  }

  const filename = `meigallery-audit-${ticket.request_id}.csv`
  return new Response(object.body, {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': String(ticket.file_size),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function generateApprovedExport(
  env: Pick<Bindings, 'DB' | 'R2'>,
  reviewer: ActorRow,
  original: ExportRequestRow,
  generatingVersion: number,
  generationToken: string,
  prepared: AdminAppAuditPreparedQuery,
  requestContext: AdminAppAuditRequestContext,
  now: Date,
) {
  const r2Key = `audit/exports/${original.id}/events.csv`
  let uploaded = false
  let failureCode = 'generation_failed'
  try {
    const authorization = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM app_audit_export_requests request
      JOIN users requester ON requester.id = request.requested_by
      JOIN users reviewer ON reviewer.id = request.reviewed_by
      WHERE request.id = ? AND request.status = 'generating' AND request.version = ?
        AND request.generation_token = ? AND request.reviewed_by = ?
        AND requester.status = 'active' AND requester.role = request.requested_role_snapshot
        AND reviewer.status = 'active' AND reviewer.role = 'owner'
        AND request.reviewed_role_snapshot = 'owner'
    `).bind(original.id, generatingVersion, generationToken, reviewer.id).first<{ count: number }>()
    if (Number(authorization?.count ?? 0) !== 1) {
      failureCode = 'authorization_changed_during_generation'
      throw new Error('authorization changed during generation')
    }
    const rows = await loadExportCsvRows(env.DB, prepared)
    if (rows.length !== original.scope_event_count || rows.length === 0 || rows.length > MAX_EXPORT_ROWS) {
      failureCode = 'scope_changed_during_generation'
      throw new Error('scope changed during generation')
    }
    const generatedAt = now.toISOString()
    const csv = await buildControlledExportCsv(rows, {
      requestId: original.id,
      generatedAt,
      requesterId: original.requested_by,
      reviewerId: reviewer.id,
      purpose: original.purpose,
      caseReference: original.case_reference,
      scopeDigest: original.scope_digest,
    })
    const bytes = new TextEncoder().encode(csv)
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_EXPORT_BYTES) {
      failureCode = 'export_file_too_large'
      throw new AdminAppAuditExportError(413, 'APP_AUDIT_EXPORT_FILE_TOO_LARGE', '脱敏后的导出文件超过大小上限')
    }
    const fileSha256 = await sha256BytesHex(bytes)
    const expiresAt = new Date(now.getTime() + EXPORT_FILE_TTL_MS).toISOString()
    failureCode = 'r2_write_failed'
    const object = await env.R2.put(r2Key, bytes, {
      httpMetadata: {
        contentType: 'text/csv; charset=utf-8',
        contentDisposition: `attachment; filename="meigallery-audit-${original.id}.csv"`,
        cacheControl: 'private, no-store, max-age=0',
      },
      customMetadata: {
        requestid: original.id,
        filesha256: fileSha256,
        scopedigest: original.scope_digest,
      },
      sha256: fileSha256,
    })
    uploaded = true
    if (
      !object
      || object.size !== bytes.byteLength
      || !object.etag
      || r2Sha256Hex(object) !== fileSha256
      || object.customMetadata?.requestid !== original.id
      || object.customMetadata?.filesha256 !== fileSha256
      || object.customMetadata?.scopedigest !== original.scope_digest
    ) {
      failureCode = 'r2_write_integrity_mismatch'
      throw new Error('R2 response does not match generated file')
    }

    const readyVersion = generatingVersion + 1
    const readyAt = new Date().toISOString()
    const eventId = generateId('aexe')
    const auditId = generateId('audit')
    failureCode = 'database_finalize_failed'
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE app_audit_export_requests
        SET version = ?, status = 'ready', r2_key = ?, r2_etag = ?,
            file_sha256 = ?, file_size = ?, row_count = ?, generated_at = ?,
            expires_at = ?, failure_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'generating' AND version = ? AND generation_token = ?
          AND reviewed_by = ? AND reviewed_role_snapshot = 'owner'
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND role = ? AND status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND role = 'owner' AND status = 'active'
          )
      `).bind(
        readyVersion,
        r2Key,
        object.etag,
        fileSha256,
        bytes.byteLength,
        rows.length,
        generatedAt,
        expiresAt,
        readyAt,
        original.id,
        generatingVersion,
        generationToken,
        reviewer.id,
        original.requested_by,
        original.requested_role_snapshot,
        reviewer.id,
      ),
      exportEventInsertStatement(env.DB, {
        id: eventId,
        requestId: original.id,
        eventType: 'ready',
        actorId: reviewer.id,
        resultCode: 'file_ready',
        summary: { fileSha256, fileSize: bytes.byteLength, rowCount: rows.length, expiresAt },
        now: readyAt,
        guardVersion: readyVersion,
        guardUpdatedAt: readyAt,
      }),
      ...auditStatements(env.DB, {
        auditId,
        actorId: reviewer.id,
        action: 'app.audit.export.ready',
        targetType: 'app_audit_export_request',
        targetId: original.id,
        before: { status: 'generating', version: generatingVersion },
        after: { status: 'ready', version: readyVersion, fileSha256, fileSize: bytes.byteLength, rowCount: rows.length, expiresAt },
        requestContext,
        reasonCode: 'controlled_export_generated',
        businessReference: original.case_reference,
        targetVersion: String(readyVersion),
        approvalRequestId: original.id,
        capability: 'audit.export.generate',
        result: 'succeeded',
        now: readyAt,
        guardRequestId: original.id,
        guardVersion: readyVersion,
        guardUpdatedAt: readyAt,
      }),
    ])
    if (Number(results[0]?.meta.changes ?? 0) !== 1) throw new Error('request finalization conflict')
    return
  }
  catch (error) {
    if (uploaded) await env.R2.delete(r2Key).catch(() => undefined)
    await markGenerationFailed(
      env.DB,
      reviewer,
      original,
      generatingVersion,
      generationToken,
      failureCode,
      requestContext,
      new Date(),
    )
    throw error
  }
}

async function markGenerationFailed(
  db: D1Database,
  actor: ActorRow,
  original: ExportRequestRow,
  generatingVersion: number,
  generationToken: string,
  failureCode: string,
  requestContext: AdminAppAuditRequestContext,
  now: Date,
) {
  const failedVersion = generatingVersion + 1
  const nowIso = now.toISOString()
  const eventId = generateId('aexe')
  const auditId = generateId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_audit_export_requests
      SET version = ?, status = 'failed', failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'generating' AND version = ? AND generation_token = ?
    `).bind(failedVersion, failureCode, nowIso, original.id, generatingVersion, generationToken),
    exportEventInsertStatement(db, {
      id: eventId,
      requestId: original.id,
      eventType: 'generation_failed',
      actorId: actor.id,
      resultCode: failureCode,
      summary: { failureCode },
      now: nowIso,
      guardVersion: failedVersion,
      guardUpdatedAt: nowIso,
    }),
    ...auditStatements(db, {
      auditId,
      actorId: actor.id,
      action: 'app.audit.export.generation_failed',
      targetType: 'app_audit_export_request',
      targetId: original.id,
      before: { status: 'generating', version: generatingVersion },
      after: { status: 'failed', version: failedVersion, failureCode },
      requestContext,
      reasonCode: 'controlled_export_generation_failed',
      businessReference: original.case_reference,
      targetVersion: String(failedVersion),
      approvalRequestId: original.id,
      capability: 'audit.export.generate',
      result: 'failed',
      errorCode: failureCode,
      now: nowIso,
      guardRequestId: original.id,
      guardVersion: failedVersion,
      guardUpdatedAt: nowIso,
    }),
  ])
}

async function closeReadyRequest(
  db: D1Database,
  actor: ActorRow,
  current: ExportRequestRow,
  stepUpTokenHash: string,
  status: 'scope_changed' | 'failed',
  failureCode: string,
  observedScopeDigest: string,
  requestContext: AdminAppAuditRequestContext,
  now: Date,
) {
  const operationId = generateId('aexclose')
  const nextVersion = current.version + 1
  const nowIso = now.toISOString()
  const eventId = generateId('aexe')
  const auditId = generateId('audit')
  const results = await db.batch([
    db.prepare(`
      UPDATE app_audit_export_step_up_tokens
      SET consumed_at = ?, consumed_operation_id = ?
      WHERE token_hash = ? AND admin_id = ? AND action_scope = 'download_ticket'
        AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = 'active')
        AND EXISTS (
          SELECT 1 FROM app_audit_export_requests
          WHERE id = ? AND status = 'ready' AND version = ? AND requested_by = ?
        )
    `).bind(nowIso, operationId, stepUpTokenHash, actor.id, nowIso, actor.id, actor.role, current.id, current.version, actor.id),
    db.prepare(`
      UPDATE app_audit_export_requests
      SET version = ?, status = ?, failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'ready' AND version = ? AND requested_by = ?
        AND EXISTS (
          SELECT 1 FROM app_audit_export_step_up_tokens
          WHERE token_hash = ? AND admin_id = ? AND action_scope = 'download_ticket'
            AND consumed_operation_id = ? AND consumed_at = ?
        )
    `).bind(
      nextVersion,
      status,
      failureCode,
      nowIso,
      current.id,
      current.version,
      actor.id,
      stepUpTokenHash,
      actor.id,
      operationId,
      nowIso,
    ),
    exportEventInsertStatement(db, {
      id: eventId,
      requestId: current.id,
      eventType: status === 'scope_changed' ? 'scope_changed' : 'generation_failed',
      actorId: actor.id,
      resultCode: failureCode,
      summary: { failureCode, observedScopeDigest },
      now: nowIso,
      guardVersion: nextVersion,
      guardUpdatedAt: nowIso,
    }),
    ...auditStatements(db, {
      auditId,
      actorId: actor.id,
      action: status === 'scope_changed'
        ? 'app.audit.export.download_scope_changed'
        : 'app.audit.export.download_integrity_failed',
      targetType: 'app_audit_export_request',
      targetId: current.id,
      before: { status: 'ready', version: current.version },
      after: { status, version: nextVersion, failureCode, observedScopeDigest },
      requestContext,
      reasonCode: failureCode,
      businessReference: current.case_reference,
      targetVersion: String(nextVersion),
      approvalRequestId: current.id,
      capability: 'audit.export.download',
      result: status === 'scope_changed' ? 'denied' : 'failed',
      errorCode: failureCode,
      now: nowIso,
      guardRequestId: current.id,
      guardVersion: nextVersion,
      guardUpdatedAt: nowIso,
    }),
  ])
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_STEP_UP_INVALID', '密码验证凭证已失效，或导出状态已变化')
  }
}

async function invalidateReadyRequestByTicket(
  db: D1Database,
  actor: ActorRow,
  ticket: ExportTicketRow,
  requestContext: AdminAppAuditRequestContext,
  now: Date,
  failureCode: string,
) {
  const nowIso = now.toISOString()
  const consumedRequestId = normalizeRequestContextId(requestContext.requestId)
  const nextVersion = ticket.request_version + 1
  const eventId = generateId('aexe')
  const auditId = generateId('audit')
  const results = await db.batch([
    db.prepare(`
      UPDATE app_audit_export_download_tickets
      SET consumed_at = ?, consumed_request_id = ?
      WHERE id = ? AND created_for = ? AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = 'active')
        AND request_version = ? AND file_sha256_snapshot = ? AND scope_digest_snapshot = ?
    `).bind(
      nowIso,
      consumedRequestId,
      ticket.id,
      actor.id,
      nowIso,
      actor.id,
      ticket.created_for_role_snapshot,
      ticket.request_version,
      ticket.file_sha256_snapshot,
      ticket.scope_digest_snapshot,
    ),
    db.prepare(`
      UPDATE app_audit_export_requests
      SET version = ?, status = 'failed', failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'ready' AND version = ? AND requested_by = ?
        AND file_sha256 = ? AND scope_digest = ?
        AND EXISTS (
          SELECT 1 FROM app_audit_export_download_tickets
          WHERE id = ? AND consumed_request_id = ?
        )
    `).bind(
      nextVersion,
      failureCode,
      nowIso,
      ticket.request_id,
      ticket.request_version,
      actor.id,
      ticket.file_sha256_snapshot,
      ticket.scope_digest_snapshot,
      ticket.id,
      consumedRequestId,
    ),
    exportEventInsertStatement(db, {
      id: eventId,
      requestId: ticket.request_id,
      eventType: 'generation_failed',
      actorId: actor.id,
      resultCode: failureCode,
      summary: { ticketId: ticket.id, failureCode },
      now: nowIso,
      guardVersion: nextVersion,
      guardUpdatedAt: nowIso,
      consumedTicketId: ticket.id,
      consumedRequestId,
    }),
    ...auditStatements(db, {
      auditId,
      actorId: actor.id,
      action: 'app.audit.export.download_integrity_failed',
      targetType: 'app_audit_export_request',
      targetId: ticket.request_id,
      before: { status: 'ready', version: ticket.request_version },
      after: { status: 'failed', version: nextVersion, failureCode },
      requestContext,
      reasonCode: failureCode,
      targetVersion: String(nextVersion),
      approvalRequestId: ticket.request_id,
      capability: 'audit.export.download',
      result: 'failed',
      errorCode: failureCode,
      now: nowIso,
      guardRequestId: ticket.request_id,
      guardVersion: nextVersion,
      guardUpdatedAt: nowIso,
      consumedTicketId: ticket.id,
      consumedRequestId,
    }),
  ])
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_STATE_CHANGED', '导出状态已变化，请刷新后重试')
  }
}

async function snapshotPreparedScope(db: D1Database, prepared: AdminAppAuditPreparedQuery) {
  const result = await db.prepare(`
    SELECT audit_index.sequence, audit_index.audit_event_id
    FROM app_audit_event_index audit_index
    JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
    LEFT JOIN app_audit_event_contexts context ON context.audit_event_id = audit.id
    LEFT JOIN app_audit_production_action_registry registry ON registry.action_key = audit.action
    WHERE ${prepared.filters.conditions.join(' AND ')}
    ORDER BY audit_index.sequence ASC
    LIMIT ?
  `).bind(...prepared.filters.params, MAX_EXPORT_ROWS + 1).all<ExportScopeReferenceRow>()
  const references = result.results.map(row => ({
    sequence: Number(row.sequence),
    eventId: row.audit_event_id,
  }))
  const digest = await sha256Hex(stableStringify({
    scopeFingerprint: prepared.fingerprint,
    events: references,
  }))
  return { references, digest }
}

async function loadExportCsvRows(db: D1Database, prepared: AdminAppAuditPreparedQuery) {
  const result = await db.prepare(`
    SELECT audit_index.sequence,
           audit_index.audit_event_id,
           audit_index.actor_role_snapshot,
           audit_index.action_domain,
           audit_index.risk_level,
           COALESCE(context.result, audit_index.result) AS result,
           audit_index.occurred_at,
           audit.admin_id,
           audit.action,
           audit.target_type,
           audit.target_id,
           audit.before_value,
           audit.after_value,
           context.request_id,
           context.trace_id,
           context.reason_code,
           context.business_reference,
           context.target_version,
           context.approval_request_id,
           context.approval_step_id,
           context.policy_version,
           context.capability,
           context.scope_summary,
           context.error_code,
           registry.schema_version AS registry_schema_version,
           registry.display_name AS registry_display_name,
           registry.sensitivity AS registry_sensitivity
    FROM app_audit_event_index audit_index
    JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
    LEFT JOIN app_audit_event_contexts context ON context.audit_event_id = audit.id
    LEFT JOIN app_audit_production_action_registry registry ON registry.action_key = audit.action
    WHERE ${prepared.filters.conditions.join(' AND ')}
    ORDER BY audit_index.sequence ASC
    LIMIT ?
  `).bind(...prepared.filters.params, MAX_EXPORT_ROWS + 1).all<ExportCsvRow>()
  return result.results
}

async function buildControlledExportCsv(
  rows: ExportCsvRow[],
  metadata: {
    requestId: string
    generatedAt: string
    requesterId: number
    reviewerId: number
    purpose: string
    caseReference: string
    scopeDigest: string
  },
) {
  const watermark = [
    `request=${metadata.requestId}`,
    `generated=${metadata.generatedAt}`,
    `requester=${metadata.requesterId}`,
    `reviewer=${metadata.reviewerId}`,
    `purpose=${metadata.purpose}`,
    `case=${metadata.caseReference}`,
    `scope=${metadata.scopeDigest}`,
  ].join(';')
  const headers = [
    'watermark',
    'sequence',
    'event_id',
    'occurred_at',
    'actor_id',
    'actor_role',
    'action_domain',
    'action',
    'action_display_name',
    'registry_schema_version',
    'registry_sensitivity',
    'risk_level',
    'result',
    'target_type',
    'target_id',
    'request_id',
    'trace_id',
    'reason_code',
    'business_reference',
    'target_version',
    'approval_request_id',
    'approval_step_id',
    'policy_version',
    'capability',
    'scope_summary',
    'error_code',
    'before_state',
    'before_digest',
    'before_redacted_fields',
    'before_redacted_json',
    'after_state',
    'after_digest',
    'after_redacted_fields',
    'after_redacted_json',
  ]
  const lines = [headers.map(csvCell).join(',')]
  for (let offset = 0; offset < rows.length; offset += 100) {
    const chunk = rows.slice(offset, offset + 100)
    const redacted = await Promise.all(chunk.map(async row => ({
      row,
      before: await redactAdminAppAuditPayload(row.before_value),
      after: await redactAdminAppAuditPayload(row.after_value),
    })))
    for (const { row, before, after } of redacted) {
      lines.push([
        watermark,
        row.sequence,
        row.audit_event_id,
        row.occurred_at,
        row.admin_id,
        row.actor_role_snapshot,
        row.action_domain,
        row.action,
        safeAdminAppAuditContextValue(row.registry_display_name, 120),
        row.registry_schema_version,
        safeAdminAppAuditContextValue(row.registry_sensitivity, 40),
        row.risk_level,
        row.result,
        row.target_type,
        safeAdminAppAuditContextValue(row.target_id),
        safeAdminAppAuditContextValue(row.request_id),
        safeAdminAppAuditContextValue(row.trace_id),
        safeAdminAppAuditContextValue(row.reason_code, 120),
        safeAdminAppAuditContextValue(row.business_reference),
        safeAdminAppAuditContextValue(row.target_version),
        safeAdminAppAuditContextValue(row.approval_request_id),
        safeAdminAppAuditContextValue(row.approval_step_id),
        safeAdminAppAuditContextValue(row.policy_version),
        safeAdminAppAuditContextValue(row.capability, 120),
        safeAdminAppAuditContextValue(row.scope_summary, 1_000, true),
        safeAdminAppAuditContextValue(row.error_code, 120),
        before.state,
        before.digest,
        before.redactedFieldCount,
        before.value == null ? null : JSON.stringify(before.value),
        after.state,
        after.digest,
        after.redactedFieldCount,
        after.value == null ? null : JSON.stringify(after.value),
      ].map(csvCell).join(','))
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

function csvCell(value: unknown) {
  if (value == null) return ''
  let text = typeof value === 'string' ? value : String(value)
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function exportRequestSelect() {
  return `
    SELECT request.id, request.version, request.status, request.purpose,
           request.case_reference, request.request_explanation,
           request.range_from, request.range_to, request.scope_query_json,
           request.scope_fingerprint, request.scope_event_count,
           request.scope_first_sequence, request.scope_last_sequence, request.scope_digest,
           request.requested_by, request.requested_role_snapshot, request.requested_at,
           request.review_decision, request.review_reason_code, request.review_note,
           request.reviewed_by, request.reviewed_role_snapshot, request.reviewed_at,
           request.generation_token,
           request.r2_key, request.r2_etag, request.file_sha256, request.file_size,
           request.row_count, request.generated_at, request.expires_at,
           request.failure_code, request.created_at, request.updated_at,
           requester.email AS requester_email, requester.nickname AS requester_nickname,
           reviewer.email AS reviewer_email,
           reviewer.nickname AS reviewer_nickname
    FROM app_audit_export_requests request
    JOIN users requester ON requester.id = request.requested_by
    LEFT JOIN users reviewer ON reviewer.id = request.reviewed_by
  `
}

function ticketSelect() {
  return `
    SELECT ticket.id, ticket.request_id, ticket.request_version, ticket.created_for,
           ticket.created_for_role_snapshot,
           ticket.file_sha256_snapshot, ticket.scope_digest_snapshot,
           ticket.expires_at, ticket.consumed_at,
           request.status AS request_status, request.version AS request_current_version,
           request.scope_digest AS request_scope_digest,
           request.requested_by,
           request.expires_at AS request_expires_at, request.r2_key, request.r2_etag,
           request.file_sha256, request.file_size, request.row_count
    FROM app_audit_export_download_tickets ticket
    JOIN app_audit_export_requests request ON request.id = ticket.request_id
  `
}

async function requireExportRequest(db: D1Database, actor: ActorRow, requestId: string) {
  const row = await db.prepare(`
    ${exportRequestSelect()}
    WHERE request.id = ? AND (? = 'owner' OR request.requested_by = ?)
    LIMIT 1
  `).bind(requestId, actor.role, actor.id).first<ExportRequestRow>()
  if (!row) {
    throw new AdminAppAuditExportError(404, 'APP_AUDIT_EXPORT_NOT_FOUND', '导出申请不存在或不在当前授权范围')
  }
  return row
}

async function requireTicketById(db: D1Database, ticketId: string) {
  const row = await db.prepare(`
    ${ticketSelect()}
    WHERE ticket.id = ?
    LIMIT 1
  `).bind(ticketId).first<ExportTicketRow>()
  if (!row) throw new AdminAppAuditExportError(404, 'APP_AUDIT_EXPORT_TICKET_NOT_FOUND', '下载票据不存在')
  return row
}

function ensureTicketCanBeReturned(ticket: ExportTicketRow, actor: ActorRow, now: Date) {
  const nowMs = now.getTime()
  if (ticket.created_for !== actor.id || ticket.created_for_role_snapshot !== actor.role) {
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_TICKET_FORBIDDEN', '下载票据不属于当前账户')
  }
  if (ticket.consumed_at) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_TICKET_CONSUMED', '下载票据已使用')
  }
  if (new Date(ticket.expires_at).getTime() <= nowMs) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_TICKET_EXPIRED', '下载票据已过期，请重新申请')
  }
  if (
    ticket.request_status !== 'ready'
    || Number(ticket.request_current_version) !== Number(ticket.request_version)
    || ticket.requested_by !== actor.id
    || !ticket.request_expires_at
    || new Date(ticket.request_expires_at).getTime() <= nowMs
    || ticket.file_sha256 !== ticket.file_sha256_snapshot
    || ticket.request_scope_digest !== ticket.scope_digest_snapshot
  ) {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_NOT_READY', '导出状态或文件版本已变化')
  }
}

async function materializeDownloadTicket(secret: string, ticket: ExportTicketRow) {
  return {
    token: await buildDownloadToken(secret, {
      ticketId: ticket.id,
      requestId: ticket.request_id,
      createdFor: ticket.created_for,
      createdForRole: ticket.created_for_role_snapshot,
      expiresAt: ticket.expires_at,
    }),
    requestId: ticket.request_id,
    expiresAt: ticket.expires_at,
  }
}

async function buildDownloadToken(
  secret: string,
  input: { ticketId: string; requestId: string; createdFor: number; createdForRole: string; expiresAt: string },
) {
  const value = stableStringify(input)
  return `aedt.${input.ticketId}.${await hmacHex(secret, value)}`
}

function r2ObjectMatchesRequest(object: R2Object, request: ExportRequestRow) {
  return object.etag === request.r2_etag
    && object.size === Number(request.file_size)
    && r2Sha256Hex(object) === request.file_sha256
    && object.customMetadata?.requestid === request.id
    && object.customMetadata?.filesha256 === request.file_sha256
    && object.customMetadata?.scopedigest === request.scope_digest
}

function r2TicketObjectMatches(object: R2ObjectBody, ticket: ExportTicketRow) {
  return object.etag === ticket.r2_etag
    && object.size === Number(ticket.file_size)
    && r2Sha256Hex(object) === ticket.file_sha256_snapshot
    && object.customMetadata?.requestid === ticket.request_id
    && object.customMetadata?.filesha256 === ticket.file_sha256_snapshot
    && object.customMetadata?.scopedigest === ticket.scope_digest_snapshot
}

function r2Sha256Hex(object: Pick<R2Object, 'checksums'>) {
  const checksum = object.checksums.sha256
  if (!checksum) return null
  return Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, '0')).join('')
}

function mapExportRequest(row: ExportRequestRow, actor: ActorRow, now: Date): AdminAppAuditExportRequest {
  const status = effectiveStatus(row, now)
  const query = parseStoredScopeQuery(row.scope_query_json) as Omit<NormalizedAuditQuery, 'cursor' | 'limit'>
  return {
    requestId: row.id,
    version: Number(row.version),
    status,
    storedStatus: row.status,
    purpose: row.purpose,
    caseReference: row.case_reference,
    requestExplanation: row.request_explanation,
    range: { from: row.range_from, to: row.range_to },
    scope: {
      query,
      fingerprint: row.scope_fingerprint,
      digest: row.scope_digest,
      eventCount: Number(row.scope_event_count),
      firstSequence: Number(row.scope_first_sequence),
      lastSequence: Number(row.scope_last_sequence),
    },
    requester: {
      id: Number(row.requested_by),
      role: row.requested_role_snapshot,
      label: actorLabel(row.requester_email, row.requester_nickname, Number(row.requested_by)),
    },
    requestedAt: row.requested_at,
    review: row.review_decision && row.review_reason_code && row.review_note && row.reviewed_by && row.reviewed_at
      ? {
          decision: row.review_decision,
          reasonCode: row.review_reason_code,
          note: row.review_note,
          reviewer: {
            id: Number(row.reviewed_by),
            role: row.reviewed_role_snapshot || 'unknown',
            label: actorLabel(row.reviewer_email, row.reviewer_nickname, Number(row.reviewed_by)),
          },
          reviewedAt: row.reviewed_at,
        }
      : null,
    file: row.file_sha256 && row.file_size != null && row.row_count != null && row.generated_at && row.expires_at
      ? {
          available: status === 'ready',
          sha256: row.file_sha256,
          size: Number(row.file_size),
          rowCount: Number(row.row_count),
          generatedAt: row.generated_at,
          expiresAt: row.expires_at,
        }
      : null,
    failureCode: row.failure_code,
    canReview: actor.role === 'owner' && actor.id !== Number(row.requested_by) && row.status === 'pending_review',
    canDownload: actor.id === Number(row.requested_by) && status === 'ready',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapExportTimelineEvent(row: ExportEventRow): AdminAppAuditExportTimelineEvent {
  return {
    eventId: row.id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    actor: row.actor_type === 'admin' && row.actor_id
      ? {
          id: Number(row.actor_id),
          role: row.actor_role_snapshot || 'unknown',
          label: actorLabel(row.actor_email, row.actor_nickname, Number(row.actor_id)),
        }
      : null,
    resultCode: row.result_code,
    summary: parseSafeObject(row.safe_summary_json),
    createdAt: row.created_at,
  }
}

function effectiveStatus(row: ExportRequestRow, now: Date): AdminAppAuditExportStatus {
  if (row.status === 'ready' && row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return 'expired'
  return row.status
}

function exportEventInsertStatement(
  db: D1Database,
  input: {
    id: string
    requestId: string
    eventType: string
    actorId: number
    resultCode: string
    summary: Record<string, unknown>
    now: string
    guardVersion?: number
    guardUpdatedAt?: string
    requiredDecisionId?: string
    requiredTicketId?: string
    consumedTicketId?: string
    consumedRequestId?: string
  },
) {
  const conditions = ['request.id = ?']
  const params: unknown[] = [input.requestId]
  if (input.guardVersion !== undefined) {
    conditions.push('request.version = ?')
    params.push(input.guardVersion)
  }
  if (input.guardUpdatedAt) {
    conditions.push('request.updated_at = ?')
    params.push(input.guardUpdatedAt)
  }
  if (input.requiredDecisionId) {
    conditions.push('EXISTS (SELECT 1 FROM app_audit_export_review_decisions WHERE id = ?)')
    params.push(input.requiredDecisionId)
  }
  if (input.requiredTicketId) {
    conditions.push('EXISTS (SELECT 1 FROM app_audit_export_download_tickets WHERE id = ?)')
    params.push(input.requiredTicketId)
  }
  if (input.consumedTicketId) {
    conditions.push('EXISTS (SELECT 1 FROM app_audit_export_download_tickets WHERE id = ? AND consumed_request_id = ?)')
    params.push(input.consumedTicketId, input.consumedRequestId)
  }
  return db.prepare(`
    INSERT INTO app_audit_export_request_events (
      id, request_id, sequence, event_type, actor_type, actor_id, actor_role_snapshot,
      result_code, safe_summary_json, created_at
    )
    SELECT ?, request.id,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_audit_export_request_events WHERE request_id = request.id),
           ?, 'admin', ?, (SELECT role FROM users WHERE id = ?), ?, ?, ?
    FROM app_audit_export_requests request
    WHERE ${conditions.join(' AND ')}
  `).bind(
    input.id,
    input.eventType,
    input.actorId,
    input.actorId,
    input.resultCode,
    JSON.stringify(input.summary),
    input.now,
    ...params,
  )
}

function auditStatements(
  db: D1Database,
  input: {
    auditId: string
    actorId: number
    action: string
    targetType: string
    targetId: string | null
    before: unknown
    after: unknown
    requestContext: AdminAppAuditRequestContext
    idempotencyKeyHash?: string | null
    reasonCode?: string | null
    businessReference?: string | null
    targetVersion?: string | null
    approvalRequestId?: string | null
    approvalStepId?: string | null
    capability?: string | null
    scopeSummary?: string | null
    result: 'succeeded' | 'denied' | 'failed'
    errorCode?: string | null
    now: string
    guardRequestId?: string
    guardVersion?: number
    guardUpdatedAt?: string
    requiredDecisionId?: string
    requiredTicketId?: string
    consumedTicketId?: string
    consumedRequestId?: string
  },
): D1PreparedStatement[] {
  const guards: string[] = []
  const guardParams: unknown[] = []
  if (input.guardRequestId) {
    const versionCondition = input.guardVersion === undefined ? '' : ' AND version = ?'
    const updatedCondition = input.guardUpdatedAt === undefined ? '' : ' AND updated_at = ?'
    guards.push(`EXISTS (SELECT 1 FROM app_audit_export_requests WHERE id = ?${versionCondition}${updatedCondition})`)
    guardParams.push(input.guardRequestId)
    if (input.guardVersion !== undefined) guardParams.push(input.guardVersion)
    if (input.guardUpdatedAt !== undefined) guardParams.push(input.guardUpdatedAt)
  }
  if (input.requiredDecisionId) {
    guards.push('EXISTS (SELECT 1 FROM app_audit_export_review_decisions WHERE id = ?)')
    guardParams.push(input.requiredDecisionId)
  }
  if (input.requiredTicketId) {
    guards.push('EXISTS (SELECT 1 FROM app_audit_export_download_tickets WHERE id = ?)')
    guardParams.push(input.requiredTicketId)
  }
  if (input.consumedTicketId) {
    guards.push('EXISTS (SELECT 1 FROM app_audit_export_download_tickets WHERE id = ? AND consumed_request_id = ?)')
    guardParams.push(input.consumedTicketId, input.consumedRequestId)
  }
  const guardSql = guards.length ? ` WHERE ${guards.join(' AND ')}` : ''
  const scopeSummary = input.scopeSummary?.slice(0, 1_000) ?? null
  return [
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?${guardSql}
    `).bind(
      input.auditId,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.before == null ? null : JSON.stringify(input.before),
      input.after == null ? null : JSON.stringify(input.after),
      input.now,
      ...guardParams,
    ),
    db.prepare(`
      INSERT INTO app_audit_event_contexts (
        audit_event_id, request_id, trace_id, idempotency_key_hash,
        reason_code, business_reference, target_version,
        approval_request_id, approval_step_id, capability,
        scope_summary, result, error_code, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM admin_audit_logs WHERE id = ?
    `).bind(
      input.auditId,
      normalizeRequestContextId(input.requestContext.requestId),
      normalizeOptionalContextId(input.requestContext.traceId),
      input.idempotencyKeyHash ?? null,
      input.reasonCode?.slice(0, 120) ?? null,
      input.businessReference?.slice(0, 192) ?? null,
      input.targetVersion?.slice(0, 192) ?? null,
      input.approvalRequestId?.slice(0, 192) ?? null,
      input.approvalStepId?.slice(0, 192) ?? null,
      input.capability?.slice(0, 120) ?? null,
      scopeSummary,
      input.result,
      input.errorCode?.slice(0, 120) ?? null,
      input.now,
      input.auditId,
    ),
  ]
}

async function writeStandaloneAudit(
  db: D1Database,
  actor: ActorRow,
  action: string,
  targetType: string,
  targetId: string | null,
  before: unknown,
  after: unknown,
  requestContext: AdminAppAuditRequestContext,
  context: { capability: string; result: 'succeeded' | 'denied' | 'failed'; errorCode?: string },
  now: Date,
) {
  await db.batch(auditStatements(db, {
    auditId: generateId('audit'),
    actorId: actor.id,
    action,
    targetType,
    targetId,
    before,
    after,
    requestContext,
    reasonCode: context.result === 'denied' ? 'password_reauthentication_denied' : 'password_reauthenticated',
    capability: context.capability,
    result: context.result,
    errorCode: context.errorCode,
    now: now.toISOString(),
  }))
}

async function findExportCommand(
  db: D1Database,
  adminId: number,
  operation: 'request' | 'review' | 'download_ticket',
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_request_id, result_ticket_id
    FROM app_audit_export_commands
    WHERE admin_id = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(adminId, operation, idempotencyKey).first<ExportCommandRow>()
}

async function requireActiveAdmin(db: D1Database, adminId: number) {
  const actor = await db.prepare(`
    SELECT id, role, status, email, nickname
    FROM users
    WHERE id = ? AND role IN ('admin', 'owner') AND status = 'active'
    LIMIT 1
  `).bind(adminId).first<ActorRow>()
  if (!actor) throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_FORBIDDEN', '当前管理员无审计导出权限')
  return actor
}

async function requireActiveAdminWithPassword(db: D1Database, adminId: number) {
  const actor = await db.prepare(`
    SELECT id, role, status, email, nickname, password_hash
    FROM users
    WHERE id = ? AND role IN ('admin', 'owner') AND status = 'active'
    LIMIT 1
  `).bind(adminId).first<ActiveAdminWithPassword>()
  if (!actor) throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_FORBIDDEN', '当前管理员无审计导出权限')
  return actor
}

async function requireActiveOwner(db: D1Database, adminId: number) {
  const actor = await requireActiveAdmin(db, adminId)
  if (actor.role !== 'owner') {
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_OWNER_REQUIRED', '只有有效 Owner 可以复核审计导出')
  }
  return actor
}

function normalizeCreateInput(input: AdminAppAuditExportCreateInput) {
  const purpose = normalizePurpose(input.purpose)
  const caseReference = normalizeCaseReference(input.caseReference)
  const requestExplanation = normalizeText(input.requestExplanation, 'requestExplanation', 10, 500)
  if (!isPlainObject(input.query)) throw invalidField('query')
  const raw = input.query
  const from = normalizeDate(raw.from, 'query.from')
  const to = normalizeDate(raw.to, 'query.to')
  return {
    purpose,
    caseReference,
    requestExplanation,
    query: {
      from,
      to,
      action: canonicalOptionalValue(raw.action),
      domain: canonicalOptionalValue(raw.domain),
      riskLevel: canonicalOptionalValue(raw.riskLevel),
      result: canonicalOptionalValue(raw.result),
      targetType: canonicalOptionalValue(raw.targetType),
      targetId: canonicalOptionalValue(raw.targetId),
      actorId: canonicalOptionalValue(raw.actorId),
      requestId: canonicalOptionalValue(raw.requestId),
      traceId: canonicalOptionalValue(raw.traceId),
      businessReference: canonicalOptionalValue(raw.businessReference),
    },
  }
}

function normalizeReviewInput(input: AdminAppAuditExportReviewInput) {
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'expectedVersion')
  if (typeof input.decision !== 'string' || !REVIEW_DECISIONS.has(input.decision)) throw invalidField('decision')
  const decision = input.decision as AdminAppAuditExportReviewDecision
  if (typeof input.reasonCode !== 'string') throw invalidField('reasonCode')
  const validReasons = decision === 'approve' ? APPROVE_REASONS : REJECT_REASONS
  if (!validReasons.has(input.reasonCode)) throw invalidField('reasonCode')
  const note = normalizeText(input.note, 'note', 2, 500)
  return { expectedVersion, decision, reasonCode: input.reasonCode, note }
}

function normalizePurpose(value: unknown): AdminAppAuditPurpose {
  if (!['operational_investigation', 'security_review', 'financial_reconciliation', 'compliance_audit'].includes(String(value))) {
    throw invalidField('purpose')
  }
  return value as AdminAppAuditPurpose
}

function normalizeCaseReference(value: unknown) {
  if (typeof value !== 'string') throw invalidField('caseReference')
  const normalized = value.trim()
  if (!CASE_REFERENCE.test(normalized)) throw invalidField('caseReference')
  return normalized
}

function normalizeRequestId(value: string) {
  const normalized = value.trim()
  if (!EXPORT_REQUEST_ID.test(normalized)) throw invalidField('requestId')
  return normalized
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) throw invalidField('Idempotency-Key')
  return normalized
}

function normalizeStepUpToken(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!STEP_UP_TOKEN.test(normalized)) {
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_STEP_UP_REQUIRED', '请先重新验证当前账户密码')
  }
  return normalized
}

function normalizeDownloadToken(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!DOWNLOAD_TOKEN.test(normalized)) {
    throw new AdminAppAuditExportError(403, 'APP_AUDIT_EXPORT_DOWNLOAD_TICKET_REQUIRED', '缺少有效的一次性下载票据')
  }
  return normalized
}

function normalizeActionScope(value: unknown) {
  if (typeof value !== 'string' || !ACTION_SCOPES.has(value)) throw invalidField('actionScope')
  return value as AdminAppAuditExportActionScope
}

function normalizePassword(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw invalidField('password')
  return value
}

function normalizeOptionalStatus(value: unknown) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !EXPORT_STATUSES.has(value)) throw invalidField('status')
  return value as AdminAppAuditExportStatus
}

function normalizeLimit(value: unknown) {
  if (value == null || value === '') return 50
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw invalidField('limit')
  return parsed
}

function normalizePositiveInteger(value: unknown, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalidField(field)
  return parsed
}

function normalizeText(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') throw invalidField(field)
  const normalized = value.trim()
  const length = Array.from(normalized).length
  if (length < minimum || length > maximum) throw invalidField(field)
  return normalized
}

function normalizeDate(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw invalidField(field)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw invalidField(field)
  return parsed.toISOString()
}

function canonicalOptionalValue(value: unknown) {
  if (value == null || value === '') return null
  return typeof value === 'string' ? value.trim() : value
}

function invalidField(field: string) {
  return new AdminAppAuditExportError(400, 'APP_AUDIT_EXPORT_FIELD_INVALID', `${field} 格式错误`)
}

function parseStoredScopeQuery(value: string): AdminAppAuditListInput {
  try {
    const parsed = JSON.parse(value)
    if (!isPlainObject(parsed)) throw new Error('invalid scope')
    return parsed
  }
  catch {
    throw new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_SCOPE_INVALID', '申请保存的查询范围无法重新验证')
  }
}

function exportableQuery(query: NormalizedAuditQuery): Omit<NormalizedAuditQuery, 'cursor' | 'limit'> {
  return {
    purpose: query.purpose,
    from: query.from,
    to: query.to,
    action: query.action,
    domain: query.domain,
    riskLevel: query.riskLevel,
    result: query.result,
    targetType: query.targetType,
    targetId: query.targetId,
    actorId: query.actorId,
    requestId: query.requestId,
    traceId: query.traceId,
    businessReference: query.businessReference,
  }
}

function assertCommandHash(command: ExportCommandRow, expectedHash: string) {
  if (!constantTimeEqual(command.request_hash, expectedHash)) throw commandConflict()
}

function commandConflict() {
  return new AdminAppAuditExportError(409, 'APP_AUDIT_EXPORT_IDEMPOTENCY_CONFLICT', '幂等键已用于不同的审计导出操作')
}

function actorLabel(email: string | null, nickname: string | null, id: number) {
  return nickname?.trim() || email?.trim() || `管理员 #${id}`
}

function parseSafeObject(value: string) {
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRequestContextId(value: string) {
  const normalized = value.trim().slice(0, 192)
  return normalized || crypto.randomUUID()
}

function normalizeOptionalContextId(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.trim().slice(0, 192)
  return normalized || null
}

function randomHex(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

async function sha256Hex(value: string) {
  return sha256BytesHex(new TextEncoder().encode(value))
}

async function sha256BytesHex(value: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, value: string) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new AdminAppAuditExportError(503, 'APP_AUDIT_EXPORT_SIGNING_UNAVAILABLE', '下载票据签名服务尚未就绪')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
