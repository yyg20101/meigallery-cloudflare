import {
  AppMessagingError,
  hashCanonical,
  normalizeConversationId,
  normalizeIdempotencyKey,
  prefixedId,
  sha256Hex,
} from './app-messaging'
import { requireAdminConversationAssignment } from './admin-app-messaging'
import { AppSafetyError } from './app-safety'
import { containsForbiddenTextControlCharacter } from '../utils/text-safety'

const ESCALATION_ID_PATTERN = /^cse_[A-Za-z0-9_-]{1,76}$/u
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{1,76}$/u
const REASON_CODE_PATTERN = /^[a-z0-9_]{3,80}$/u
const DEFAULT_LIST_LIMIT = 40
const MAX_LIST_LIMIT = 100
const MAX_INTERNAL_TEXT_LENGTH = 1000

export type AdminConversationSafetyEscalationPriority = 'p0' | 'p1' | 'p2' | 'p3'
export type AdminConversationSafetyEscalationStatus = 'submitted' | 'investigating' | 'actioned' | 'no_action'
export type AdminConversationSafetyEscalationReason =
  | 'suspected_impersonation'
  | 'harassment_threat'
  | 'fraud_inducement'
  | 'privacy_exposure'
  | 'minor_safety'
  | 'imminent_danger'
  | 'other'

export interface AdminConversationSafetyEscalationSummary {
  escalationId: string
  conversationId: string
  profileId: string
  reasonCode: AdminConversationSafetyEscalationReason
  reasonLabel: string
  priority: AdminConversationSafetyEscalationPriority
  status: AdminConversationSafetyEscalationStatus
  assignment: {
    status: 'unassigned' | 'mine' | 'other'
    canClaim: boolean
    isolationBlocked: boolean
  }
  version: number
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface AdminConversationSafetyEscalationEvidenceMessage {
  messageId: string
  sequence: number
  role: 'before' | 'target' | 'after'
  senderType: 'viewer' | 'platform_operator' | 'system'
  text: string
  bodySha256: string
  snapshotIntegrityMatches: boolean | null
}

export interface AdminConversationSafetyEscalationDetail extends AdminConversationSafetyEscalationSummary {
  summaryText: string
  evidence: {
    targetMessageId: string | null
    targetMessageSequence: number | null
    conversationLastSequence: number
    evidenceDigest: string
    capturedAt: string
    messages: AdminConversationSafetyEscalationEvidenceMessage[]
  }
  decision: {
    actionType: 'none' | 'conversation_restricted' | 'conversation_closed'
    reasonCode: string
    summaryText: string
  } | null
  timeline: Array<{
    sequence: number
    eventType: 'submitted' | 'claimed' | 'actioned' | 'no_action'
    statusFrom: 'submitted' | 'investigating' | null
    statusTo: AdminConversationSafetyEscalationStatus
    reasonCode: string
    createdAt: string
  }>
}

export interface AdminCreateConversationSafetyEscalationInput {
  reasonCode?: unknown
  priority?: unknown
  summary?: unknown
  targetMessageId?: unknown
}

export interface AdminConversationSafetyEscalationDecisionInput {
  expectedVersion?: unknown
  outcome?: unknown
  actionType?: unknown
  decisionReasonCode?: unknown
  decisionSummary?: unknown
}

export interface AdminConversationSafetyEscalationListQuery {
  status: AdminConversationSafetyEscalationStatus | 'open' | null
  priority: AdminConversationSafetyEscalationPriority | null
  limit: number
}

type EscalationRow = {
  id: string
  conversation_id: string
  profile_id: string
  reason_code: string
  priority: string
  summary_text: string
  status: string
  raised_by_admin_id: number
  assigned_admin_id: number | null
  version: number
  action_type: string | null
  decision_reason_code: string | null
  decision_summary_text: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}

type EvidenceRow = {
  target_message_id: string | null
  target_message_sequence: number | null
  target_message_body_sha256: string | null
  context_before_message_id: string | null
  context_after_message_id: string | null
  conversation_last_sequence: number
  evidence_digest: string
  captured_at: string
}

type MessageRow = {
  id: string
  sequence: number
  sender_type: string
  body_text: string
  body_sha256: string
}

type EscalationIdempotencyRow = {
  request_hash: string
  escalation_id: string
  result_version: number
}

type ConversationRow = {
  id: string
  profile_id: string
  status: string
  last_sequence: number
}

type EscalationDecision = {
  expectedVersion: number
  outcome: 'actioned' | 'no_action'
  actionType: 'none' | 'conversation_restricted' | 'conversation_closed'
  decisionReasonCode: string
  decisionSummary: string
}

const ESCALATION_SELECT = `
  SELECT escalation.id, escalation.conversation_id, escalation.profile_id,
         escalation.reason_code, escalation.priority, escalation.summary_text,
         escalation.status, escalation.raised_by_admin_id,
         escalation.assigned_admin_id, escalation.version,
         escalation.action_type, escalation.decision_reason_code,
         escalation.decision_summary_text, escalation.created_at,
         escalation.updated_at, escalation.resolved_at
  FROM app_conversation_safety_escalations escalation
`

const ESCALATION_REASON_LABELS: Record<AdminConversationSafetyEscalationReason, string> = {
  suspected_impersonation: '疑似冒名或身份误导',
  harassment_threat: '骚扰、威胁或不当沟通',
  fraud_inducement: '诈骗、金钱或站外诱导',
  privacy_exposure: '隐私或敏感信息暴露',
  minor_safety: '疑似未成年人安全风险',
  imminent_danger: '现实人身安全紧急风险',
  other: '其他需独立安全复核的问题',
}

export function parseAdminConversationSafetyEscalationListQuery(input: {
  status?: string
  priority?: string
  limit?: string
}): AdminConversationSafetyEscalationListQuery {
  const rawStatus = input.status?.trim() || 'open'
  if (!['open', 'all', 'submitted', 'investigating', 'actioned', 'no_action'].includes(rawStatus)) {
    throw new AppSafetyError(400, 'ESCALATION_STATUS_INVALID', '内部升级状态筛选无效')
  }
  const rawPriority = input.priority?.trim() || null
  if (rawPriority && !['p0', 'p1', 'p2', 'p3'].includes(rawPriority)) {
    throw new AppSafetyError(400, 'ESCALATION_PRIORITY_INVALID', '内部升级优先级筛选无效')
  }
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    status: rawStatus === 'all' ? null : rawStatus as AdminConversationSafetyEscalationListQuery['status'],
    priority: rawPriority as AdminConversationSafetyEscalationPriority | null,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT,
  }
}

export async function createAdminConversationSafetyEscalation(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  input: AdminCreateConversationSafetyEscalationInput,
  now = new Date(),
): Promise<{ escalation: AdminConversationSafetyEscalationSummary; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const reasonCode = normalizeEscalationReason(input.reasonCode)
  const priority = normalizePriority(input.priority)
  const summary = normalizeInternalText(input.summary, '安全升级说明')
  const targetMessageId = normalizeOptionalMessageId(input.targetMessageId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ conversationId, reasonCode, priority, summary, targetMessageId })
  const assignment = await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const replay = await findEscalationIdempotency(db, adminId, 'create', idempotencyKey)
  if (replay) {
    assertEscalationIdempotency(replay, requestHash)
    return { escalation: mapSummary(await requireEscalation(db, replay.escalation_id), adminId), replayed: true }
  }

  const conversation = await requireActiveConversation(db, conversationId)
  const target = targetMessageId
    ? await requireConversationMessage(db, conversationId, targetMessageId)
    : null
  const before = target
    ? await findAdjacentMessage(db, conversationId, target.sequence, 'before')
    : null
  const after = target
    ? await findAdjacentMessage(db, conversationId, target.sequence, 'after')
    : null
  const capturedAt = now.toISOString()
  const evidenceDigest = await hashCanonical({
    conversationId,
    profileId: conversation.profile_id,
    conversationLastSequence: conversation.last_sequence,
    targetMessageId: target?.id ?? null,
    targetSequence: target?.sequence ?? null,
    targetBodySha256: target?.body_sha256 ?? null,
    contextBeforeMessageId: before?.id ?? null,
    contextAfterMessageId: after?.id ?? null,
  })
  const summarySha256 = await sha256Hex(summary)
  const escalationId = `cse_${crypto.randomUUID().replace(/-/gu, '')}`
  const mutationToken = crypto.randomUUID()

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_safety_escalations (
          id, conversation_id, profile_id, reason_code, priority,
          summary_text, summary_sha256, summary_length, status,
          raised_by_admin_id, assigned_admin_id, version, mutation_token,
          action_type, decision_reason_code, decision_summary_text,
          decision_summary_sha256, decision_summary_length,
          created_at, updated_at, resolved_at
        )
        SELECT ?, conversation.id, conversation.profile_id, ?, ?, ?, ?, ?,
               'submitted', ?, NULL, 1, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
        FROM app_conversations conversation
        JOIN app_conversation_assignment_state assignment
          ON assignment.conversation_id = conversation.id
        WHERE conversation.id = ? AND conversation.status = 'active'
          AND assignment.status = 'active'
          AND assignment.assigned_admin_id = ?
          AND assignment.version = ?
          AND datetime(assignment.lease_expires_at) > datetime(?)
      `).bind(
        escalationId,
        reasonCode,
        priority,
        summary,
        summarySha256,
        summary.length,
        adminId,
        mutationToken,
        capturedAt,
        capturedAt,
        conversationId,
        adminId,
        assignment.version,
        capturedAt,
      ),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_evidence (
          escalation_id, target_message_id, target_message_sequence,
          target_message_body_sha256, context_before_message_id,
          context_after_message_id, conversation_last_sequence,
          evidence_digest, captured_at
        )
        SELECT id, ?, ?, ?, ?, ?, ?, ?, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = 1 AND mutation_token = ?
      `).bind(
        target?.id ?? null,
        target?.sequence ?? null,
        target?.body_sha256 ?? null,
        before?.id ?? null,
        after?.id ?? null,
        conversation.last_sequence,
        evidenceDigest,
        capturedAt,
        escalationId,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_events (
          id, escalation_id, sequence, event_type, status_from,
          status_to, reason_code, actor_admin_id, created_at
        )
        SELECT ?, id, 1, 'submitted', NULL, 'submitted', reason_code, ?, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = 1 AND mutation_token = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_safety_escalation_evidence evidence
            WHERE evidence.escalation_id = app_conversation_safety_escalations.id
          )
      `).bind(eventId(), adminId, capturedAt, escalationId, mutationToken),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          escalation_id, result_version, created_at
        )
        SELECT ?, 'create', ?, ?, id, version, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = 1 AND mutation_token = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_safety_escalation_events event
            WHERE event.escalation_id = app_conversation_safety_escalations.id
              AND event.sequence = 1
          )
      `).bind(adminId, idempotencyKey, requestHash, capturedAt, escalationId, mutationToken),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation.safety_escalation_create',
               'app_conversation_safety_escalation', id, NULL, ?, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = 1 AND mutation_token = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_safety_escalation_idempotency request
            WHERE request.escalation_id = app_conversation_safety_escalations.id
              AND request.operation = 'create'
          )
      `).bind(
        auditId(),
        adminId,
        JSON.stringify({
          conversationId,
          profileId: conversation.profile_id,
          reasonCode,
          priority,
          summarySha256,
          summaryLength: summary.length,
          evidenceDigest,
          targetMessageId: target?.id ?? null,
        }),
        capturedAt,
        escalationId,
        mutationToken,
      ),
    ])
  }
  catch {
    const concurrent = await findEscalationIdempotency(db, adminId, 'create', idempotencyKey)
    if (concurrent) {
      assertEscalationIdempotency(concurrent, requestHash)
      return { escalation: mapSummary(await requireEscalation(db, concurrent.escalation_id), adminId), replayed: true }
    }
    throw new AppSafetyError(409, 'ESCALATION_CREATE_CONFLICT', '话题或租约状态已变化，安全升级未创建，请刷新后重试', true)
  }
  const stored = await findEscalationIdempotency(db, adminId, 'create', idempotencyKey)
  if (!stored) {
    throw new AppSafetyError(409, 'ESCALATION_CREATE_CONFLICT', '话题或租约状态已变化，安全升级未创建，请刷新后重试', true)
  }
  return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: false }
}

export async function listAdminConversationSafetyEscalations(
  db: D1Database,
  adminId: number,
  query: AdminConversationSafetyEscalationListQuery,
): Promise<AdminConversationSafetyEscalationSummary[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.status === 'open') {
    conditions.push("escalation.status IN ('submitted', 'investigating')")
  }
  else if (query.status) {
    conditions.push('escalation.status = ?')
    params.push(query.status)
  }
  if (query.priority) {
    conditions.push('escalation.priority = ?')
    params.push(query.priority)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const result = await db.prepare(`${ESCALATION_SELECT}
    ${where}
    ORDER BY
      CASE escalation.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
      escalation.created_at ASC,
      escalation.id ASC
    LIMIT ?
  `).bind(...params, query.limit).all<EscalationRow>()
  return result.results.map(row => mapSummary(row, adminId))
}

export async function claimAdminConversationSafetyEscalation(
  db: D1Database,
  adminId: number,
  escalationIdValue: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ escalation: AdminConversationSafetyEscalationSummary; replayed: boolean }> {
  const escalationId = normalizeEscalationId(escalationIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ escalationId })
  const replay = await findEscalationIdempotency(db, adminId, 'claim', idempotencyKey)
  if (replay) {
    assertEscalationIdempotency(replay, requestHash)
    return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: true }
  }
  const current = await requireEscalation(db, escalationId)
  if (isResolved(current.status)) {
    throw new AppSafetyError(409, 'ESCALATION_ALREADY_RESOLVED', '内部升级案件已形成结论')
  }
  if (current.raised_by_admin_id === adminId) {
    throw new AppSafetyError(403, 'ESCALATION_REVIEW_ISOLATION_REQUIRED', '发起人不能审核本人提交的内部升级案件')
  }
  if (current.assigned_admin_id && current.assigned_admin_id !== adminId) {
    throw new AppSafetyError(409, 'ESCALATION_ASSIGNMENT_TAKEN', '内部升级案件已由其他审核员领取')
  }
  if (current.assigned_admin_id === adminId) {
    await insertEscalationIdempotency(
      db,
      adminId,
      'claim',
      idempotencyKey,
      requestHash,
      escalationId,
      current.version,
      now,
    )
    return { escalation: mapSummary(current, adminId), replayed: false }
  }

  const nextVersion = Number(current.version) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_safety_escalations
        SET assigned_admin_id = ?, status = 'investigating', version = ?,
            mutation_token = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'submitted'
          AND assigned_admin_id IS NULL AND raised_by_admin_id <> ?
      `).bind(adminId, nextVersion, mutationToken, nowIso, escalationId, current.version, adminId),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_events (
          id, escalation_id, sequence, event_type, status_from,
          status_to, reason_code, actor_admin_id, created_at
        )
        SELECT ?, id,
               (SELECT COALESCE(MAX(sequence), 0) + 1
                FROM app_conversation_safety_escalation_events WHERE escalation_id = ?),
               'claimed', ?, 'investigating', 'reviewer_claimed', ?, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
      `).bind(
        eventId(),
        escalationId,
        current.status,
        adminId,
        nowIso,
        escalationId,
        nextVersion,
        mutationToken,
        adminId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          escalation_id, result_version, created_at
        )
        SELECT ?, 'claim', ?, ?, id, version, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
      `).bind(adminId, idempotencyKey, requestHash, nowIso, escalationId, nextVersion, mutationToken, adminId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'moderation.conversation_escalation.claim',
               'app_conversation_safety_escalation', id, ?, ?, ?
        FROM app_conversation_safety_escalations
        WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
      `).bind(
        auditId(),
        adminId,
        JSON.stringify({ status: current.status, version: current.version, assigned: false }),
        JSON.stringify({ status: 'investigating', version: nextVersion, assigned: true }),
        nowIso,
        escalationId,
        nextVersion,
        mutationToken,
        adminId,
      ),
    ])
  }
  catch {
    const concurrent = await findEscalationIdempotency(db, adminId, 'claim', idempotencyKey)
    if (concurrent) {
      assertEscalationIdempotency(concurrent, requestHash)
      return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: true }
    }
    throw new AppSafetyError(409, 'ESCALATION_ASSIGNMENT_CONFLICT', '内部升级案件分配状态已变化，请刷新后重试', true)
  }
  const stored = await findEscalationIdempotency(db, adminId, 'claim', idempotencyKey)
  if (!stored) {
    throw new AppSafetyError(409, 'ESCALATION_ASSIGNMENT_CONFLICT', '内部升级案件分配状态已变化，请刷新后重试', true)
  }
  return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: false }
}

export async function getAdminConversationSafetyEscalation(
  db: D1Database,
  adminId: number,
  escalationIdValue: string,
  requestId: string,
  now = new Date(),
): Promise<AdminConversationSafetyEscalationDetail> {
  const escalationId = normalizeEscalationId(escalationIdValue)
  const escalation = await requireAssignedEscalation(db, adminId, escalationId, now)
  const evidence = await db.prepare(`
    SELECT target_message_id, target_message_sequence, target_message_body_sha256,
           context_before_message_id, context_after_message_id,
           conversation_last_sequence, evidence_digest, captured_at
    FROM app_conversation_safety_escalation_evidence
    WHERE escalation_id = ?
    LIMIT 1
  `).bind(escalationId).first<EvidenceRow>()
  if (!evidence) {
    throw new AppSafetyError(503, 'ESCALATION_EVIDENCE_NOT_READY', '内部升级证据引用尚未就绪', true)
  }
  const messages = await loadEvidenceMessages(db, escalation.conversation_id, evidence)
  const events = await db.prepare(`
    SELECT sequence, event_type, status_from, status_to, reason_code, created_at
    FROM app_conversation_safety_escalation_events
    WHERE escalation_id = ?
    ORDER BY sequence ASC
  `).bind(escalationId).all<{
    sequence: number
    event_type: string
    status_from: string | null
    status_to: string
    reason_code: string
    created_at: string
  }>()
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'moderation.conversation_escalation.evidence_access',
              'app_conversation_safety_escalation', ?, NULL, ?, ?)
  `).bind(
    auditId(),
    adminId,
    escalationId,
    JSON.stringify({
      accessReason: 'safety_escalation_review',
      requestId,
      evidenceDigest: evidence.evidence_digest,
      messageIds: messages.map(message => message.messageId),
    }),
    now.toISOString(),
  ).run()
  return {
    ...mapSummary(escalation, adminId),
    summaryText: escalation.summary_text,
    evidence: {
      targetMessageId: evidence.target_message_id,
      targetMessageSequence: nullableNumber(evidence.target_message_sequence),
      conversationLastSequence: Number(evidence.conversation_last_sequence),
      evidenceDigest: evidence.evidence_digest,
      capturedAt: evidence.captured_at,
      messages,
    },
    decision: escalation.action_type && escalation.decision_reason_code && escalation.decision_summary_text
      ? {
          actionType: normalizeActionType(escalation.action_type),
          reasonCode: escalation.decision_reason_code,
          summaryText: escalation.decision_summary_text,
        }
      : null,
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      eventType: normalizeEventType(event.event_type),
      statusFrom: event.status_from ? normalizeOpenStatus(event.status_from) : null,
      statusTo: normalizeStatus(event.status_to),
      reasonCode: event.reason_code,
      createdAt: event.created_at,
    })),
  }
}

export async function decideAdminConversationSafetyEscalation(
  db: D1Database,
  adminId: number,
  escalationIdValue: string,
  idempotencyKeyValue: string | null,
  input: AdminConversationSafetyEscalationDecisionInput,
  now = new Date(),
): Promise<{ escalation: AdminConversationSafetyEscalationSummary; replayed: boolean }> {
  const escalationId = normalizeEscalationId(escalationIdValue)
  const decision = normalizeDecision(input)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ escalationId, ...decision })
  const replay = await findEscalationIdempotency(db, adminId, 'decision', idempotencyKey)
  if (replay) {
    assertEscalationIdempotency(replay, requestHash)
    return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: true }
  }
  const escalation = await requireAssignedEscalation(db, adminId, escalationId, now)
  if (Number(escalation.version) !== decision.expectedVersion) {
    throw new AppSafetyError(409, 'ESCALATION_VERSION_CONFLICT', '内部升级案件已被更新，请刷新后重新确认')
  }
  if (isResolved(escalation.status)) {
    throw new AppSafetyError(409, 'ESCALATION_ALREADY_RESOLVED', '内部升级案件已形成结论')
  }

  const statements: D1PreparedStatement[] = []
  const actionConditions: string[] = []
  const actionParams: unknown[] = []
  if (decision.actionType !== 'none') {
    const actionMessageId = await appendConversationEscalationAction(
      db,
      statements,
      escalation,
      decision.actionType,
      adminId,
      now,
    )
    actionConditions.push(`EXISTS (
      SELECT 1 FROM app_conversation_messages action_message
      WHERE action_message.id = ?
        AND action_message.conversation_id = app_conversation_safety_escalations.conversation_id
    )`)
    actionParams.push(actionMessageId)
  }
  const actionCondition = actionConditions.length ? actionConditions.join(' AND ') : '1 = 1'
  const nextVersion = decision.expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const decisionSummarySha256 = await sha256Hex(decision.decisionSummary)

  statements.push(db.prepare(`
    UPDATE app_conversation_safety_escalations
    SET status = ?, version = ?, mutation_token = ?, action_type = ?,
        decision_reason_code = ?, decision_summary_text = ?,
        decision_summary_sha256 = ?, decision_summary_length = ?,
        updated_at = ?, resolved_at = ?
    WHERE id = ? AND version = ? AND assigned_admin_id = ?
      AND status = 'investigating' AND ${actionCondition}
  `).bind(
    decision.outcome,
    nextVersion,
    mutationToken,
    decision.actionType,
    decision.decisionReasonCode,
    decision.decisionSummary,
    decisionSummarySha256,
    decision.decisionSummary.length,
    nowIso,
    nowIso,
    escalationId,
    decision.expectedVersion,
    adminId,
    ...actionParams,
  ))
  statements.push(db.prepare(`
    INSERT INTO app_conversation_safety_escalation_events (
      id, escalation_id, sequence, event_type, status_from,
      status_to, reason_code, actor_admin_id, created_at
    )
    SELECT ?, id,
           (SELECT COALESCE(MAX(sequence), 0) + 1
            FROM app_conversation_safety_escalation_events WHERE escalation_id = ?),
           ?, ?, status, ?, ?, ?
    FROM app_conversation_safety_escalations
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    eventId(),
    escalationId,
    decision.outcome,
    escalation.status,
    decision.decisionReasonCode,
    adminId,
    nowIso,
    escalationId,
    nextVersion,
    mutationToken,
    adminId,
  ))
  statements.push(db.prepare(`
    INSERT INTO app_conversation_safety_escalation_idempotency (
      admin_id, operation, idempotency_key, request_hash,
      escalation_id, result_version, created_at
    )
    SELECT ?, 'decision', ?, ?, id, version, ?
    FROM app_conversation_safety_escalations
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(adminId, idempotencyKey, requestHash, nowIso, escalationId, nextVersion, mutationToken, adminId))
  statements.push(db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, 'moderation.conversation_escalation.decision',
           'app_conversation_safety_escalation', id, ?, ?, ?
    FROM app_conversation_safety_escalations
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    auditId(),
    adminId,
    JSON.stringify({ status: escalation.status, version: escalation.version }),
    JSON.stringify({
      status: decision.outcome,
      version: nextVersion,
      actionType: decision.actionType,
      reasonCode: decision.decisionReasonCode,
      decisionSummarySha256,
      decisionSummaryLength: decision.decisionSummary.length,
    }),
    nowIso,
    escalationId,
    nextVersion,
    mutationToken,
    adminId,
  ))

  try {
    await db.batch(statements)
  }
  catch {
    const concurrent = await findEscalationIdempotency(db, adminId, 'decision', idempotencyKey)
    if (concurrent) {
      assertEscalationIdempotency(concurrent, requestHash)
      return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: true }
    }
    throw new AppSafetyError(409, 'ESCALATION_DECISION_CONFLICT', '案件状态或关联话题安全动作已变化，请刷新后重试', true)
  }
  const stored = await findEscalationIdempotency(db, adminId, 'decision', idempotencyKey)
  if (!stored) {
    throw new AppSafetyError(409, 'ESCALATION_DECISION_CONFLICT', '案件状态或关联话题安全动作已变化，请刷新后重试', true)
  }
  return { escalation: mapSummary(await requireEscalation(db, escalationId), adminId), replayed: false }
}

async function appendConversationEscalationAction(
  db: D1Database,
  statements: D1PreparedStatement[],
  escalation: EscalationRow,
  actionType: 'conversation_restricted' | 'conversation_closed',
  adminId: number,
  now: Date,
): Promise<string> {
  const conversation = await requireActiveConversation(db, escalation.conversation_id)
  const assignment = await db.prepare(`
    SELECT assigned_admin_id, version
    FROM app_conversation_assignment_state
    WHERE conversation_id = ? AND status = 'active'
    LIMIT 1
  `).bind(conversation.id).first<{ assigned_admin_id: number; version: number }>()
  const nowIso = now.toISOString()
  const nextSequence = Number(conversation.last_sequence) + 1
  const messageId = prefixedId('msg')
  const closed = actionType === 'conversation_closed'
  const messageText = closed
    ? '平台因安全审核已关闭本话题，历史消息仍可查看。'
    : '平台因安全审核已将本话题转为只读，历史消息仍可查看。'
  const assignmentCondition = assignment
    ? `EXISTS (
        SELECT 1 FROM app_conversation_assignment_state assignment
        WHERE assignment.conversation_id = app_conversations.id
          AND assignment.status = 'active' AND assignment.version = ?
      )`
    : `NOT EXISTS (
        SELECT 1 FROM app_conversation_assignment_state assignment
        WHERE assignment.conversation_id = app_conversations.id
          AND assignment.status = 'active'
      )`
  const assignmentConditionParams = assignment ? [assignment.version] : []
  statements.push(db.prepare(`
    INSERT INTO app_conversation_messages (
      id, conversation_id, sequence, sender_type, client_message_id,
      content_type, body_text, body_sha256, status,
      actor_account_id, actor_admin_id, created_at, recalled_at
    )
    SELECT ?, id, ?, 'system', ?, 'system', ?, ?, 'accepted', NULL, NULL, ?, NULL
    FROM app_conversations
    WHERE id = ? AND status = 'active' AND last_sequence = ?
      AND EXISTS (
        SELECT 1 FROM app_conversation_safety_escalations escalation
        WHERE escalation.id = ? AND escalation.version = ?
          AND escalation.assigned_admin_id = ? AND escalation.status = 'investigating'
      )
      AND ${assignmentCondition}
  `).bind(
    messageId,
    nextSequence,
    `system.escalation_action.${escalation.id}.${nextSequence}`,
    messageText,
    await sha256Hex(messageText),
    nowIso,
    conversation.id,
    conversation.last_sequence,
    escalation.id,
    escalation.version,
    adminId,
    ...assignmentConditionParams,
  ))
  statements.push(db.prepare(`
    UPDATE app_conversations
    SET status = ?, queue_status = 'closed', last_sequence = ?,
        last_message_at = ?, updated_at = ?, closed_at = ?,
        restriction_reason_code = ?, restriction_source = 'admin_safety',
        closed_reason_code = ?, closed_by_type = 'admin'
    WHERE id = ? AND EXISTS (SELECT 1 FROM app_conversation_messages WHERE id = ?)
  `).bind(
    closed ? 'closed' : 'restricted',
    nextSequence,
    nowIso,
    nowIso,
    closed ? nowIso : null,
    `escalation_${escalation.reason_code}`,
    closed ? `escalation_${escalation.reason_code}` : null,
    conversation.id,
    messageId,
  ))
  if (assignment) {
    const nextAssignmentVersion = Number(assignment.version) + 1
    const assignmentToken = crypto.randomUUID()
    statements.push(db.prepare(`
      UPDATE app_conversation_assignment_state
      SET assigned_admin_id = NULL, status = 'released', version = ?,
          lease_expires_at = NULL, mutation_token = ?, released_at = ?, updated_at = ?
      WHERE conversation_id = ? AND version = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM app_conversations WHERE id = ? AND status IN ('restricted', 'closed'))
        AND EXISTS (
          SELECT 1 FROM app_conversation_messages WHERE id = ? AND conversation_id = ?
        )
    `).bind(
      nextAssignmentVersion,
      assignmentToken,
      nowIso,
      nowIso,
      conversation.id,
      assignment.version,
      conversation.id,
      messageId,
      conversation.id,
    ))
    statements.push(db.prepare(`
      INSERT INTO app_conversation_assignment_events (
        id, conversation_id, version, event_type, subject_admin_id,
        actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
      )
      SELECT ?, conversation_id, version, 'released', ?, 'system', NULL,
             'safety_escalation_action', NULL, ?
      FROM app_conversation_assignment_state
      WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
    `).bind(
      `cae_${crypto.randomUUID().replace(/-/gu, '')}`,
      assignment.assigned_admin_id,
      nowIso,
      conversation.id,
      nextAssignmentVersion,
      assignmentToken,
    ))
  }
  return messageId
}

async function loadEvidenceMessages(
  db: D1Database,
  conversationId: string,
  evidence: EvidenceRow,
): Promise<AdminConversationSafetyEscalationEvidenceMessage[]> {
  if (!evidence.target_message_id) return []
  const ids = [
    evidence.context_before_message_id,
    evidence.target_message_id,
    evidence.context_after_message_id,
  ].filter((id): id is string => Boolean(id))
  const placeholders = ids.map(() => '?').join(', ')
  const result = await db.prepare(`
    SELECT id, sequence, sender_type, body_text, body_sha256
    FROM app_conversation_messages
    WHERE conversation_id = ? AND id IN (${placeholders})
    ORDER BY sequence ASC
  `).bind(conversationId, ...ids).all<MessageRow>()
  return result.results.map(row => ({
    messageId: row.id,
    sequence: Number(row.sequence),
    role: row.id === evidence.target_message_id
      ? 'target'
      : row.id === evidence.context_before_message_id ? 'before' : 'after',
    senderType: normalizeSenderType(row.sender_type),
    text: row.body_text,
    bodySha256: row.body_sha256,
    snapshotIntegrityMatches: row.id === evidence.target_message_id
      ? row.body_sha256 === evidence.target_message_body_sha256
      : null,
  }))
}

async function requireAssignedEscalation(
  db: D1Database,
  adminId: number,
  escalationId: string,
  now: Date,
): Promise<EscalationRow> {
  const escalation = await requireEscalation(db, escalationId)
  if (escalation.assigned_admin_id !== adminId) {
    await db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) VALUES (?, ?, 'moderation.conversation_escalation.assignment_denied',
                'app_conversation_safety_escalation', ?, NULL, ?, ?)
    `).bind(
      auditId(),
      adminId,
      escalationId,
      JSON.stringify({ reasonCode: 'ESCALATION_ASSIGNMENT_REQUIRED' }),
      now.toISOString(),
    ).run()
    throw new AppSafetyError(403, 'ESCALATION_ASSIGNMENT_REQUIRED', '请由独立审核员领取案件后再查看证据或形成结论')
  }
  return escalation
}

async function requireEscalation(db: D1Database, escalationId: string): Promise<EscalationRow> {
  const row = await db.prepare(`${ESCALATION_SELECT}
    WHERE escalation.id = ?
    LIMIT 1
  `).bind(escalationId).first<EscalationRow>()
  if (!row) throw new AppSafetyError(404, 'ESCALATION_NOT_FOUND', '内部升级案件不存在')
  return row
}

async function requireActiveConversation(db: D1Database, conversationId: string): Promise<ConversationRow> {
  const row = await db.prepare(`
    SELECT id, profile_id, status, last_sequence
    FROM app_conversations
    WHERE id = ?
    LIMIT 1
  `).bind(conversationId).first<ConversationRow>()
  if (!row) throw new AppMessagingError(404, 'CONVERSATION_NOT_FOUND', '平台话题不存在')
  if (row.status !== 'active') {
    throw new AppSafetyError(409, 'CONVERSATION_ACTION_CONFLICT', '关联话题已不是可升级或处置状态')
  }
  return row
}

async function requireConversationMessage(
  db: D1Database,
  conversationId: string,
  messageId: string,
): Promise<MessageRow> {
  const row = await db.prepare(`
    SELECT id, sequence, sender_type, body_text, body_sha256
    FROM app_conversation_messages
    WHERE id = ? AND conversation_id = ?
    LIMIT 1
  `).bind(messageId, conversationId).first<MessageRow>()
  if (!row) throw new AppSafetyError(400, 'ESCALATION_MESSAGE_INVALID', '目标消息不属于当前话题')
  return row
}

async function findAdjacentMessage(
  db: D1Database,
  conversationId: string,
  sequence: number,
  direction: 'before' | 'after',
): Promise<MessageRow | null> {
  const comparator = direction === 'before' ? '<' : '>'
  const order = direction === 'before' ? 'DESC' : 'ASC'
  return db.prepare(`
    SELECT id, sequence, sender_type, body_text, body_sha256
    FROM app_conversation_messages
    WHERE conversation_id = ? AND sequence ${comparator} ?
    ORDER BY sequence ${order}
    LIMIT 1
  `).bind(conversationId, sequence).first<MessageRow>()
}

async function findEscalationIdempotency(
  db: D1Database,
  adminId: number,
  operation: 'create' | 'claim' | 'decision',
  idempotencyKey: string,
): Promise<EscalationIdempotencyRow | null> {
  return db.prepare(`
    SELECT request_hash, escalation_id, result_version
    FROM app_conversation_safety_escalation_idempotency
    WHERE admin_id = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(adminId, operation, idempotencyKey).first<EscalationIdempotencyRow>()
}

async function insertEscalationIdempotency(
  db: D1Database,
  adminId: number,
  operation: 'claim',
  idempotencyKey: string,
  requestHash: string,
  escalationId: string,
  resultVersion: number,
  now: Date,
) {
  try {
    await db.prepare(`
      INSERT INTO app_conversation_safety_escalation_idempotency (
        admin_id, operation, idempotency_key, request_hash,
        escalation_id, result_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      adminId,
      operation,
      idempotencyKey,
      requestHash,
      escalationId,
      resultVersion,
      now.toISOString(),
    ).run()
  }
  catch {
    const concurrent = await findEscalationIdempotency(db, adminId, operation, idempotencyKey)
    if (!concurrent) throw new AppSafetyError(409, 'ESCALATION_IDEMPOTENCY_CONFLICT', '幂等结果写入冲突', true)
    assertEscalationIdempotency(concurrent, requestHash)
  }
}

function assertEscalationIdempotency(row: EscalationIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于另一项操作')
  }
}

function mapSummary(row: EscalationRow, adminId: number): AdminConversationSafetyEscalationSummary {
  const assignmentStatus = row.assigned_admin_id == null
    ? 'unassigned'
    : row.assigned_admin_id === adminId ? 'mine' : 'other'
  const isolationBlocked = row.raised_by_admin_id === adminId
  const status = normalizeStatus(row.status)
  return {
    escalationId: row.id,
    conversationId: row.conversation_id,
    profileId: row.profile_id,
    reasonCode: normalizeEscalationReason(row.reason_code),
    reasonLabel: ESCALATION_REASON_LABELS[normalizeEscalationReason(row.reason_code)],
    priority: normalizePriority(row.priority),
    status,
    assignment: {
      status: assignmentStatus,
      canClaim: !isResolved(status) && assignmentStatus !== 'other' && !isolationBlocked,
      isolationBlocked,
    },
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  }
}

function normalizeDecision(input: AdminConversationSafetyEscalationDecisionInput): EscalationDecision {
  const expectedVersion = Number(input.expectedVersion)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    throw new AppSafetyError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  const outcome = input.outcome === 'actioned'
    ? 'actioned'
    : input.outcome === 'no_action' ? 'no_action' : null
  if (!outcome) throw new AppSafetyError(400, 'ESCALATION_OUTCOME_INVALID', '结论必须为 actioned 或 no_action')
  const actionType = normalizeActionType(input.actionType)
  if ((outcome === 'no_action') !== (actionType === 'none')) {
    throw new AppSafetyError(400, 'ESCALATION_ACTION_INVALID', '无需动作必须选择 none；已处置必须选择实际话题动作')
  }
  const decisionReasonCode = normalizeStableReasonCode(input.decisionReasonCode)
  const decisionSummary = normalizeInternalText(input.decisionSummary, '内部审核说明')
  return { expectedVersion, outcome, actionType, decisionReasonCode, decisionSummary }
}

function normalizeEscalationId(value: string): string {
  if (!ESCALATION_ID_PATTERN.test(value)) {
    throw new AppSafetyError(404, 'ESCALATION_NOT_FOUND', '内部升级案件不存在')
  }
  return value
}

function normalizeOptionalMessageId(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !MESSAGE_ID_PATTERN.test(value)) {
    throw new AppSafetyError(400, 'ESCALATION_MESSAGE_INVALID', '目标消息 ID 无效')
  }
  return value
}

function normalizeEscalationReason(value: unknown): AdminConversationSafetyEscalationReason {
  if (
    value === 'suspected_impersonation'
    || value === 'harassment_threat'
    || value === 'fraud_inducement'
    || value === 'privacy_exposure'
    || value === 'minor_safety'
    || value === 'imminent_danger'
    || value === 'other'
  ) return value
  throw new AppSafetyError(400, 'ESCALATION_REASON_INVALID', '内部升级原因无效')
}

function normalizePriority(value: unknown): AdminConversationSafetyEscalationPriority {
  if (value === 'p0' || value === 'p1' || value === 'p2' || value === 'p3') return value
  throw new AppSafetyError(400, 'ESCALATION_PRIORITY_INVALID', '内部升级优先级无效')
}

function normalizeStatus(value: string): AdminConversationSafetyEscalationStatus {
  if (value === 'submitted' || value === 'investigating' || value === 'actioned' || value === 'no_action') return value
  throw new AppSafetyError(503, 'ESCALATION_STATE_INVALID', '内部升级案件状态异常')
}

function normalizeOpenStatus(value: string): 'submitted' | 'investigating' {
  if (value === 'submitted' || value === 'investigating') return value
  throw new AppSafetyError(503, 'ESCALATION_STATE_INVALID', '内部升级案件时间线状态异常')
}

function normalizeActionType(value: unknown): 'none' | 'conversation_restricted' | 'conversation_closed' {
  if (value === 'none' || value === 'conversation_restricted' || value === 'conversation_closed') return value
  throw new AppSafetyError(400, 'ESCALATION_ACTION_INVALID', '内部升级安全动作无效')
}

function normalizeEventType(value: string): 'submitted' | 'claimed' | 'actioned' | 'no_action' {
  if (value === 'submitted' || value === 'claimed' || value === 'actioned' || value === 'no_action') return value
  throw new AppSafetyError(503, 'ESCALATION_EVENT_INVALID', '内部升级案件事件异常')
}

function normalizeSenderType(value: string): 'viewer' | 'platform_operator' | 'system' {
  if (value === 'viewer' || value === 'platform_operator' || value === 'system') return value
  throw new AppSafetyError(503, 'ESCALATION_EVIDENCE_INVALID', '内部升级消息证据身份异常')
}

function normalizeStableReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value.trim())) {
    throw new AppSafetyError(400, 'REASON_CODE_INVALID', '原因码必须为 3 至 80 位小写字母、数字或下划线')
  }
  return value.trim()
}

function normalizeInternalText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new AppSafetyError(400, 'INTERNAL_TEXT_INVALID', `${label}不能为空`)
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (!normalized || normalized.length > MAX_INTERNAL_TEXT_LENGTH || hasControlCharacter(normalized)) {
    throw new AppSafetyError(400, 'INTERNAL_TEXT_INVALID', `${label}必须为 1 至 ${MAX_INTERNAL_TEXT_LENGTH} 个字符且不能包含控制字符`)
  }
  return normalized
}

function hasControlCharacter(value: string) {
  return containsForbiddenTextControlCharacter(value)
}

function isResolved(value: string): boolean {
  return value === 'actioned' || value === 'no_action'
}

function nullableNumber(value: number | null): number | null {
  return value == null ? null : Number(value)
}

function eventId() {
  return `csee_${crypto.randomUUID().replace(/-/gu, '')}`
}

function auditId() {
  return `audit_${crypto.randomUUID().replace(/-/gu, '')}`
}
