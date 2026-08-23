import type { AppAppealReviewState, AppSafetyAppealStatus, AppServiceAppealSourceType } from '@meigallery/shared'
import { AppSafetyError } from './app-safety'
import { requireSafetyAppealPolicy } from './app-safety-appeals'
import type { AdminSafetyAppealDecisionInput, AdminSafetyAppealListQuery } from './admin-app-safety-appeals'

const APPEAL_ID_PATTERN = /^bap_[A-Za-z0-9_-]{1,76}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const REASON_CODE_PATTERN = /^[a-z0-9_]{3,80}$/u
const FINAL_STATUSES = new Set(['upheld', 'changed', 'closed'])

export interface AdminServiceAppealSummary {
  appealId: string
  accountPublicId: string
  type: 'account_restriction_review' | 'wallet_entry_review'
  source: {
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

export interface AdminServiceAppealDetail extends AdminServiceAppealSummary {
  statement: string
  sourceSnapshotSha256: string
  sourceFacts: Record<string, string | number | null>
  supplements: Array<{ sequence: number; note: string; createdAt: string }>
  timeline: Array<{
    sequence: number
    status: AppSafetyAppealStatus
    message: string
    createdAt: string
  }>
}

type AppealRow = {
  id: string
  account_public_id: string
  source_type: string
  source_id: string
  source_version: string
  source_reference: string
  source_label: string
  source_snapshot_json: string
  source_snapshot_sha256: string
  original_decision_admin_id: number | null
  statement_text: string
  status: string
  review_state: string
  user_visible_status: string
  user_visible_message: string
  assigned_admin_id: number | null
  version: number
  mutation_token: string | null
  submitted_at: string
  updated_at: string
  review_due_at: string | null
  supplement_due_at: string | null
  resolved_at: string | null
}

type IdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
}

export async function listAdminServiceAppeals(
  db: D1Database,
  adminId: number,
  query: AdminSafetyAppealListQuery,
): Promise<AdminServiceAppealSummary[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.status === 'open') {
    conditions.push("appeal.status IN ('submitted', 'triaged', 'investigating')")
  }
  else if (query.status !== 'all') {
    if (query.status === 'processing') conditions.push("appeal.user_visible_status = 'processing'")
    else {
      conditions.push('appeal.user_visible_status = ?')
      params.push(query.status)
    }
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
  return rows.results.map(row => mapSummary(row, adminId))
}

export async function claimAdminServiceAppeal(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  policyId: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ appeal: AdminServiceAppealSummary; replayed: boolean }> {
  await requireSafetyAppealPolicy(db, policyId, requireProductionReady)
  const appealId = normalizeAppealId(appealIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = adminScope(adminId)
  const requestHash = await hashCanonical({ appealId })
  const replay = await findIdempotency(db, actorScope, 'appeal_claim', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: mapSummary(await requireAppeal(db, appealId), adminId), replayed: true }
  }

  const appeal = await requireAppeal(db, appealId)
  if (appeal.original_decision_admin_id === adminId) {
    await writeDeniedAudit(db, adminId, appealId, 'moderation.service_appeal.claim_denied', 'reviewer_separation', now)
    throw new AppSafetyError(403, 'APPEAL_REVIEWER_SEPARATION_REQUIRED', '原业务审核人不能复核该申诉')
  }
  if (FINAL_STATUSES.has(appeal.status)) {
    throw new AppSafetyError(409, 'APPEAL_ALREADY_RESOLVED', '申诉已形成复核结论，不能重新领取')
  }
  if (appeal.assigned_admin_id && appeal.assigned_admin_id !== adminId) {
    throw new AppSafetyError(409, 'APPEAL_ASSIGNMENT_TAKEN', '该申诉已由其他复核人领取')
  }
  if (appeal.assigned_admin_id === adminId) {
    await bindIdempotency(
      db,
      actorScope,
      'appeal_claim',
      idempotencyKey,
      requestHash,
      appealId,
      appeal.version,
      now,
    )
    return { appeal: mapSummary(appeal, adminId), replayed: false }
  }

  const nextVersion = Number(appeal.version) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const message = '申诉正在由独立审核人员处理；原业务状态尚未自动改变。'
  await db.batch([
    db.prepare(`
      UPDATE app_service_appeals
      SET status = 'triaged', user_visible_status = 'processing',
          user_visible_message = ?, assigned_admin_id = ?, version = ?,
          mutation_token = ?, updated_at = ?
      WHERE id = ? AND status IN ('submitted', 'triaged', 'investigating')
        AND assigned_admin_id IS NULL AND version = ?
        AND (original_decision_admin_id IS NULL OR original_decision_admin_id <> ?)
    `).bind(message, adminId, nextVersion, mutationToken, nowIso, appealId, appeal.version, adminId),
    db.prepare(`
      INSERT INTO app_service_appeal_events (
        id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
        event_type, status_from, status_to, review_state_from, review_state_to, reason_code,
        user_visible_status, user_visible_message, created_at
      )
      SELECT ?, id,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_service_appeal_events WHERE appeal_id = ?),
             'admin', NULL, ?, 'claimed', ?, 'triaged', ?, ?, 'independent_reviewer_claimed',
             'processing', ?, ?
      FROM app_service_appeals
      WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
    `).bind(
      prefixedId(), appealId, adminId, appeal.status,
      appeal.review_state, appeal.review_state, message, nowIso,
      appealId, nextVersion, mutationToken, adminId,
    ),
    idempotencySelectStatement(
      db,
      actorScope,
      'appeal_claim',
      idempotencyKey,
      requestHash,
      appealId,
      nextVersion,
      mutationToken,
      nowIso,
    ),
    auditSelectStatement(
      db,
      adminId,
      'moderation.service_appeal.claim',
      appealId,
      JSON.stringify({ status: appeal.status, version: appeal.version, assigned: false }),
      JSON.stringify({ status: 'triaged', version: nextVersion, assigned: true }),
      nextVersion,
      mutationToken,
      nowIso,
    ),
  ])
  const persisted = await findIdempotency(db, actorScope, 'appeal_claim', idempotencyKey)
  if (!persisted || persisted.result_version !== nextVersion) {
    throw new AppSafetyError(409, 'APPEAL_ASSIGNMENT_CONFLICT', '申诉分配状态已变化，请刷新后重试', true)
  }
  return { appeal: mapSummary(await requireAppeal(db, appealId), adminId), replayed: false }
}

export async function getAdminServiceAppeal(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  requestId: string,
  now = new Date(),
): Promise<AdminServiceAppealDetail> {
  const appealId = normalizeAppealId(appealIdValue)
  const appeal = await requireAppeal(db, appealId)
  if (appeal.original_decision_admin_id === adminId || appeal.assigned_admin_id !== adminId) {
    await writeDeniedAudit(db, adminId, appealId, 'moderation.service_appeal.detail_denied', 'assignment_required', now)
    throw new AppSafetyError(403, 'APPEAL_ASSIGNMENT_REQUIRED', '请先由独立复核人领取申诉，再查看说明与业务快照')
  }
  const events = await db.prepare(`
    SELECT ROW_NUMBER() OVER (ORDER BY created_at ASC, event_id ASC) AS sequence,
           user_visible_status, user_visible_message, created_at
    FROM (
      SELECT id AS event_id, user_visible_status, user_visible_message, created_at
      FROM app_service_appeal_events
      WHERE appeal_id = ?
      UNION ALL
      SELECT id AS event_id, 'processing' AS user_visible_status,
             user_visible_message, created_at
      FROM app_appeal_review_events
      WHERE appeal_kind = 'service' AND appeal_id = ?
    ) timeline
    ORDER BY created_at ASC, event_id ASC
  `).bind(appealId, appealId).all<{
    sequence: number
    user_visible_status: string
    user_visible_message: string
    created_at: string
  }>()
  const supplements = await db.prepare(`
    SELECT sequence, note_text, created_at
    FROM app_service_appeal_supplements
    WHERE appeal_id = ? ORDER BY sequence ASC
  `).bind(appealId).all<{
    sequence: number
    note_text: string
    created_at: string
  }>()
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'moderation.service_appeal.detail_access', 'app_service_appeal', ?, NULL, ?, ?)
  `).bind(
    crypto.randomUUID(),
    adminId,
    appealId,
    JSON.stringify({ requestId, purpose: 'appeal_review', sourceType: appeal.source_type }),
    now.toISOString(),
  ).run()
  return {
    ...mapSummary(appeal, adminId),
    statement: appeal.statement_text,
    sourceSnapshotSha256: appeal.source_snapshot_sha256,
    sourceFacts: safeSourceFacts(appeal),
    supplements: supplements.results.map(item => ({
      sequence: Number(item.sequence),
      note: item.note_text,
      createdAt: item.created_at,
    })),
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      status: normalizeVisibleStatus(event.user_visible_status),
      message: event.user_visible_message,
      createdAt: event.created_at,
    })),
  }
}

export async function decideAdminServiceAppeal(
  db: D1Database,
  adminId: number,
  appealIdValue: string,
  policyId: string,
  idempotencyKeyValue: string | null,
  input: AdminSafetyAppealDecisionInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ appeal: AdminServiceAppealSummary; replayed: boolean }> {
  await requireSafetyAppealPolicy(db, policyId, requireProductionReady)
  const appealId = normalizeAppealId(appealIdValue)
  const decision = normalizeDecision(input)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = adminScope(adminId)
  const requestHash = await hashCanonical({ appealId, ...decision })
  const replay = await findIdempotency(db, actorScope, 'appeal_decision', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { appeal: mapSummary(await requireAppeal(db, appealId), adminId), replayed: true }
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
  if (appeal.review_state === 'evidence_insufficient') {
    throw new AppSafetyError(409, 'APPEAL_EVIDENCE_INSUFFICIENT', '请等待用户补充必要说明后再形成结论')
  }
  if (appeal.review_state === 'needs_escalation') {
    throw new AppSafetyError(409, 'APPEAL_ESCALATION_REQUIRED', '该申诉需要升级复核，当前复核人不能直接形成结论')
  }

  const nextVersion = Number(appeal.version) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_service_appeals
      SET status = ?, user_visible_status = ?, user_visible_message = ?,
          review_state = 'normal', supplement_due_at = NULL,
          version = ?, mutation_token = ?, updated_at = ?, resolved_at = ?
      WHERE id = ? AND version = ? AND assigned_admin_id = ?
        AND status IN ('submitted', 'triaged', 'investigating')
        AND (original_decision_admin_id IS NULL OR original_decision_admin_id <> ?)
    `).bind(
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
      adminId,
    ),
    db.prepare(`
      INSERT INTO app_service_appeal_events (
        id, appeal_id, sequence, actor_type, actor_account_id, actor_admin_id,
        event_type, status_from, status_to, review_state_from, review_state_to, reason_code,
        user_visible_status, user_visible_message, created_at
      )
      SELECT ?, id,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_service_appeal_events WHERE appeal_id = ?),
             'admin', NULL, ?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?
      FROM app_service_appeals
      WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
    `).bind(
      prefixedId(),
      appealId,
      adminId,
      decision.outcome,
      appeal.status,
      decision.outcome,
      appeal.review_state,
      decision.reasonCode,
      decision.outcome,
      decision.userVisibleMessage,
      nowIso,
      appealId,
      nextVersion,
      mutationToken,
      adminId,
    ),
    idempotencySelectStatement(
      db,
      actorScope,
      'appeal_decision',
      idempotencyKey,
      requestHash,
      appealId,
      nextVersion,
      mutationToken,
      nowIso,
    ),
    auditSelectStatement(
      db,
      adminId,
      'moderation.service_appeal.decision',
      appealId,
      JSON.stringify({ status: appeal.status, version: appeal.version, sourceType: appeal.source_type }),
      JSON.stringify({
        status: decision.outcome,
        version: nextVersion,
        reasonCode: decision.reasonCode,
        sourceMutated: false,
        followUpRequired: decision.outcome === 'changed',
        userVisibleMessageLength: decision.userVisibleMessage.length,
      }),
      nextVersion,
      mutationToken,
      nowIso,
    ),
  ])
  const persisted = await findIdempotency(db, actorScope, 'appeal_decision', idempotencyKey)
  if (!persisted || persisted.result_version !== nextVersion) {
    throw new AppSafetyError(409, 'APPEAL_DECISION_CONFLICT', '申诉状态已变化，请刷新后重试', true)
  }
  return { appeal: mapSummary(await requireAppeal(db, appealId), adminId), replayed: false }
}

const APPEAL_SELECT = `
  SELECT appeal.id, security.account_public_id,
         appeal.source_type, appeal.source_id, appeal.source_version,
         appeal.source_reference, appeal.source_label, appeal.source_snapshot_json,
         appeal.source_snapshot_sha256, appeal.original_decision_admin_id,
         appeal.statement_text, appeal.status, appeal.review_state, appeal.user_visible_status,
         appeal.user_visible_message, appeal.assigned_admin_id, appeal.version,
         appeal.mutation_token, appeal.submitted_at, appeal.updated_at,
         appeal.review_due_at, appeal.supplement_due_at, appeal.resolved_at
  FROM app_service_appeals appeal
  INNER JOIN app_account_security security ON security.account_id = appeal.account_id
`

async function requireAppeal(db: D1Database, appealId: string): Promise<AppealRow> {
  const appeal = await db.prepare(`${APPEAL_SELECT} WHERE appeal.id = ? LIMIT 1`)
    .bind(appealId).first<AppealRow>()
  if (!appeal) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return appeal
}

function mapSummary(row: AppealRow, adminId: number): AdminServiceAppealSummary {
  const sourceType = normalizeStoredSourceType(row.source_type)
  const final = FINAL_STATUSES.has(row.status)
  const reviewDueAtMs = row.review_due_at ? Date.parse(row.review_due_at) : Number.NaN
  return {
    appealId: row.id,
    accountPublicId: row.account_public_id,
    type: sourceType === 'account_restriction' ? 'account_restriction_review' : 'wallet_entry_review',
    source: {
      type: sourceType,
      sourceId: row.source_id,
      sourceVersion: row.source_version,
      reference: row.source_reference,
      label: row.source_label,
    },
    status: normalizeVisibleStatus(row.user_visible_status),
    workflowStatus: row.status,
    reviewState: normalizeReviewState(row.review_state),
    userVisibleMessage: row.user_visible_message,
    version: Number(row.version),
    assignedToMe: row.assigned_admin_id === adminId,
    canClaim: !final && row.assigned_admin_id === null && row.original_decision_admin_id !== adminId,
    isolationBlocked: !final && row.original_decision_admin_id === adminId,
    overdue: !final && Number.isFinite(reviewDueAtMs) && reviewDueAtMs < Date.now(),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    reviewDueAt: row.review_due_at,
    supplementDueAt: row.supplement_due_at,
    resolvedAt: row.resolved_at,
  }
}

function safeSourceFacts(row: AppealRow): Record<string, string | number | null> {
  let value: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.source_snapshot_json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    value = parsed as Record<string, unknown>
  }
  catch {
    throw new AppSafetyError(503, 'APPEAL_SOURCE_SNAPSHOT_INVALID', '申诉来源快照无法安全读取', true)
  }
  if (row.source_type === 'account_restriction') {
    return {
      status: stringOrNull(value.status),
      reasonCategory: stringOrNull(value.reasonCategory),
      restrictedUntil: stringOrNull(value.restrictedUntil),
    }
  }
  return {
    actionType: stringOrNull(value.actionType),
    direction: stringOrNull(value.direction),
    amount: numberOrNull(value.amount),
    reasonCode: stringOrNull(value.reasonCode),
    userVisibleNote: stringOrNull(value.userVisibleNote),
    balanceBefore: numberOrNull(value.balanceBefore),
    balanceAfter: numberOrNull(value.balanceAfter),
    postedAt: stringOrNull(value.postedAt),
    originalEntryId: stringOrNull(value.originalEntryId),
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
  const userVisibleMessage = typeof input.userVisibleMessage === 'string'
    ? input.userVisibleMessage.trim()
    : ''
  if (!userVisibleMessage || userVisibleMessage.length > 300 || containsControl(userVisibleMessage)) {
    throw new AppSafetyError(400, 'USER_VISIBLE_MESSAGE_INVALID', '用户可见说明必须为 1 至 300 个字符且不能包含控制字符')
  }
  return {
    expectedVersion: Number(input.expectedVersion),
    outcome: input.outcome,
    reasonCode,
    userVisibleMessage,
  }
}

function normalizeAppealId(value: string) {
  if (!APPEAL_ID_PATTERN.test(value)) throw new AppSafetyError(404, 'APPEAL_NOT_FOUND', '申诉不存在')
  return value
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

function normalizeStoredSourceType(value: string): AppServiceAppealSourceType {
  if (value === 'account_restriction' || value === 'wallet_entry') return value
  throw new AppSafetyError(503, 'APPEAL_DATA_INVALID', '申诉来源类型异常', true)
}

function normalizeVisibleStatus(value: string): AppSafetyAppealStatus {
  if (value === 'submitted' || value === 'processing' || value === 'upheld' || value === 'changed' || value === 'closed') {
    return value
  }
  return 'processing'
}

function normalizeReviewState(value: string): AppAppealReviewState {
  if (value === 'normal' || value === 'evidence_insufficient' || value === 'needs_escalation') return value
  return 'normal'
}

async function findIdempotency(db: D1Database, actorScope: string, operation: string, key: string) {
  return db.prepare(`
    SELECT request_hash, result_id, result_version
    FROM app_service_appeal_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, key).first<IdempotencyRow>()
}

async function bindIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  key: string,
  requestHash: string,
  appealId: string,
  version: number,
  now: Date,
) {
  try {
    await db.prepare(`
      INSERT INTO app_service_appeal_idempotency (
        actor_scope, operation, idempotency_key, request_hash,
        result_id, result_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(actorScope, operation, key, requestHash, appealId, version, now.toISOString()).run()
  }
  catch {
    const existing = await findIdempotency(db, actorScope, operation, key)
    if (!existing) throw new AppSafetyError(409, 'APPEAL_ASSIGNMENT_CONFLICT', '申诉分配状态已变化')
    assertIdempotencyHash(existing, requestHash)
  }
}

function idempotencySelectStatement(
  db: D1Database,
  actorScope: string,
  operation: string,
  key: string,
  requestHash: string,
  appealId: string,
  version: number,
  mutationToken: string,
  nowIso: string,
) {
  return db.prepare(`
    INSERT INTO app_service_appeal_idempotency (
      actor_scope, operation, idempotency_key, request_hash,
      result_id, result_version, created_at
    )
    SELECT ?, ?, ?, ?, id, version, ?
    FROM app_service_appeals
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(actorScope, operation, key, requestHash, nowIso, appealId, version, mutationToken)
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
    SELECT ?, ?, ?, 'app_service_appeal', id, ?, ?, ?
    FROM app_service_appeals
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
    ) VALUES (?, ?, ?, 'app_service_appeal', ?, NULL, ?, ?)
  `).bind(
    crypto.randomUUID(), adminId, action, appealId,
    JSON.stringify({ denied: true, reason }), now.toISOString(),
  ).run()
}

function assertIdempotencyHash(row: IdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同申诉操作')
  }
}

function containsControl(value: string) {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point === 0x7f || (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d)
  })
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 500) : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function hashCanonical(value: unknown) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function prefixedId() {
  return `bae_${crypto.randomUUID().replace(/-/gu, '')}`
}

function adminScope(adminId: number) {
  return `admin:${adminId}`
}
