import type { AppSafetyAppealStatus } from '@meigallery/shared'
import { AppSafetyError } from './app-safety'
import { requireSafetyAppealPolicy } from './app-safety-appeals'

const APPEAL_ID_PATTERN = /^apl_[A-Za-z0-9_-]{1,76}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const REASON_CODE_PATTERN = /^[a-z0-9_]{3,80}$/u
const FINAL_STATUSES = new Set(['upheld', 'changed', 'closed'])

export interface AdminSafetyAppealListQuery {
  status: 'open' | 'all' | 'submitted' | 'processing' | 'upheld' | 'changed' | 'closed'
  limit: number
}

export interface AdminSafetyAppealSummary {
  appealId: string
  reportId: string
  type: 'report_no_violation_review'
  status: AppSafetyAppealStatus
  userVisibleMessage: string
  originalReportVersion: number
  version: number
  assignedToMe: boolean
  canClaim: boolean
  isolationBlocked: boolean
  submittedAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface AdminSafetyAppealDetail extends AdminSafetyAppealSummary {
  statement: string
  report: {
    targetType: string
    profileId: string
    mediaId: string | null
    conversationId: string | null
    messageId: string | null
    reasonCode: string
    reasonLabel: string
    description: string
    status: string
    version: number
    evidence: {
      profileContentVersion: number | null
      profileProjectionVersion: number | null
      messageSequence: number | null
      messageSenderType: string | null
      messageBodySha256: string | null
      contextBeforeMessageId: string | null
      contextAfterMessageId: string | null
      evidenceDigest: string
      capturedAt: string
    }
  }
  timeline: Array<{
    sequence: number
    status: AppSafetyAppealStatus
    message: string
    createdAt: string
  }>
}

export interface AdminSafetyAppealDecisionInput {
  expectedVersion?: unknown
  outcome?: unknown
  reasonCode?: unknown
  userVisibleMessage?: unknown
}

type AppealRow = {
  id: string
  report_id: string
  appeal_type: string
  statement_text: string
  status: string
  user_visible_status: string
  user_visible_message: string
  original_report_version: number
  original_decision_admin_id: number
  assigned_admin_id: number | null
  version: number
  mutation_token: string | null
  submitted_at: string
  updated_at: string
  resolved_at: string | null
}

type AppealIdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
}

export function parseAdminSafetyAppealListQuery(input: {
  status?: string
  limit?: string
}): AdminSafetyAppealListQuery {
  const status = input.status ?? 'open'
  if (!['open', 'all', 'submitted', 'processing', 'upheld', 'changed', 'closed'].includes(status)) {
    throw new AppSafetyError(400, 'APPEAL_STATUS_INVALID', '申诉状态筛选无效')
  }
  const parsed = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 40
  return { status: status as AdminSafetyAppealListQuery['status'], limit }
}

export async function listAdminSafetyAppeals(
  db: D1Database,
  adminId: number,
  query: AdminSafetyAppealListQuery,
): Promise<AdminSafetyAppealSummary[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.status === 'open') {
    conditions.push("appeal.status IN ('submitted', 'triaged', 'investigating')")
  }
  else if (query.status !== 'all') {
    if (query.status === 'processing') conditions.push("appeal.user_visible_status = 'processing'")
    else conditions.push('appeal.user_visible_status = ?')
    if (query.status !== 'processing') params.push(query.status)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await db.prepare(`${APPEAL_SELECT}
    ${where}
    ORDER BY
      CASE WHEN appeal.assigned_admin_id = ? THEN 0 WHEN appeal.assigned_admin_id IS NULL THEN 1 ELSE 2 END,
      appeal.submitted_at ASC,
      appeal.id ASC
    LIMIT ?
  `).bind(...params, adminId, query.limit).all<AppealRow>()
  return rows.results.map(row => mapAppealSummary(row, adminId))
}

export async function claimAdminSafetyAppeal(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  policyId: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ appeal: AdminSafetyAppealSummary; replayed: boolean }> {
  await requireSafetyAppealPolicy(db, policyId, requireProductionReady)
  const appealId = normalizeAppealId(appealIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = adminScope(adminId)
  const requestHash = await hashCanonical({ appealId })
  const replay = await findAppealIdempotency(db, actorScope, 'appeal_claim', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: mapAppealSummary(await requireAppeal(db, appealId), adminId), replayed: true }
  }
  const appeal = await requireAppeal(db, appealId)
  if (appeal.original_decision_admin_id === adminId) {
    await writeDeniedAudit(db, adminId, appealId, 'moderation.appeal.claim_denied', 'reviewer_separation', now)
    throw new AppSafetyError(403, 'APPEAL_REVIEWER_SEPARATION_REQUIRED', '原举报审核人不能复核该申诉')
  }
  if (FINAL_STATUSES.has(appeal.status)) {
    throw new AppSafetyError(409, 'APPEAL_ALREADY_RESOLVED', '申诉已形成复核结论，不能重新领取')
  }
  if (appeal.assigned_admin_id && appeal.assigned_admin_id !== adminId) {
    throw new AppSafetyError(409, 'APPEAL_ASSIGNMENT_TAKEN', '该申诉已由其他复核人领取')
  }

  if (appeal.assigned_admin_id === adminId) {
    await bindAppealIdempotency(
      db, actorScope, 'appeal_claim', idempotencyKey, requestHash, appealId, appeal.version, now,
    )
    return { appeal: mapAppealSummary(appeal, adminId), replayed: false }
  }

  const nextVersion = Number(appeal.version) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const message = '复核申请正在由独立审核人员处理。'
  await db.batch([
    db.prepare(`
      UPDATE app_safety_appeals
      SET status = 'triaged', user_visible_status = 'processing',
          user_visible_message = ?, assigned_admin_id = ?, version = ?,
          mutation_token = ?, updated_at = ?
      WHERE id = ? AND status IN ('submitted', 'triaged', 'investigating')
        AND assigned_admin_id IS NULL AND version = ?
        AND original_decision_admin_id <> ?
    `).bind(message, adminId, nextVersion, mutationToken, nowIso, appealId, appeal.version, adminId),
    db.prepare(`
      INSERT INTO app_safety_appeal_events (
        id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
        event_type, status_from, status_to, reason_code,
        user_visible_status, user_visible_message, created_at
      )
      SELECT ?, id,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_safety_appeal_events WHERE appeal_id = ?),
             'admin', NULL, ?, 'claimed', ?, 'triaged', 'independent_reviewer_claimed',
             'processing', ?, ?
      FROM app_safety_appeals
      WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
    `).bind(
      prefixedId('ape'), appealId, adminId, appeal.status, message, nowIso,
      appealId, nextVersion, mutationToken, adminId,
    ),
    appealIdempotencySelectStatement(
      db, actorScope, 'appeal_claim', idempotencyKey, requestHash,
      appealId, nextVersion, mutationToken, nowIso,
    ),
    auditSelectStatement(
      db,
      adminId,
      'moderation.appeal.claim',
      appealId,
      JSON.stringify({ status: appeal.status, version: appeal.version, assigned: false }),
      JSON.stringify({ status: 'triaged', version: nextVersion, assigned: true }),
      nextVersion,
      mutationToken,
      nowIso,
    ),
  ])
  const persisted = await findAppealIdempotency(db, actorScope, 'appeal_claim', idempotencyKey)
  if (!persisted || persisted.result_version !== nextVersion) {
    throw new AppSafetyError(409, 'APPEAL_ASSIGNMENT_CONFLICT', '申诉分配状态已变化，请刷新后重试', true)
  }
  return { appeal: mapAppealSummary(await requireAppeal(db, appealId), adminId), replayed: false }
}

export async function getAdminSafetyAppeal(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  requestId: string,
  now = new Date(),
): Promise<AdminSafetyAppealDetail> {
  const appealId = normalizeAppealId(appealIdValue)
  const appeal = await requireAppeal(db, appealId)
  if (appeal.original_decision_admin_id === adminId || appeal.assigned_admin_id !== adminId) {
    await writeDeniedAudit(db, adminId, appealId, 'moderation.appeal.detail_denied', 'assignment_required', now)
    throw new AppSafetyError(403, 'APPEAL_ASSIGNMENT_REQUIRED', '请先由独立复核人领取申诉，再查看说明和证据')
  }
  const report = await db.prepare(`
    SELECT report.target_type, report.profile_id, report.media_id,
           report.conversation_id, report.message_id, report.reason_code,
           reason.display_label AS reason_label, report.description_text,
           report.status, report.version,
           evidence.profile_content_version, evidence.profile_projection_version,
           evidence.message_sequence, evidence.message_sender_type,
           evidence.message_body_sha256, evidence.context_before_message_id,
           evidence.context_after_message_id, evidence.evidence_digest,
           evidence.captured_at
    FROM app_safety_reports report
    JOIN app_safety_reason_definitions reason
      ON reason.catalog_id = report.reason_catalog_id AND reason.reason_code = report.reason_code
    JOIN app_safety_report_evidence evidence ON evidence.report_id = report.id
    WHERE report.id = ?
    LIMIT 1
  `).bind(appeal.report_id).first<{
    target_type: string
    profile_id: string
    media_id: string | null
    conversation_id: string | null
    message_id: string | null
    reason_code: string
    reason_label: string
    description_text: string
    status: string
    version: number
    profile_content_version: number | null
    profile_projection_version: number | null
    message_sequence: number | null
    message_sender_type: string | null
    message_body_sha256: string | null
    context_before_message_id: string | null
    context_after_message_id: string | null
    evidence_digest: string
    captured_at: string
  }>()
  if (!report) throw new AppSafetyError(503, 'APPEAL_EVIDENCE_NOT_READY', '申诉关联的最小证据尚未就绪', true)
  const events = await db.prepare(`
    SELECT sequence, user_visible_status, user_visible_message, created_at
    FROM app_safety_appeal_events
    WHERE appeal_id = ?
    ORDER BY sequence ASC
  `).bind(appealId).all<{
    sequence: number
    user_visible_status: string
    user_visible_message: string
    created_at: string
  }>()
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'moderation.appeal.detail_access', 'app_safety_appeal', ?, NULL, ?, ?)
  `).bind(
    crypto.randomUUID(), adminId, appealId,
    JSON.stringify({ requestId, purpose: 'appeal_review', reportId: appeal.report_id }),
    now.toISOString(),
  ).run()
  return {
    ...mapAppealSummary(appeal, adminId),
    statement: appeal.statement_text,
    report: {
      targetType: report.target_type,
      profileId: report.profile_id,
      mediaId: report.media_id,
      conversationId: report.conversation_id,
      messageId: report.message_id,
      reasonCode: report.reason_code,
      reasonLabel: report.reason_label,
      description: report.description_text,
      status: report.status,
      version: Number(report.version),
      evidence: {
        profileContentVersion: numberOrNull(report.profile_content_version),
        profileProjectionVersion: numberOrNull(report.profile_projection_version),
        messageSequence: numberOrNull(report.message_sequence),
        messageSenderType: report.message_sender_type,
        messageBodySha256: report.message_body_sha256,
        contextBeforeMessageId: report.context_before_message_id,
        contextAfterMessageId: report.context_after_message_id,
        evidenceDigest: report.evidence_digest,
        capturedAt: report.captured_at,
      },
    },
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      status: normalizeVisibleStatus(event.user_visible_status),
      message: event.user_visible_message,
      createdAt: event.created_at,
    })),
  }
}

export async function decideAdminSafetyAppeal(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  policyId: string,
  idempotencyKeyValue: string | null,
  input: AdminSafetyAppealDecisionInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ appeal: AdminSafetyAppealSummary; replayed: boolean }> {
  await requireSafetyAppealPolicy(db, policyId, requireProductionReady)
  const appealId = normalizeAppealId(appealIdValue)
  const decision = normalizeDecision(input)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = adminScope(adminId)
  const requestHash = await hashCanonical({ appealId, ...decision })
  const replay = await findAppealIdempotency(db, actorScope, 'appeal_decision', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: mapAppealSummary(await requireAppeal(db, appealId), adminId), replayed: true }
  }
  const appeal = await requireAppeal(db, appealId)
  if (appeal.original_decision_admin_id === adminId || appeal.assigned_admin_id !== adminId) {
    throw new AppSafetyError(403, 'APPEAL_ASSIGNMENT_REQUIRED', '只有已领取的独立复核人可以形成结论')
  }
  if (appeal.version !== decision.expectedVersion) {
    throw new AppSafetyError(409, 'APPEAL_VERSION_CONFLICT', '申诉已被更新，请刷新后重新确认')
  }
  if (FINAL_STATUSES.has(appeal.status)) {
    throw new AppSafetyError(409, 'APPEAL_ALREADY_RESOLVED', '申诉已形成复核结论')
  }

  const nextVersion = Number(appeal.version) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const statements: D1PreparedStatement[] = []
  let reportMutationToken: string | null = null
  if (decision.outcome === 'changed') {
    reportMutationToken = crypto.randomUUID()
    statements.push(db.prepare(`
      UPDATE app_safety_reports
      SET status = 'investigating', user_visible_status = 'processing',
          user_visible_message = ?, assigned_admin_id = ?, version = version + 1,
          mutation_token = ?, updated_at = ?, resolved_at = NULL
      WHERE id = ? AND status = 'no_violation' AND version = ?
        AND assigned_admin_id = ?
        AND EXISTS (
          SELECT 1
          FROM app_safety_appeals appeal_guard
          WHERE appeal_guard.id = ?
            AND appeal_guard.report_id = app_safety_reports.id
            AND appeal_guard.version = ?
            AND appeal_guard.assigned_admin_id = ?
            AND appeal_guard.status IN ('submitted', 'triaged', 'investigating')
        )
    `).bind(
      decision.userVisibleMessage,
      adminId,
      reportMutationToken,
      nowIso,
      appeal.report_id,
      appeal.original_report_version,
      appeal.original_decision_admin_id,
      appealId,
      appeal.version,
      adminId,
    ))
    statements.push(db.prepare(`
      INSERT INTO app_safety_report_events (
        id, report_id, sequence, actor_type, actor_account_id, actor_admin_id,
        event_type, status_from, status_to, reason_code,
        user_visible_status, user_visible_message, created_at
      )
      SELECT ?, id,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_safety_report_events WHERE report_id = ?),
             'admin', NULL, ?, 'investigating', 'no_violation', 'investigating',
             ?, 'processing', ?, ?
      FROM app_safety_reports
      WHERE id = ? AND status = 'investigating' AND mutation_token = ?
        AND assigned_admin_id = ?
    `).bind(
      prefixedId('rpe'), appeal.report_id, adminId, decision.reasonCode,
      decision.userVisibleMessage, nowIso, appeal.report_id, reportMutationToken, adminId,
    ))
  }
  const reportPrerequisite = decision.outcome === 'changed'
    ? 'AND EXISTS (SELECT 1 FROM app_safety_reports report WHERE report.id = app_safety_appeals.report_id AND report.status = \'investigating\' AND report.mutation_token = ? AND report.assigned_admin_id = ?)'
    : ''
  const appealUpdateParams: unknown[] = [
    decision.outcome,
    decision.outcome,
    decision.userVisibleMessage,
    nextVersion,
    mutationToken,
    nowIso,
    nowIso,
    appealId,
    appeal.version,
    adminId,
  ]
  if (reportMutationToken) appealUpdateParams.push(reportMutationToken, adminId)
  statements.push(db.prepare(`
    UPDATE app_safety_appeals
    SET status = ?, user_visible_status = ?, user_visible_message = ?,
        version = ?, mutation_token = ?, updated_at = ?, resolved_at = ?
    WHERE id = ? AND version = ? AND assigned_admin_id = ?
      AND status IN ('submitted', 'triaged', 'investigating')
      ${reportPrerequisite}
  `).bind(...appealUpdateParams))
  statements.push(db.prepare(`
    INSERT INTO app_safety_appeal_events (
      id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
      event_type, status_from, status_to, reason_code,
      user_visible_status, user_visible_message, created_at
    )
    SELECT ?, id,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_safety_appeal_events WHERE appeal_id = ?),
           'admin', NULL, ?, ?, ?, ?, ?, ?, ?, ?
    FROM app_safety_appeals
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    prefixedId('ape'), appealId, adminId, decision.outcome, appeal.status,
    decision.outcome, decision.reasonCode, decision.outcome,
    decision.userVisibleMessage, nowIso, appealId, nextVersion, mutationToken, adminId,
  ))
  statements.push(appealIdempotencySelectStatement(
    db, actorScope, 'appeal_decision', idempotencyKey, requestHash,
    appealId, nextVersion, mutationToken, nowIso,
  ))
  statements.push(auditSelectStatement(
    db,
    adminId,
    'moderation.appeal.decision',
    appealId,
    JSON.stringify({ status: appeal.status, version: appeal.version, reportId: appeal.report_id }),
    JSON.stringify({
      status: decision.outcome,
      version: nextVersion,
      reportReopened: decision.outcome === 'changed',
      reasonCode: decision.reasonCode,
      userVisibleMessageLength: decision.userVisibleMessage.length,
    }),
    nextVersion,
    mutationToken,
    nowIso,
  ))
  await db.batch(statements)
  const persisted = await findAppealIdempotency(db, actorScope, 'appeal_decision', idempotencyKey)
  if (!persisted || persisted.result_version !== nextVersion) {
    throw new AppSafetyError(409, 'APPEAL_DECISION_CONFLICT', '申诉或原举报状态已变化，请刷新后重试', true)
  }
  return { appeal: mapAppealSummary(await requireAppeal(db, appealId), adminId), replayed: false }
}

const APPEAL_SELECT = `
  SELECT appeal.id, appeal.report_id, appeal.appeal_type, appeal.statement_text,
         appeal.status, appeal.user_visible_status, appeal.user_visible_message,
         appeal.original_report_version, appeal.original_decision_admin_id,
         appeal.assigned_admin_id, appeal.version, appeal.mutation_token,
         appeal.submitted_at, appeal.updated_at, appeal.resolved_at
  FROM app_safety_appeals appeal
`

async function requireAppeal(db: D1Database, appealId: string): Promise<AppealRow> {
  const appeal = await db.prepare(`${APPEAL_SELECT} WHERE appeal.id = ? LIMIT 1`)
    .bind(appealId).first<AppealRow>()
  if (!appeal) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return appeal
}

function mapAppealSummary(row: AppealRow, adminId: number): AdminSafetyAppealSummary {
  const final = FINAL_STATUSES.has(row.status)
  return {
    appealId: row.id,
    reportId: row.report_id,
    type: 'report_no_violation_review',
    status: normalizeVisibleStatus(row.user_visible_status),
    userVisibleMessage: row.user_visible_message,
    originalReportVersion: Number(row.original_report_version),
    version: Number(row.version),
    assignedToMe: row.assigned_admin_id === adminId,
    canClaim: !final && row.assigned_admin_id === null && row.original_decision_admin_id !== adminId,
    isolationBlocked: !final && row.original_decision_admin_id === adminId,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  }
}

function normalizeDecision(input: AdminSafetyAppealDecisionInput) {
  if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
    throw new AppSafetyError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  if (input.outcome !== 'upheld' && input.outcome !== 'changed') {
    throw new AppSafetyError(400, 'APPEAL_OUTCOME_INVALID', '复核结论必须为 upheld 或 changed')
  }
  const reasonCode = typeof input.reasonCode === 'string' ? input.reasonCode.trim() : ''
  if (!REASON_CODE_PATTERN.test(reasonCode)) {
    throw new AppSafetyError(400, 'REASON_CODE_INVALID', '原因码必须为 3 至 80 位小写字母、数字或下划线')
  }
  const message = typeof input.userVisibleMessage === 'string' ? input.userVisibleMessage.trim() : ''
  if (!message || message.length > 300 || containsForbiddenControlCharacter(message)) {
    throw new AppSafetyError(400, 'USER_VISIBLE_MESSAGE_INVALID', '用户可见说明必须为 1 至 300 个字符且不能包含控制字符')
  }
  return {
    expectedVersion: Number(input.expectedVersion),
    outcome: input.outcome,
    reasonCode,
    userVisibleMessage: message,
  }
}

function containsForbiddenControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
  })
}

function normalizeAppealId(value: string): string {
  if (!APPEAL_ID_PATTERN.test(value)) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return value
}

function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

async function findAppealIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_id, result_version
    FROM app_safety_appeal_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<AppealIdempotencyRow>()
}

async function bindAppealIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  resultId: string,
  resultVersion: number,
  now: Date,
) {
  try {
    await db.prepare(`
      INSERT INTO app_safety_appeal_idempotency (
        actor_scope, operation, idempotency_key, request_hash,
        result_id, result_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      actorScope, operation, idempotencyKey, requestHash,
      resultId, resultVersion, now.toISOString(),
    ).run()
  }
  catch {
    const existing = await findAppealIdempotency(db, actorScope, operation, idempotencyKey)
    if (!existing) throw new AppSafetyError(409, 'APPEAL_ASSIGNMENT_CONFLICT', '申诉分配状态已变化')
    assertIdempotencyHash(existing, requestHash)
  }
}

function appealIdempotencySelectStatement(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  appealId: string,
  resultVersion: number,
  mutationToken: string,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_safety_appeal_idempotency (
      actor_scope, operation, idempotency_key, request_hash,
      result_id, result_version, created_at
    )
    SELECT ?, ?, ?, ?, id, version, ?
    FROM app_safety_appeals
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    actorScope, operation, idempotencyKey, requestHash, nowIso,
    appealId, resultVersion, mutationToken,
  )
}

function auditSelectStatement(
  db: D1Database,
  adminId: number,
  action: string,
  appealId: string,
  beforeValue: string,
  afterValue: string,
  version: number,
  mutationToken: string,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_safety_appeal', id, ?, ?, ?
    FROM app_safety_appeals
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    crypto.randomUUID(), adminId, action, beforeValue, afterValue, nowIso,
    appealId, version, mutationToken,
  )
}

async function writeDeniedAudit(
  db: D1Database,
  adminId: number,
  appealId: string,
  action: string,
  reason: string,
  now: Date,
) {
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, ?, 'app_safety_appeal', ?, NULL, ?, ?)
  `).bind(
    crypto.randomUUID(), adminId, action, appealId,
    JSON.stringify({ denied: true, reason }), now.toISOString(),
  ).run()
}

function assertIdempotencyHash(row: AppealIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同申诉操作')
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value))
}

function prefixedId(prefix: 'ape' | 'rpe') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function adminScope(adminId: number) {
  return `admin:${adminId}`
}

function normalizeVisibleStatus(value: string): AppSafetyAppealStatus {
  switch (value) {
    case 'submitted':
    case 'processing':
    case 'upheld':
    case 'changed':
    case 'closed':
      return value
    default:
      return 'processing'
  }
}

function numberOrNull(value: number | null) {
  return value === null ? null : Number(value)
}
