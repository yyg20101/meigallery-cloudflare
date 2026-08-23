export type AppMessageModerationStatus = 'accepted' | 'review_pending' | 'rejected'
export type AppMessageModerationSenderType = 'viewer' | 'platform_operator'
export type AppMessageModerationCaseStatus = 'pending' | 'in_review' | 'accepted' | 'rejected' | 'cancelled'

export interface AppMessageModerationRuntimeContext {
  policyId: string | null
  requireProductionReady: boolean
}

export interface AppMessageModerationEvaluation {
  status: AppMessageModerationStatus
  policyId: string | null
  ruleId: string | null
  reasonCode: string
  evaluationId: string | null
  caseId: string | null
  evaluatedAt: string
}

export interface AdminAppMessageModerationCaseListQuery {
  status: AppMessageModerationCaseStatus | null
  limit: number
}

export interface AdminAppMessageModerationCaseSummary {
  caseId: string
  status: AppMessageModerationCaseStatus
  version: number
  conversationId: string
  messageId: string
  messageStatus: AppMessageModerationStatus
  senderType: AppMessageModerationSenderType
  policyId: string
  ruleId: string | null
  reasonCode: string
  decisionReasonCode: string | null
  bodySha256: string
  bodyLength: number
  accountId: string
  profileId: string
  profileDisplayName: string
  assignment: {
    state: 'unassigned' | 'mine' | 'other'
    assignedAdminId: number | null
    leaseExpiresAt: string | null
    canClaim: boolean
  }
  createdAt: string
  updatedAt: string
  decidedAt: string | null
}

export interface AdminAppMessageModerationCaseDetail extends AdminAppMessageModerationCaseSummary {
  accessReason: 'message_moderation_review'
  clientMessageId: string
  text: string
  messageCreatedAt: string
}

export interface AdminAppMessageModerationClaimInput {
  expectedVersion?: unknown
}

export interface AdminAppMessageModerationDecisionInput {
  expectedVersion?: unknown
  decision?: unknown
  reasonCode?: unknown
}

export interface AdminAppMessageModerationClaimResult {
  caseId: string
  status: 'in_review'
  version: number
  assignedAdminId: number
  leaseExpiresAt: string
  replayed: boolean
}

export interface AdminAppMessageModerationDecisionResult {
  caseId: string
  status: 'accepted' | 'rejected'
  version: number
  conversationId: string
  messageId: string
  messageStatus: 'accepted' | 'rejected'
  autoAssignmentEligible: boolean
  replayed: boolean
}

export async function cancelPendingAppMessageModerationCasesForAccount(
  db: D1Database,
  accountId: number,
  now = new Date(),
): Promise<{ available: boolean }> {
  const schema = await db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'app_message_moderation_cases'
    LIMIT 1
  `).first<{ present: number }>()
  if (!schema) return { available: false }
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      DELETE FROM app_message_moderation_idempotency
      WHERE case_id IN (
        SELECT review_case.id
        FROM app_message_moderation_cases review_case
        JOIN app_conversations conversation ON conversation.id = review_case.conversation_id
        WHERE conversation.account_id = ?
      )
    `).bind(accountId),
    db.prepare(`
      UPDATE app_message_moderation_cases
      SET status = 'cancelled', version = version + 1,
          assigned_admin_id = NULL, reviewed_by = NULL,
          decision_reason_code = 'account_deletion', lease_expires_at = NULL,
          decided_at = ?, updated_at = ?
      WHERE status IN ('pending', 'in_review')
        AND conversation_id IN (SELECT id FROM app_conversations WHERE account_id = ?)
    `).bind(nowIso, nowIso, accountId),
    db.prepare(`
      INSERT INTO app_message_moderation_case_events (
        id, case_id, event_type, actor_admin_id, from_version,
        to_version, reason_code, created_at
      )
      SELECT 'mmce_' || lower(hex(randomblob(16))), review_case.id, 'cancelled', NULL,
             review_case.version - 1, review_case.version,
             'account_deletion', ?
      FROM app_message_moderation_cases review_case
      JOIN app_conversations conversation ON conversation.id = review_case.conversation_id
      WHERE conversation.account_id = ?
        AND review_case.status = 'cancelled'
        AND review_case.decision_reason_code = 'account_deletion'
        AND NOT EXISTS (
          SELECT 1 FROM app_message_moderation_case_events event
          WHERE event.case_id = review_case.id AND event.to_version = review_case.version
        )
    `).bind(nowIso, accountId),
  ])
  return { available: true }
}

export class AppMessageModerationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppMessageModerationError'
  }
}

type ModerationPolicyRow = {
  id: string
  state: string
  production_ready: number
  decision_status: string
  evaluation_enabled: number
  default_action: string
  effective_at: string | null
}

type ModerationRuleRow = {
  id: string
  actor_scope: string
  match_type: string
  normalized_pattern: string | null
  action: string
  reason_code: string
  priority: number
}

type ModerationCaseRow = {
  id: string
  status: string
  version: number
  evaluation_id: string
  conversation_id: string
  message_id: string
  message_status: string
  sender_type: string
  actor_admin_id: number | null
  policy_id: string
  rule_id: string | null
  reason_code: string
  decision_reason_code: string | null
  body_sha256: string
  body_length: number
  assigned_admin_id: number | null
  lease_expires_at: string | null
  created_at: string
  updated_at: string
  decided_at: string | null
  account_public_id: string
  profile_id: string
  profile_display_name: string
}

type ModerationCaseDetailRow = ModerationCaseRow & {
  client_message_id: string
  body_text: string
  message_created_at: string
}

type ModerationIdempotencyRow = {
  request_hash: string
  result_json: string
}

type StoredClaimResult = Omit<AdminAppMessageModerationClaimResult, 'replayed'>
type StoredDecisionResult = Omit<AdminAppMessageModerationDecisionResult, 'replayed' | 'autoAssignmentEligible'>

const POLICY_ID_PATTERN = /^mmp_[A-Za-z0-9_-]{1,76}$/u
const CASE_ID_PATTERN = /^mmc_[A-Za-z0-9_-]{1,92}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_]{1,79}$/u
const DEFAULT_CASE_LIST_SIZE = 40
const MAX_CASE_LIST_SIZE = 100
const REVIEW_LEASE_MS = 10 * 60 * 1000

export async function evaluateAppMessageModeration(
  db: D1Database,
  context: AppMessageModerationRuntimeContext,
  senderType: AppMessageModerationSenderType,
  text: string,
  now = new Date(),
): Promise<AppMessageModerationEvaluation> {
  const evaluatedAt = now.toISOString()
  if (!context.policyId) return acceptedWithoutEvaluation(evaluatedAt)
  if (!POLICY_ID_PATTERN.test(context.policyId)) {
    throw policyUnavailable()
  }

  let policy: ModerationPolicyRow | null
  try {
    policy = await db.prepare(`
      SELECT id, state, production_ready, decision_status, evaluation_enabled,
             default_action, effective_at
      FROM app_message_moderation_policies
      WHERE id = ?
      LIMIT 1
    `).bind(context.policyId).first<ModerationPolicyRow>()
  }
  catch {
    throw policyUnavailable()
  }
  if (!policy || policy.default_action !== 'accept') throw policyUnavailable()
  if (policy.evaluation_enabled !== 1) {
    if (context.requireProductionReady) throw policyUnavailable()
    return acceptedWithoutEvaluation(evaluatedAt)
  }
  if (
    policy.state === 'retired'
    || !policy.effective_at
    || Date.parse(policy.effective_at) > now.getTime()
  ) {
    throw policyUnavailable()
  }
  if (
    context.requireProductionReady
    && (
      policy.state !== 'published'
      || policy.production_ready !== 1
      || policy.decision_status !== 'approved'
    )
  ) {
    throw policyUnavailable()
  }

  let rules: D1Result<ModerationRuleRow>
  try {
    rules = await db.prepare(`
      SELECT id, actor_scope, match_type, normalized_pattern, action, reason_code, priority
      FROM app_message_moderation_rules
      WHERE policy_id = ?
        AND active = 1
        AND actor_scope IN (?, 'both')
      ORDER BY CASE action WHEN 'reject' THEN 0 ELSE 1 END, priority ASC, id ASC
    `).bind(policy.id, senderType === 'viewer' ? 'viewer' : 'operator').all<ModerationRuleRow>()
  }
  catch {
    throw policyUnavailable()
  }
  const normalized = normalizeModerationText(text)
  const matched = rules.results.find(rule => moderationRuleMatches(rule, normalized)) ?? null
  const status: AppMessageModerationStatus = matched?.action === 'reject'
    ? 'rejected'
    : matched?.action === 'review'
      ? 'review_pending'
      : 'accepted'

  return {
    status,
    policyId: policy.id,
    ruleId: matched?.id ?? null,
    reasonCode: matched?.reason_code ?? 'no_rule_match',
    evaluationId: randomId('mme'),
    caseId: status === 'review_pending' ? randomId('mmc') : null,
    evaluatedAt,
  }
}

export function prepareAppMessageModerationStatements(
  db: D1Database,
  evaluation: AppMessageModerationEvaluation,
  messageId: string,
): D1PreparedStatement[] {
  if (!evaluation.evaluationId || !evaluation.policyId) return []
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_message_moderation_evaluations (
        id, message_id, conversation_id, policy_id, rule_id, sender_type,
        outcome, reason_code, body_sha256, body_length, evaluated_at
      )
      SELECT ?, message.id, message.conversation_id, ?, ?, message.sender_type,
             ?, ?, message.body_sha256, length(message.body_text), ?
      FROM app_conversation_messages message
      WHERE message.id = ?
        AND message.sender_type IN ('viewer', 'platform_operator')
        AND message.status = ?
    `).bind(
      evaluation.evaluationId,
      evaluation.policyId,
      evaluation.ruleId,
      evaluation.status,
      evaluation.reasonCode,
      evaluation.evaluatedAt,
      messageId,
      evaluation.status,
    ),
  ]
  if (!evaluation.caseId || evaluation.status !== 'review_pending') return statements
  statements.push(
    db.prepare(`
      INSERT INTO app_message_moderation_cases (
        id, evaluation_id, message_id, conversation_id, policy_id, status,
        version, reason_code, assigned_admin_id, reviewed_by,
        decision_reason_code, lease_expires_at, created_at, updated_at,
        claimed_at, decided_at
      )
      SELECT ?, evaluation.id, message.id, message.conversation_id,
             evaluation.policy_id, 'pending', 1, evaluation.reason_code,
             NULL, NULL, NULL, NULL, ?, ?, NULL, NULL
      FROM app_message_moderation_evaluations evaluation
      JOIN app_conversation_messages message ON message.id = evaluation.message_id
      WHERE evaluation.id = ?
        AND evaluation.outcome = 'review_pending'
        AND message.status = 'review_pending'
    `).bind(
      evaluation.caseId,
      evaluation.evaluatedAt,
      evaluation.evaluatedAt,
      evaluation.evaluationId,
    ),
    db.prepare(`
      INSERT INTO app_message_moderation_case_events (
        id, case_id, event_type, actor_admin_id, from_version,
        to_version, reason_code, created_at
      )
      SELECT ?, id, 'opened', NULL, 0, 1, reason_code, created_at
      FROM app_message_moderation_cases
      WHERE id = ? AND status = 'pending' AND version = 1
    `).bind(randomId('mmce'), evaluation.caseId),
  )
  return statements
}

export function parseAdminAppMessageModerationCaseListQuery(input: {
  status?: string
  limit?: string
}): AdminAppMessageModerationCaseListQuery {
  const status = input.status?.trim() || null
  if (status && !['pending', 'in_review', 'accepted', 'rejected', 'cancelled'].includes(status)) {
    throw new AppMessageModerationError(400, 'MODERATION_CASE_STATUS_INVALID', '审核案件状态无效')
  }
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    status: status as AppMessageModerationCaseStatus | null,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_CASE_LIST_SIZE)
      : DEFAULT_CASE_LIST_SIZE,
  }
}

export async function listAdminAppMessageModerationCases(
  db: D1Database,
  adminId: number,
  query: AdminAppMessageModerationCaseListQuery,
  now = new Date(),
): Promise<{ items: AdminAppMessageModerationCaseSummary[]; hasMore: boolean }> {
  const condition = query.status ? 'review_case.status = ?' : "review_case.status IN ('pending', 'in_review')"
  const params: unknown[] = query.status ? [query.status] : []
  const result = await db.prepare(`
    ${moderationCaseSelect()}
    WHERE ${condition}
    ORDER BY
      CASE review_case.status WHEN 'pending' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,
      review_case.updated_at ASC,
      review_case.id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<ModerationCaseRow>()
  return {
    items: result.results.slice(0, query.limit).map(row => mapModerationCase(row, adminId, now)),
    hasMore: result.results.length > query.limit,
  }
}

export async function claimAdminAppMessageModerationCase(
  db: D1Database,
  adminId: number,
  caseIdValue: string,
  idempotencyKeyValue: string | null,
  input: AdminAppMessageModerationClaimInput,
  now = new Date(),
): Promise<AdminAppMessageModerationClaimResult> {
  const caseId = normalizeCaseId(caseIdValue)
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = `moderator:${adminId}`
  const requestHash = await hashCanonical({ caseId, expectedVersion })
  const replay = await findModerationIdempotency(db, actorScope, 'case_claim', idempotencyKey)
  if (replay) return claimReplay(replay, requestHash)

  const reviewCase = await readModerationCase(db, caseId)
  if (!reviewCase) throw caseNotFound()
  if (reviewCase.actor_admin_id === adminId) {
    throw new AppMessageModerationError(403, 'MODERATION_AUTHOR_SEPARATION_REQUIRED', '不能领取自己发送消息的审核案件')
  }
  if (!['pending', 'in_review'].includes(reviewCase.status)) {
    throw new AppMessageModerationError(409, 'MODERATION_CASE_FINAL', '审核案件已经完成')
  }
  if (reviewCase.message_status !== 'review_pending') {
    throw new AppMessageModerationError(409, 'MODERATION_MESSAGE_STATE_CONFLICT', '消息审核状态已变化')
  }
  if (reviewCase.version !== expectedVersion) throw caseVersionConflict()
  const leaseActive = Boolean(
    reviewCase.lease_expires_at
    && Date.parse(reviewCase.lease_expires_at) > now.getTime(),
  )
  if (leaseActive && reviewCase.assigned_admin_id !== adminId) {
    throw new AppMessageModerationError(409, 'MODERATION_CASE_CLAIMED', '审核案件已被其他管理员领取')
  }

  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + REVIEW_LEASE_MS).toISOString()
  const nextVersion = expectedVersion + 1
  const stored: StoredClaimResult = {
    caseId,
    status: 'in_review',
    version: nextVersion,
    assignedAdminId: adminId,
    leaseExpiresAt,
  }
  const resultJson = JSON.stringify(stored)
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_message_moderation_cases
        SET status = 'in_review', version = ?, assigned_admin_id = ?, reviewed_by = NULL,
            decision_reason_code = NULL, lease_expires_at = ?, claimed_at = ?,
            decided_at = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('pending', 'in_review')
          AND (
            status = 'pending'
            OR datetime(lease_expires_at) <= datetime(?)
            OR assigned_admin_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages message
            WHERE message.id = app_message_moderation_cases.message_id
              AND message.status = 'review_pending'
              AND NOT (
                message.sender_type = 'platform_operator'
                AND message.actor_admin_id = ?
              )
          )
      `).bind(
        nextVersion,
        adminId,
        leaseExpiresAt,
        nowIso,
        nowIso,
        caseId,
        expectedVersion,
        nowIso,
        adminId,
        adminId,
      ),
      db.prepare(`
        INSERT INTO app_message_moderation_case_events (
          id, case_id, event_type, actor_admin_id, from_version,
          to_version, reason_code, created_at
        )
        SELECT ?, id, 'claimed', ?, ?, version, 'manual_claim', ?
        FROM app_message_moderation_cases
        WHERE id = ? AND status = 'in_review' AND version = ? AND assigned_admin_id = ?
      `).bind(randomId('mmce'), adminId, expectedVersion, nowIso, caseId, nextVersion, adminId),
      db.prepare(`
        INSERT INTO app_message_moderation_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          case_id, result_version, result_json, created_at
        )
        SELECT ?, 'case_claim', ?, ?, id, version, ?, ?
        FROM app_message_moderation_cases
        WHERE id = ? AND status = 'in_review' AND version = ? AND assigned_admin_id = ?
      `).bind(
        actorScope,
        idempotencyKey,
        requestHash,
        resultJson,
        nowIso,
        caseId,
        nextVersion,
        adminId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id,
          before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_message_moderation.case_claim', 'app_message_moderation_case', ?, ?, ?, ?
        FROM app_message_moderation_cases
        WHERE id = ? AND status = 'in_review' AND version = ? AND assigned_admin_id = ?
      `).bind(
        randomId('audit'),
        adminId,
        caseId,
        JSON.stringify({ status: reviewCase.status, version: expectedVersion }),
        JSON.stringify({ status: 'in_review', version: nextVersion, leaseExpiresAt }),
        nowIso,
        caseId,
        nextVersion,
        adminId,
      ),
    ])
  }
  catch (error) {
    const racedReplay = await findModerationIdempotency(db, actorScope, 'case_claim', idempotencyKey)
    if (racedReplay) return claimReplay(racedReplay, requestHash)
    const latest = await readModerationCase(db, caseId)
    if (!latest || latest.version !== expectedVersion || latest.status !== reviewCase.status) {
      throw caseVersionConflict()
    }
    throw error
  }
  const written = await findModerationIdempotency(db, actorScope, 'case_claim', idempotencyKey)
  if (!written) throw caseVersionConflict()
  return claimReplay(written, requestHash, false)
}

export async function getAdminAppMessageModerationCaseDetail(
  db: D1Database,
  adminId: number,
  caseIdValue: string,
  requestId: string,
  now = new Date(),
): Promise<AdminAppMessageModerationCaseDetail> {
  const caseId = normalizeCaseId(caseIdValue)
  const normalizedRequestId = normalizeRequestId(requestId)
  const nowIso = now.toISOString()
  const row = await db.prepare(`
    ${moderationCaseSelect(`,
           message.client_message_id, message.body_text,
           message.created_at AS message_created_at`)}
    WHERE review_case.id = ?
      AND review_case.status = 'in_review'
      AND review_case.assigned_admin_id = ?
      AND datetime(review_case.lease_expires_at) > datetime(?)
      AND message.status = 'review_pending'
    LIMIT 1
  `).bind(caseId, adminId, nowIso).first<ModerationCaseDetailRow>()
  if (!row) {
    const exists = await readModerationCase(db, caseId)
    if (!exists) throw caseNotFound()
    throw new AppMessageModerationError(403, 'MODERATION_CASE_ACCESS_DENIED', '请先领取审核案件后再查看消息正文')
  }
  const audited = await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id,
      before_value, after_value, created_at
    )
    SELECT ?, ?, 'app_message_moderation.body_access', 'app_message_moderation_case',
           ?, NULL, ?, ?
    FROM app_message_moderation_cases review_case
    WHERE review_case.id = ?
      AND review_case.status = 'in_review'
      AND review_case.assigned_admin_id = ?
      AND datetime(review_case.lease_expires_at) > datetime(?)
  `).bind(
    randomId('audit'),
    adminId,
    caseId,
    JSON.stringify({
      accessReason: 'message_moderation_review',
      requestId: normalizedRequestId,
      messageId: row.message_id,
      bodySha256: row.body_sha256,
      bodyLength: Number(row.body_length),
    }),
    nowIso,
    caseId,
    adminId,
    nowIso,
  ).run()
  if (Number(audited.meta?.changes ?? 0) !== 1) {
    throw new AppMessageModerationError(403, 'MODERATION_CASE_ACCESS_DENIED', '审核租约已变化，请重新领取案件')
  }
  return {
    ...mapModerationCase(row, adminId, now),
    accessReason: 'message_moderation_review',
    clientMessageId: row.client_message_id,
    text: row.body_text,
    messageCreatedAt: row.message_created_at,
  }
}

export async function decideAdminAppMessageModerationCase(
  db: D1Database,
  adminId: number,
  caseIdValue: string,
  idempotencyKeyValue: string | null,
  input: AdminAppMessageModerationDecisionInput,
  now = new Date(),
): Promise<AdminAppMessageModerationDecisionResult> {
  const caseId = normalizeCaseId(caseIdValue)
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion)
  const decision = normalizeDecision(input.decision)
  const reasonCode = normalizeDecisionReason(input.reasonCode, decision)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = `moderator:${adminId}`
  const requestHash = await hashCanonical({ caseId, expectedVersion, decision, reasonCode })
  const replay = await findModerationIdempotency(db, actorScope, 'case_decision', idempotencyKey)
  if (replay) {
    const replayed = decisionReplay(replay, requestHash)
    if (replayed.status !== 'accepted') return replayed
    const current = await db.prepare(`
      SELECT message.sender_type, message.status AS message_status,
             conversation.queue_status
      FROM app_conversation_messages message
      JOIN app_conversations conversation ON conversation.id = message.conversation_id
      WHERE message.id = ? AND conversation.id = ?
      LIMIT 1
    `).bind(replayed.messageId, replayed.conversationId).first<{
      sender_type: string
      message_status: string
      queue_status: string
    }>()
    return {
      ...replayed,
      autoAssignmentEligible: current?.sender_type === 'viewer'
        && current.message_status === 'accepted'
        && current.queue_status === 'awaiting_operator',
    }
  }

  const reviewCase = await readModerationCase(db, caseId)
  if (!reviewCase) throw caseNotFound()
  if (reviewCase.actor_admin_id === adminId) {
    throw new AppMessageModerationError(403, 'MODERATION_AUTHOR_SEPARATION_REQUIRED', '不能裁决自己发送的消息')
  }
  if (
    reviewCase.status !== 'in_review'
    || reviewCase.assigned_admin_id !== adminId
    || !reviewCase.lease_expires_at
    || Date.parse(reviewCase.lease_expires_at) <= now.getTime()
  ) {
    throw new AppMessageModerationError(409, 'MODERATION_CASE_LEASE_REQUIRED', '审核领取已失效，请重新领取')
  }
  if (reviewCase.version !== expectedVersion) throw caseVersionConflict()
  if (reviewCase.message_status !== 'review_pending') {
    throw new AppMessageModerationError(409, 'MODERATION_MESSAGE_STATE_CONFLICT', '消息审核状态已变化')
  }

  const nowIso = now.toISOString()
  const nextVersion = expectedVersion + 1
  const stored: StoredDecisionResult = {
    caseId,
    status: decision,
    version: nextVersion,
    conversationId: reviewCase.conversation_id,
    messageId: reviewCase.message_id,
    messageStatus: decision,
  }
  const resultJson = JSON.stringify(stored)
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_message_moderation_cases
        SET status = ?, version = ?, reviewed_by = ?, decision_reason_code = ?,
            lease_expires_at = NULL, decided_at = ?, updated_at = ?
        WHERE id = ? AND status = 'in_review' AND version = ?
          AND assigned_admin_id = ?
          AND datetime(lease_expires_at) > datetime(?)
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages message
            WHERE message.id = app_message_moderation_cases.message_id
              AND message.status = 'review_pending'
              AND NOT (
                message.sender_type = 'platform_operator'
                AND message.actor_admin_id = ?
              )
          )
      `).bind(
        decision,
        nextVersion,
        adminId,
        reasonCode,
        nowIso,
        nowIso,
        caseId,
        expectedVersion,
        adminId,
        nowIso,
        adminId,
      ),
      db.prepare(`
        UPDATE app_conversation_messages
        SET status = ?,
            sequence = CASE WHEN ? = 'accepted' THEN (
              SELECT conversation.last_sequence + 1
              FROM app_conversations conversation
              WHERE conversation.id = app_conversation_messages.conversation_id
            ) ELSE sequence END
        WHERE id = ? AND status = 'review_pending'
          AND EXISTS (
            SELECT 1 FROM app_message_moderation_cases review_case
            WHERE review_case.id = ?
              AND review_case.message_id = app_conversation_messages.id
              AND review_case.status = ?
              AND review_case.version = ?
              AND review_case.reviewed_by = ?
          )
      `).bind(
        decision,
        decision,
        reviewCase.message_id,
        caseId,
        decision,
        nextVersion,
        adminId,
      ),
      db.prepare(`
        INSERT INTO app_message_moderation_case_events (
          id, case_id, event_type, actor_admin_id, from_version,
          to_version, reason_code, created_at
        )
        SELECT ?, id, ?, ?, ?, version, ?, ?
        FROM app_message_moderation_cases
        WHERE id = ? AND status = ? AND version = ? AND reviewed_by = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages message
            WHERE message.id = app_message_moderation_cases.message_id
              AND message.status = ?
          )
      `).bind(
        randomId('mmce'),
        decision,
        adminId,
        expectedVersion,
        reasonCode,
        nowIso,
        caseId,
        decision,
        nextVersion,
        adminId,
        decision,
      ),
      db.prepare(`
        UPDATE app_conversations
        SET last_sequence = CASE WHEN ? = 'accepted' THEN (
              SELECT message.sequence
              FROM app_conversation_messages message
              WHERE message.id = ? AND message.status = 'accepted'
            ) ELSE last_sequence END,
            last_message_at = CASE WHEN ? = 'accepted' THEN ? ELSE last_message_at END,
            queue_status = COALESCE((
              SELECT CASE latest.sender_type
                WHEN 'viewer' THEN 'awaiting_operator'
                WHEN 'platform_operator' THEN 'awaiting_viewer'
              END
              FROM app_conversation_messages latest
              WHERE latest.conversation_id = app_conversations.id
                AND latest.sender_type IN ('viewer', 'platform_operator')
                AND latest.status = 'accepted'
              ORDER BY latest.sequence DESC
              LIMIT 1
            ), queue_status),
            updated_at = ?
        WHERE id = ? AND ? = 'accepted'
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages message
            WHERE message.id = ? AND message.status = 'accepted'
          )
      `).bind(
        decision,
        reviewCase.message_id,
        decision,
        nowIso,
        nowIso,
        reviewCase.conversation_id,
        decision,
        reviewCase.message_id,
      ),
      db.prepare(`
        INSERT INTO app_message_moderation_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          case_id, result_version, result_json, created_at
        )
        SELECT ?, 'case_decision', ?, ?, id, version, ?, ?
        FROM app_message_moderation_cases
        WHERE id = ? AND status = ? AND version = ? AND reviewed_by = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages message
            WHERE message.id = app_message_moderation_cases.message_id
              AND message.status = ?
          )
      `).bind(
        actorScope,
        idempotencyKey,
        requestHash,
        resultJson,
        nowIso,
        caseId,
        decision,
        nextVersion,
        adminId,
        decision,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id,
          before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_message_moderation.case_decision', 'app_message_moderation_case', ?, ?, ?, ?
        FROM app_message_moderation_cases
        WHERE id = ? AND status = ? AND version = ? AND reviewed_by = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages message
            WHERE message.id = app_message_moderation_cases.message_id
              AND message.status = ?
          )
      `).bind(
        randomId('audit'),
        adminId,
        caseId,
        JSON.stringify({ status: 'in_review', version: expectedVersion, messageStatus: 'review_pending' }),
        JSON.stringify({
          status: decision,
          version: nextVersion,
          messageStatus: decision,
          reasonCode,
          bodySha256: reviewCase.body_sha256,
        }),
        nowIso,
        caseId,
        decision,
        nextVersion,
        adminId,
        decision,
      ),
    ])
  }
  catch (error) {
    const racedReplay = await findModerationIdempotency(db, actorScope, 'case_decision', idempotencyKey)
    if (racedReplay) return decisionReplay(racedReplay, requestHash)
    const latest = await readModerationCase(db, caseId)
    if (!latest || latest.version !== expectedVersion || latest.status !== 'in_review') {
      throw caseVersionConflict()
    }
    throw error
  }
  const written = await findModerationIdempotency(db, actorScope, 'case_decision', idempotencyKey)
  if (!written) throw caseVersionConflict()
  const conversation = await db.prepare(`
    SELECT queue_status
    FROM app_conversations
    WHERE id = ?
    LIMIT 1
  `).bind(reviewCase.conversation_id).first<{ queue_status: string }>()
  return {
    ...decisionReplay(written, requestHash, false),
    autoAssignmentEligible: decision === 'accepted'
      && reviewCase.sender_type === 'viewer'
      && conversation?.queue_status === 'awaiting_operator',
  }
}

function moderationCaseSelect(extraFields = '') {
  return `
    SELECT review_case.id, review_case.status, review_case.version,
           review_case.evaluation_id, review_case.conversation_id,
           review_case.message_id, message.status AS message_status,
           message.sender_type, message.actor_admin_id,
           review_case.policy_id, evaluation.rule_id, review_case.reason_code,
           review_case.decision_reason_code,
           evaluation.body_sha256, evaluation.body_length,
           review_case.assigned_admin_id, review_case.lease_expires_at,
           review_case.created_at, review_case.updated_at, review_case.decided_at,
           security.account_public_id, conversation.profile_id,
           profile.display_name AS profile_display_name${extraFields}
    FROM app_message_moderation_cases review_case
    JOIN app_message_moderation_evaluations evaluation
      ON evaluation.id = review_case.evaluation_id
    JOIN app_conversation_messages message ON message.id = review_case.message_id
    JOIN app_conversations conversation ON conversation.id = review_case.conversation_id
    JOIN app_account_security security ON security.account_id = conversation.account_id
    JOIN person_profiles profile ON profile.id = conversation.profile_id
  `
}

async function readModerationCase(db: D1Database, caseId: string) {
  return db.prepare(`
    ${moderationCaseSelect()}
    WHERE review_case.id = ?
    LIMIT 1
  `).bind(caseId).first<ModerationCaseRow>()
}

function mapModerationCase(
  row: ModerationCaseRow,
  adminId: number,
  now: Date,
): AdminAppMessageModerationCaseSummary {
  const assignedAdminId = row.assigned_admin_id === null ? null : Number(row.assigned_admin_id)
  const leaseActive = Boolean(row.lease_expires_at && Date.parse(row.lease_expires_at) > now.getTime())
  const assignmentState = !leaseActive || assignedAdminId === null
    ? 'unassigned'
    : assignedAdminId === adminId
      ? 'mine'
      : 'other'
  return {
    caseId: row.id,
    status: row.status as AppMessageModerationCaseStatus,
    version: Number(row.version),
    conversationId: row.conversation_id,
    messageId: row.message_id,
    messageStatus: row.message_status as AppMessageModerationStatus,
    senderType: row.sender_type as AppMessageModerationSenderType,
    policyId: row.policy_id,
    ruleId: row.rule_id,
    reasonCode: row.reason_code,
    decisionReasonCode: row.decision_reason_code,
    bodySha256: row.body_sha256,
    bodyLength: Number(row.body_length),
    accountId: row.account_public_id,
    profileId: row.profile_id,
    profileDisplayName: row.profile_display_name,
    assignment: {
      state: assignmentState,
      assignedAdminId,
      leaseExpiresAt: row.lease_expires_at,
      canClaim: ['pending', 'in_review'].includes(row.status)
        && (!leaseActive || assignedAdminId === adminId)
        && row.actor_admin_id !== adminId,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  }
}

function moderationRuleMatches(rule: ModerationRuleRow, normalizedText: string) {
  const pattern = rule.normalized_pattern ? normalizeModerationText(rule.normalized_pattern) : null
  if (rule.match_type === 'exact') return Boolean(pattern && normalizedText === pattern)
  if (rule.match_type === 'contains') return Boolean(pattern && normalizedText.includes(pattern))
  const structuralMatch = rule.match_type === 'url'
    ? /(?:https?:\/\/|www\.)[^\s]+/iu.test(normalizedText)
    : rule.match_type === 'email'
      ? /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu.test(normalizedText)
      : rule.match_type === 'phone'
        ? /(?:\+?\d[\d\s().-]{6,}\d)/u.test(normalizedText)
        : false
  return structuralMatch && (!pattern || normalizedText.includes(pattern))
}

function normalizeModerationText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function acceptedWithoutEvaluation(evaluatedAt: string): AppMessageModerationEvaluation {
  return {
    status: 'accepted',
    policyId: null,
    ruleId: null,
    reasonCode: 'policy_disabled',
    evaluationId: null,
    caseId: null,
    evaluatedAt,
  }
}

function normalizeCaseId(value: string) {
  if (!CASE_ID_PATTERN.test(value)) throw caseNotFound()
  return value
}

function normalizeExpectedVersion(value: unknown) {
  const version = Number(value)
  if (!Number.isInteger(version) || version <= 0) {
    throw new AppMessageModerationError(400, 'EXPECTED_VERSION_REQUIRED', 'expectedVersion 必须为正整数')
  }
  return version
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppMessageModerationError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

function normalizeDecision(value: unknown): 'accepted' | 'rejected' {
  if (value !== 'accepted' && value !== 'rejected') {
    throw new AppMessageModerationError(400, 'MODERATION_DECISION_INVALID', '审核决定必须为 accepted 或 rejected')
  }
  return value
}

function normalizeDecisionReason(value: unknown, decision: 'accepted' | 'rejected') {
  if ((value === undefined || value === null || value === '') && decision === 'accepted') {
    return 'review_accepted'
  }
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value.trim())) {
    throw new AppMessageModerationError(400, 'MODERATION_REASON_REQUIRED', '审核决定必须提供稳定的原因代码')
  }
  return value.trim()
}

function normalizeRequestId(value: string) {
  const normalized = value.trim()
  if (normalized.length < 8 || normalized.length > 96) {
    throw new AppMessageModerationError(400, 'REQUEST_ID_INVALID', '请求标识无效')
  }
  return normalized
}

async function findModerationIdempotency(
  db: D1Database,
  actorScope: string,
  operation: 'case_claim' | 'case_decision',
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_json
    FROM app_message_moderation_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<ModerationIdempotencyRow>()
}

function claimReplay(
  replay: ModerationIdempotencyRow,
  requestHash: string,
  replayed = true,
): AdminAppMessageModerationClaimResult {
  assertIdempotencyHash(replay, requestHash)
  const stored = JSON.parse(replay.result_json) as StoredClaimResult
  return { ...stored, replayed }
}

function decisionReplay(
  replay: ModerationIdempotencyRow,
  requestHash: string,
  replayed = true,
): AdminAppMessageModerationDecisionResult {
  assertIdempotencyHash(replay, requestHash)
  const stored = JSON.parse(replay.result_json) as StoredDecisionResult
  return { ...stored, autoAssignmentEligible: false, replayed }
}

function assertIdempotencyHash(row: ModerationIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppMessageModerationError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于其他审核请求')
  }
}

async function hashCanonical(value: unknown) {
  const data = new TextEncoder().encode(JSON.stringify(value))
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function randomId(prefix: 'mme' | 'mmc' | 'mmce' | 'audit') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function policyUnavailable() {
  return new AppMessageModerationError(
    503,
    'MESSAGE_MODERATION_POLICY_UNAVAILABLE',
    '消息审核策略暂不可用，请稍后重试',
    true,
  )
}

function caseNotFound() {
  return new AppMessageModerationError(404, 'MODERATION_CASE_NOT_FOUND', '消息审核案件不存在')
}

function caseVersionConflict() {
  return new AppMessageModerationError(409, 'MODERATION_CASE_VERSION_CONFLICT', '消息审核案件状态已变化，请刷新后重试')
}
