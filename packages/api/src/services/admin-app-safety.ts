import type {
  AppSafetyPriority,
  AppSafetyReportStatus,
  AppSafetyReportTarget,
  AppSafetyReportTargetType,
} from '@meigallery/shared'
import {
  hashCanonical,
  normalizeIdempotencyKey,
  prefixedId,
  sha256Hex,
} from './app-messaging'
import {
  AppSafetyError,
  getAppMessagingRuntimeControl,
  type AppMessagingRuntimeControl,
} from './app-safety'

const REPORT_ID_PATTERN = /^rpt_[A-Za-z0-9_-]{1,76}$/u
const REASON_CODE_PATTERN = /^[a-z0-9_]{3,80}$/u
const MAX_REPORT_LIST_SIZE = 100
const DEFAULT_REPORT_LIST_SIZE = 40

export interface AdminSafetyReportListQuery {
  status: string | null
  priority: AppSafetyPriority | null
  targetType: AppSafetyReportTargetType | null
  limit: number
}

export interface AdminSafetyReportSummary {
  reportId: string
  target: AppSafetyReportTarget
  reasonCode: string
  reasonLabel: string
  priority: AppSafetyPriority
  status: string
  userVisibleStatus: AppSafetyReportStatus
  assignment: {
    status: 'unassigned' | 'mine' | 'other'
    canClaim: boolean
  }
  version: number
  submittedAt: string
  updatedAt: string
}

export interface AdminSafetyEvidenceMessage {
  messageId: string
  sequence: number
  role: 'before' | 'target' | 'after'
  senderType: 'viewer' | 'platform_operator' | 'system'
  text: string
  bodySha256: string
  snapshotIntegrityMatches: boolean | null
}

export interface AdminSafetyReportDetail extends AdminSafetyReportSummary {
  description: string
  userVisibleMessage: string
  evidence: {
    profileContentVersion: number | null
    profileProjectionVersion: number | null
    mediaId: string | null
    conversationId: string | null
    messageId: string | null
    evidenceDigest: string
    capturedAt: string
    messages: AdminSafetyEvidenceMessage[]
  }
  timeline: Array<{
    sequence: number
    eventType: string
    statusFrom: string | null
    statusTo: string
    reasonCode: string
    userVisibleStatus: AppSafetyReportStatus
    userVisibleMessage: string
    createdAt: string
  }>
}

export interface AdminSafetyReportDecisionInput {
  expectedVersion?: unknown
  outcome?: unknown
  actionType?: unknown
  decisionReasonCode?: unknown
  userVisibleMessage?: unknown
}

export interface AdminMessagingRuntimeControlInput {
  expectedVersion?: unknown
  newConversationsPaused?: unknown
  viewerSendsPaused?: unknown
  operatorSendsPaused?: unknown
  reasonCode?: unknown
  userVisibleMessage?: unknown
  maxOpenConversations?: unknown
  maxActiveAssignmentsPerOperator?: unknown
  assignmentLeaseMinutes?: unknown
}

type ReportRow = {
  id: string
  target_type: string
  profile_id: string
  media_id: string | null
  conversation_id: string | null
  message_id: string | null
  reason_code: string
  reason_label: string
  priority: string
  status: string
  user_visible_status: string
  user_visible_message: string
  assigned_admin_id: number | null
  version: number
  submitted_at: string
  updated_at: string
  description_text: string
}

type EvidenceRow = {
  profile_content_version: number | null
  profile_projection_version: number | null
  media_id: string | null
  conversation_id: string | null
  message_id: string | null
  message_body_sha256: string | null
  context_before_message_id: string | null
  context_after_message_id: string | null
  evidence_digest: string
  captured_at: string
}

type SafetyIdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
}

type ReportDecision = {
  expectedVersion: number
  outcome: 'actioned' | 'no_violation'
  actionType: 'none' | 'conversation_restricted' | 'conversation_closed' | 'profile_publication_paused'
  decisionReasonCode: string
  userVisibleMessage: string
}

const REPORT_SELECT = `
  SELECT report.id, report.target_type, report.profile_id, report.media_id,
         report.conversation_id, report.message_id, report.reason_code,
         definition.display_label AS reason_label, report.priority,
         report.status, report.user_visible_status, report.user_visible_message,
         report.assigned_admin_id, report.version, report.submitted_at,
         report.updated_at, report.description_text
  FROM app_safety_reports report
  JOIN app_safety_reason_definitions definition
    ON definition.catalog_id = report.reason_catalog_id
   AND definition.reason_code = report.reason_code
`

export function parseAdminSafetyReportListQuery(input: {
  status?: string
  priority?: string
  targetType?: string
  limit?: string
}): AdminSafetyReportListQuery {
  const allowedStatuses = ['open', 'all', 'submitted', 'triaged', 'investigating', 'actioned', 'no_violation', 'closed']
  const requestedStatus = input.status?.trim() || 'open'
  if (!allowedStatuses.includes(requestedStatus)) {
    throw new AppSafetyError(400, 'REPORT_STATUS_INVALID', '举报状态筛选无效')
  }
  const status = requestedStatus === 'all' ? null : requestedStatus
  const priority = input.priority?.trim() || null
  if (priority && !['p0', 'p1', 'p2', 'p3'].includes(priority)) {
    throw new AppSafetyError(400, 'REPORT_PRIORITY_INVALID', '举报优先级筛选无效')
  }
  const targetType = input.targetType?.trim() || null
  if (targetType && !['person_profile', 'media', 'conversation', 'message'].includes(targetType)) {
    throw new AppSafetyError(400, 'REPORT_TARGET_INVALID', '举报目标筛选无效')
  }
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    status,
    priority: priority as AppSafetyPriority | null,
    targetType: targetType as AppSafetyReportTargetType | null,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_REPORT_LIST_SIZE)
      : DEFAULT_REPORT_LIST_SIZE,
  }
}

export async function listAdminSafetyReports(
  db: D1Database,
  adminId: number,
  query: AdminSafetyReportListQuery,
): Promise<AdminSafetyReportSummary[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.status) {
    if (query.status === 'open') {
      conditions.push("report.status IN ('submitted', 'triaged', 'investigating')")
    }
    else {
      conditions.push('report.status = ?')
      params.push(query.status)
    }
  }
  if (query.priority) {
    conditions.push('report.priority = ?')
    params.push(query.priority)
  }
  if (query.targetType) {
    conditions.push('report.target_type = ?')
    params.push(query.targetType)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await db.prepare(`${REPORT_SELECT}
    ${where}
    ORDER BY
      CASE report.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
      report.submitted_at ASC,
      report.id ASC
    LIMIT ?
  `).bind(...params, query.limit).all<ReportRow>()
  return rows.results.map(row => mapReportSummary(row, adminId))
}

export async function claimAdminSafetyReport(
  db: D1Database,
  adminId: number,
  reportIdValue: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ report: AdminSafetyReportSummary; replayed: boolean }> {
  const reportId = normalizeReportId(reportIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = safetyReviewerScope(adminId)
  const requestHash = await hashCanonical({ reportId })
  const replay = await findSafetyIdempotency(db, actorScope, 'report_claim', idempotencyKey)
  if (replay) {
    assertSafetyIdempotencyHash(replay, requestHash)
    return { report: mapReportSummary(await requireReport(db, reportId), adminId), replayed: true }
  }

  const current = await requireReport(db, reportId)
  if (isReportResolved(current.status)) {
    throw new AppSafetyError(409, 'REPORT_ALREADY_RESOLVED', '举报已形成结论，不能重新领取')
  }
  if (current.assigned_admin_id && current.assigned_admin_id !== adminId) {
    throw new AppSafetyError(409, 'REPORT_ASSIGNMENT_TAKEN', '该举报已被其他审核员领取')
  }
  if (current.assigned_admin_id === adminId) {
    await insertSafetyIdempotency(
      db,
      actorScope,
      'report_claim',
      idempotencyKey,
      requestHash,
      'report',
      reportId,
      Number(current.version),
      now,
    )
    return { report: mapReportSummary(current, adminId), replayed: false }
  }

  const nextVersion = Number(current.version) + 1
  const nowIso = now.toISOString()
  const mutationToken = crypto.randomUUID()
  const userVisibleMessage = '举报已进入人工审核，请留意后续状态。'
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_safety_reports
        SET assigned_admin_id = ?, status = 'triaged', user_visible_status = 'processing',
            user_visible_message = ?, version = ?, mutation_token = ?, updated_at = ?
        WHERE id = ? AND version = ? AND assigned_admin_id IS NULL
          AND status IN ('submitted', 'triaged', 'investigating')
      `).bind(
        adminId,
        userVisibleMessage,
        nextVersion,
        mutationToken,
        nowIso,
        reportId,
        current.version,
      ),
      db.prepare(`
        INSERT INTO app_safety_report_events (
          id, report_id, sequence, actor_type, actor_account_id, actor_admin_id,
          event_type, status_from, status_to, reason_code,
          user_visible_status, user_visible_message, created_at
        )
        SELECT ?, id,
               (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_safety_report_events WHERE report_id = ?),
               'admin', NULL, ?, 'claimed', ?, status, 'reviewer_claimed',
               user_visible_status, user_visible_message, ?
        FROM app_safety_reports
        WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
      `).bind(
        `rpe_${crypto.randomUUID().replace(/-/gu, '')}`,
        reportId,
        adminId,
        current.status,
        nowIso,
        reportId,
        nextVersion,
        mutationToken,
        adminId,
      ),
      db.prepare(`
        INSERT INTO app_safety_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'report_claim', ?, ?, 'report', id, version, ?
        FROM app_safety_reports
        WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
      `).bind(
        actorScope,
        idempotencyKey,
        requestHash,
        nowIso,
        reportId,
        nextVersion,
        mutationToken,
        adminId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'moderation.report.claim', 'app_safety_report', id, ?, ?, ?
        FROM app_safety_reports
        WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
      `).bind(
        `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        JSON.stringify({ status: current.status, version: current.version, assigned: false }),
        JSON.stringify({ status: 'triaged', version: nextVersion, assigned: true }),
        nowIso,
        reportId,
        nextVersion,
        mutationToken,
        adminId,
      ),
    ])
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'report_claim', idempotencyKey)
    if (concurrent) {
      assertSafetyIdempotencyHash(concurrent, requestHash)
      return { report: mapReportSummary(await requireReport(db, reportId), adminId), replayed: true }
    }
    throw new AppSafetyError(409, 'REPORT_ASSIGNMENT_CONFLICT', '举报分配状态已变化，请刷新后重试', true)
  }
  const stored = await findSafetyIdempotency(db, actorScope, 'report_claim', idempotencyKey)
  if (!stored) {
    throw new AppSafetyError(409, 'REPORT_ASSIGNMENT_CONFLICT', '举报分配状态已变化，请刷新后重试', true)
  }
  return { report: mapReportSummary(await requireReport(db, reportId), adminId), replayed: false }
}

export async function getAdminSafetyReport(
  db: D1Database,
  adminId: number,
  reportIdValue: string,
  requestId: string,
  now = new Date(),
): Promise<AdminSafetyReportDetail> {
  const reportId = normalizeReportId(reportIdValue)
  const report = await requireAssignedReport(db, adminId, reportId)
  const evidence = await db.prepare(`
    SELECT profile_content_version, profile_projection_version, media_id,
           conversation_id, message_id, message_body_sha256,
           context_before_message_id, context_after_message_id,
           evidence_digest, captured_at
    FROM app_safety_report_evidence
    WHERE report_id = ?
    LIMIT 1
  `).bind(reportId).first<EvidenceRow>()
  if (!evidence) {
    throw new AppSafetyError(503, 'REPORT_EVIDENCE_NOT_READY', '举报证据引用尚未就绪', true)
  }
  const messages = await loadEvidenceMessages(db, evidence)
  const events = await db.prepare(`
    SELECT sequence, event_type, status_from, status_to, reason_code,
           user_visible_status, user_visible_message, created_at
    FROM app_safety_report_events
    WHERE report_id = ?
    ORDER BY sequence ASC
  `).bind(reportId).all<{
    sequence: number
    event_type: string
    status_from: string | null
    status_to: string
    reason_code: string
    user_visible_status: string
    user_visible_message: string
    created_at: string
  }>()
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'moderation.report.evidence_access', 'app_safety_report', ?, NULL, ?, ?)
  `).bind(
    `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
    adminId,
    reportId,
    JSON.stringify({
      accessReason: 'safety_review',
      requestId,
      evidenceDigest: evidence.evidence_digest,
      messageIds: messages.map(message => message.messageId),
    }),
    now.toISOString(),
  ).run()
  return {
    ...mapReportSummary(report, adminId),
    description: report.description_text,
    userVisibleMessage: report.user_visible_message,
    evidence: {
      profileContentVersion: nullableNumber(evidence.profile_content_version),
      profileProjectionVersion: nullableNumber(evidence.profile_projection_version),
      mediaId: evidence.media_id,
      conversationId: evidence.conversation_id,
      messageId: evidence.message_id,
      evidenceDigest: evidence.evidence_digest,
      capturedAt: evidence.captured_at,
      messages,
    },
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      eventType: event.event_type,
      statusFrom: event.status_from,
      statusTo: event.status_to,
      reasonCode: event.reason_code,
      userVisibleStatus: normalizeVisibleStatus(event.user_visible_status),
      userVisibleMessage: event.user_visible_message,
      createdAt: event.created_at,
    })),
  }
}

export async function decideAdminSafetyReport(
  db: D1Database,
  adminId: number,
  reportIdValue: string,
  idempotencyKeyValue: string | null,
  input: AdminSafetyReportDecisionInput,
  now = new Date(),
): Promise<{ report: AdminSafetyReportSummary; replayed: boolean }> {
  const reportId = normalizeReportId(reportIdValue)
  const decision = normalizeDecision(input)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = safetyReviewerScope(adminId)
  const requestHash = await hashCanonical({ reportId, ...decision })
  const replay = await findSafetyIdempotency(db, actorScope, 'report_decision', idempotencyKey)
  if (replay) {
    assertSafetyIdempotencyHash(replay, requestHash)
    return { report: mapReportSummary(await requireReport(db, reportId), adminId), replayed: true }
  }
  const report = await requireAssignedReport(db, adminId, reportId)
  if (Number(report.version) !== decision.expectedVersion) {
    throw new AppSafetyError(409, 'REPORT_VERSION_CONFLICT', '举报已被更新，请刷新后重新确认')
  }
  if (isReportResolved(report.status)) {
    throw new AppSafetyError(409, 'REPORT_ALREADY_RESOLVED', '举报已形成结论')
  }
  assertDecisionTarget(report, decision)

  const nextVersion = decision.expectedVersion + 1
  const nowIso = now.toISOString()
  const mutationToken = crypto.randomUUID()
  const statements: D1PreparedStatement[] = []
  const actionConditions: string[] = []
  const actionConditionParams: unknown[] = []
  if (decision.actionType === 'conversation_restricted' || decision.actionType === 'conversation_closed') {
    const actionMessageId = await appendConversationSafetyAction(
      db,
      statements,
      report,
      decision.actionType,
      adminId,
      now,
    )
    actionConditions.push(`EXISTS (
      SELECT 1 FROM app_conversation_messages action_message
      WHERE action_message.id = ?
        AND action_message.conversation_id = app_safety_reports.conversation_id
    )`)
    actionConditionParams.push(actionMessageId)
  }
  else if (decision.actionType === 'profile_publication_paused') {
    actionConditions.push(`EXISTS (
      SELECT 1 FROM person_profiles profile
      WHERE profile.id = app_safety_reports.profile_id
        AND profile.publication_status = 'suspended'
    )`)
  }
  const actionCondition = actionConditions.length ? actionConditions.join(' AND ') : '1 = 1'

  statements.push(db.prepare(`
    UPDATE app_safety_reports
    SET status = ?, user_visible_status = ?, user_visible_message = ?,
        version = ?, mutation_token = ?, updated_at = ?, resolved_at = ?
    WHERE id = ? AND version = ? AND assigned_admin_id = ?
      AND status IN ('submitted', 'triaged', 'investigating')
      AND ${actionCondition}
  `).bind(
    decision.outcome,
    decision.outcome,
    decision.userVisibleMessage,
    nextVersion,
    mutationToken,
    nowIso,
    nowIso,
    reportId,
    decision.expectedVersion,
    adminId,
    ...actionConditionParams,
  ))
  statements.push(db.prepare(`
    INSERT INTO app_safety_report_events (
      id, report_id, sequence, actor_type, actor_account_id, actor_admin_id,
      event_type, status_from, status_to, reason_code,
      user_visible_status, user_visible_message, created_at
    )
    SELECT ?, id,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_safety_report_events WHERE report_id = ?),
           'admin', NULL, ?, ?, ?, status, ?, user_visible_status,
           user_visible_message, ?
    FROM app_safety_reports
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    `rpe_${crypto.randomUUID().replace(/-/gu, '')}`,
    reportId,
    adminId,
    decision.outcome,
    report.status,
    decision.decisionReasonCode,
    nowIso,
    reportId,
    nextVersion,
    mutationToken,
    adminId,
  ))
  statements.push(db.prepare(`
    INSERT INTO app_safety_idempotency (
      actor_scope, operation, idempotency_key, request_hash,
      result_type, result_id, result_version, created_at
    )
    SELECT ?, 'report_decision', ?, ?, 'report', id, version, ?
    FROM app_safety_reports
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    actorScope,
    idempotencyKey,
    requestHash,
    nowIso,
    reportId,
    nextVersion,
    mutationToken,
    adminId,
  ))
  statements.push(db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, 'moderation.report.decision', 'app_safety_report', id, ?, ?, ?
    FROM app_safety_reports
    WHERE id = ? AND version = ? AND mutation_token = ? AND assigned_admin_id = ?
  `).bind(
    `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
    adminId,
    JSON.stringify({ status: report.status, version: report.version }),
    JSON.stringify({
      status: decision.outcome,
      version: nextVersion,
      actionType: decision.actionType,
      reasonCode: decision.decisionReasonCode,
      userVisibleMessageSha256: await sha256Hex(decision.userVisibleMessage),
      userVisibleMessageLength: decision.userVisibleMessage.length,
    }),
    nowIso,
    reportId,
    nextVersion,
    mutationToken,
    adminId,
  ))

  try {
    await db.batch(statements)
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'report_decision', idempotencyKey)
    if (concurrent) {
      assertSafetyIdempotencyHash(concurrent, requestHash)
      return { report: mapReportSummary(await requireReport(db, reportId), adminId), replayed: true }
    }
    throw new AppSafetyError(409, 'REPORT_DECISION_CONFLICT', '举报状态或关联安全动作已变化，请刷新后重试', true)
  }
  const stored = await findSafetyIdempotency(db, actorScope, 'report_decision', idempotencyKey)
  if (!stored) {
    throw new AppSafetyError(409, 'REPORT_DECISION_CONFLICT', '举报状态或关联安全动作已变化，请刷新后重试', true)
  }
  return { report: mapReportSummary(await requireReport(db, reportId), adminId), replayed: false }
}

export async function updateAdminMessagingRuntimeControl(
  db: D1Database,
  adminId: number,
  idempotencyKeyValue: string | null,
  input: AdminMessagingRuntimeControlInput,
  now = new Date(),
): Promise<{ control: AppMessagingRuntimeControl; replayed: boolean }> {
  const normalized = normalizeRuntimeControl(input)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = safetyReviewerScope(adminId)
  const requestHash = await hashCanonical(normalized)
  const replay = await findSafetyIdempotency(db, actorScope, 'runtime_control_update', idempotencyKey)
  if (replay) {
    assertSafetyIdempotencyHash(replay, requestHash)
    return { control: await getAppMessagingRuntimeControl(db), replayed: true }
  }
  const current = await getAppMessagingRuntimeControl(db)
  if (current.version !== normalized.expectedVersion) {
    throw new AppSafetyError(409, 'RUNTIME_CONTROL_VERSION_CONFLICT', '运行控制已被更新，请刷新后重新确认')
  }
  const nextVersion = current.version + 1
  const nowIso = now.toISOString()
  const mutationToken = crypto.randomUUID()
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_messaging_runtime_controls
        SET new_conversations_paused = ?, viewer_sends_paused = ?,
            operator_sends_paused = ?, emergency_reason_code = ?,
            user_visible_message = ?, max_open_conversations = ?,
            max_active_assignments_per_operator = ?, assignment_lease_minutes = ?,
            version = ?, mutation_token = ?, updated_by = ?, updated_at = ?
        WHERE scope = 'global' AND version = ?
      `).bind(
        normalized.newConversationsPaused ? 1 : 0,
        normalized.viewerSendsPaused ? 1 : 0,
        normalized.operatorSendsPaused ? 1 : 0,
        normalized.reasonCode,
        normalized.userVisibleMessage,
        normalized.maxOpenConversations,
        normalized.maxActiveAssignmentsPerOperator,
        normalized.assignmentLeaseMinutes,
        nextVersion,
        mutationToken,
        adminId,
        nowIso,
        normalized.expectedVersion,
      ),
      db.prepare(`
        INSERT INTO app_safety_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'runtime_control_update', ?, ?, 'runtime_control', scope, version, ?
        FROM app_messaging_runtime_controls
        WHERE scope = 'global' AND version = ? AND mutation_token = ? AND updated_by = ?
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, nextVersion, mutationToken, adminId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_messaging.runtime_control_update', 'app_messaging_runtime_control',
               scope, ?, ?, ?
        FROM app_messaging_runtime_controls
        WHERE scope = 'global' AND version = ? AND mutation_token = ? AND updated_by = ?
      `).bind(
        `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        JSON.stringify(runtimeControlAuditValue(current)),
        JSON.stringify({
          ...runtimeControlAuditValue(normalized),
          version: nextVersion,
          reasonCode: normalized.reasonCode,
          userVisibleMessageSha256: await sha256Hex(normalized.userVisibleMessage),
          userVisibleMessageLength: normalized.userVisibleMessage.length,
        }),
        nowIso,
        nextVersion,
        mutationToken,
        adminId,
      ),
    ])
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'runtime_control_update', idempotencyKey)
    if (concurrent) {
      assertSafetyIdempotencyHash(concurrent, requestHash)
      return { control: await getAppMessagingRuntimeControl(db), replayed: true }
    }
    throw new AppSafetyError(409, 'RUNTIME_CONTROL_VERSION_CONFLICT', '运行控制已被更新，请刷新后重新确认', true)
  }
  const stored = await findSafetyIdempotency(db, actorScope, 'runtime_control_update', idempotencyKey)
  if (!stored) {
    throw new AppSafetyError(409, 'RUNTIME_CONTROL_VERSION_CONFLICT', '运行控制已被更新，请刷新后重新确认', true)
  }
  return { control: await getAppMessagingRuntimeControl(db), replayed: false }
}

async function appendConversationSafetyAction(
  db: D1Database,
  statements: D1PreparedStatement[],
  report: ReportRow,
  actionType: 'conversation_restricted' | 'conversation_closed',
  adminId: number,
  now: Date,
): Promise<string> {
  if (!report.conversation_id) {
    throw new AppSafetyError(400, 'REPORT_ACTION_INVALID', '该举报没有可处置的平台话题')
  }
  const conversation = await db.prepare(`
    SELECT id, status, last_sequence
    FROM app_conversations WHERE id = ? LIMIT 1
  `).bind(report.conversation_id).first<{ id: string; status: string; last_sequence: number }>()
  if (!conversation || conversation.status !== 'active') {
    throw new AppSafetyError(409, 'CONVERSATION_ACTION_CONFLICT', '关联话题已不是可处置状态')
  }
  const assignment = await db.prepare(`
    SELECT assigned_admin_id, status, version
    FROM app_conversation_assignment_state
    WHERE conversation_id = ? AND status = 'active'
    LIMIT 1
  `).bind(conversation.id).first<{ assigned_admin_id: number; status: string; version: number }>()
  const nowIso = now.toISOString()
  const nextSequence = Number(conversation.last_sequence) + 1
  const messageId = prefixedId('msg')
  const closed = actionType === 'conversation_closed'
  const messageText = closed
    ? '平台因安全审核已关闭本话题，历史消息仍可查看。'
    : '平台因安全审核已将本话题转为只读，历史消息仍可查看。'
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
        SELECT 1 FROM app_safety_reports safety_report
        WHERE safety_report.id = ?
          AND safety_report.version = ?
          AND safety_report.assigned_admin_id = ?
          AND safety_report.status IN ('submitted', 'triaged', 'investigating')
      )
  `).bind(
    messageId,
    nextSequence,
    `system.safety_action.${report.id}.${nextSequence}`,
    messageText,
    await sha256Hex(messageText),
    nowIso,
    conversation.id,
    conversation.last_sequence,
    report.id,
    report.version,
    adminId,
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
    `report_${report.reason_code}`,
    closed ? `report_${report.reason_code}` : null,
    conversation.id,
    messageId,
  ))
  if (assignment) {
    const assignmentVersion = Number(assignment.version) + 1
    const token = crypto.randomUUID()
    statements.push(db.prepare(`
      UPDATE app_conversation_assignment_state
      SET assigned_admin_id = NULL, status = 'released', version = ?,
          lease_expires_at = NULL, mutation_token = ?, released_at = ?, updated_at = ?
      WHERE conversation_id = ? AND version = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM app_conversations WHERE id = ? AND status IN ('restricted', 'closed'))
        AND EXISTS (
          SELECT 1 FROM app_conversation_messages
          WHERE id = ? AND conversation_id = ?
        )
    `).bind(
      assignmentVersion,
      token,
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
             'safety_action', NULL, ?
      FROM app_conversation_assignment_state
      WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
    `).bind(
      `cae_${crypto.randomUUID().replace(/-/gu, '')}`,
      assignment.assigned_admin_id,
      nowIso,
      conversation.id,
      assignmentVersion,
      token,
    ))
  }
  return messageId
}

async function loadEvidenceMessages(
  db: D1Database,
  evidence: EvidenceRow,
): Promise<AdminSafetyEvidenceMessage[]> {
  if (!evidence.conversation_id || !evidence.message_id) return []
  const ids = [
    evidence.context_before_message_id,
    evidence.message_id,
    evidence.context_after_message_id,
  ].filter((id): id is string => Boolean(id))
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db.prepare(`
    SELECT id, sequence, sender_type, body_text, body_sha256
    FROM app_conversation_messages
    WHERE conversation_id = ? AND id IN (${placeholders})
      AND sender_type IN ('viewer', 'platform_operator', 'system')
    ORDER BY sequence ASC
  `).bind(evidence.conversation_id, ...ids).all<{
    id: string
    sequence: number
    sender_type: string
    body_text: string
    body_sha256: string
  }>()
  return rows.results.map(row => ({
    messageId: row.id,
    sequence: Number(row.sequence),
    role: row.id === evidence.message_id
      ? 'target'
      : row.id === evidence.context_before_message_id ? 'before' : 'after',
    senderType: normalizeSenderType(row.sender_type),
    text: row.body_text,
    bodySha256: row.body_sha256,
    snapshotIntegrityMatches: row.id === evidence.message_id && evidence.message_body_sha256
      ? row.body_sha256 === evidence.message_body_sha256
      : null,
  }))
}

async function requireAssignedReport(
  db: D1Database,
  adminId: number,
  reportId: string,
  now = new Date(),
) {
  const report = await requireReport(db, reportId)
  if (report.assigned_admin_id !== adminId) {
    await db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) VALUES (?, ?, 'moderation.report.assignment_denied', 'app_safety_report', ?, NULL, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
      adminId,
      reportId,
      JSON.stringify({ reasonCode: 'REPORT_ASSIGNMENT_REQUIRED' }),
      now.toISOString(),
    ).run()
    throw new AppSafetyError(403, 'REPORT_ASSIGNMENT_REQUIRED', '请先领取举报，再查看证据或形成结论')
  }
  return report
}

async function requireReport(db: D1Database, reportId: string): Promise<ReportRow> {
  const report = await db.prepare(`${REPORT_SELECT}
    WHERE report.id = ?
    LIMIT 1
  `).bind(reportId).first<ReportRow>()
  if (!report) throw new AppSafetyError(404, 'REPORT_NOT_FOUND', '举报不存在')
  return report
}

function mapReportSummary(row: ReportRow, adminId: number): AdminSafetyReportSummary {
  const assignmentStatus = row.assigned_admin_id == null
    ? 'unassigned'
    : row.assigned_admin_id === adminId ? 'mine' : 'other'
  return {
    reportId: row.id,
    target: {
      type: normalizeTargetType(row.target_type),
      profileId: row.profile_id,
      mediaId: row.media_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
    },
    reasonCode: row.reason_code,
    reasonLabel: row.reason_label,
    priority: normalizePriority(row.priority),
    status: row.status,
    userVisibleStatus: normalizeVisibleStatus(row.user_visible_status),
    assignment: {
      status: assignmentStatus,
      canClaim: !isReportResolved(row.status) && assignmentStatus !== 'other',
    },
    version: Number(row.version),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  }
}

function normalizeDecision(input: AdminSafetyReportDecisionInput): ReportDecision {
  const expectedVersion = Number(input.expectedVersion)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    throw new AppSafetyError(400, 'EXPECTED_VERSION_INVALID', 'expectedVersion 必须为正整数')
  }
  const outcome = input.outcome === 'actioned'
    ? 'actioned'
    : input.outcome === 'no_violation' ? 'no_violation' : null
  if (!outcome) throw new AppSafetyError(400, 'REPORT_OUTCOME_INVALID', '结论必须为 actioned 或 no_violation')
  const allowedActions = ['none', 'conversation_restricted', 'conversation_closed', 'profile_publication_paused']
  if (typeof input.actionType !== 'string' || !allowedActions.includes(input.actionType)) {
    throw new AppSafetyError(400, 'REPORT_ACTION_INVALID', '安全动作无效')
  }
  const actionType = input.actionType as ReportDecision['actionType']
  if ((outcome === 'no_violation') !== (actionType === 'none')) {
    throw new AppSafetyError(400, 'REPORT_ACTION_INVALID', '无违规结论必须选择无动作；已处置结论必须选择实际安全动作')
  }
  const decisionReasonCode = normalizeReasonCode(input.decisionReasonCode)
  const userVisibleMessage = normalizeUserVisibleMessage(input.userVisibleMessage)
  return { expectedVersion, outcome, actionType, decisionReasonCode, userVisibleMessage }
}

function assertDecisionTarget(report: ReportRow, decision: ReportDecision) {
  if (
    (decision.actionType === 'conversation_restricted' || decision.actionType === 'conversation_closed')
    && !['conversation', 'message'].includes(report.target_type)
  ) {
    throw new AppSafetyError(400, 'REPORT_ACTION_INVALID', '只有会话或消息举报可以直接处置关联话题')
  }
  if (
    decision.actionType === 'profile_publication_paused'
    && !['person_profile', 'media'].includes(report.target_type)
  ) {
    throw new AppSafetyError(400, 'REPORT_ACTION_INVALID', '只有人物或媒体举报可以引用既有资料暂停结果')
  }
}

function normalizeRuntimeControl(input: AdminMessagingRuntimeControlInput) {
  const expectedVersion = boundedInteger(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, 'expectedVersion')
  const newConversationsPaused = requiredBoolean(input.newConversationsPaused, 'newConversationsPaused')
  const viewerSendsPaused = requiredBoolean(input.viewerSendsPaused, 'viewerSendsPaused')
  const operatorSendsPaused = requiredBoolean(input.operatorSendsPaused, 'operatorSendsPaused')
  const reasonCode = normalizeReasonCode(input.reasonCode)
  const userVisibleMessage = normalizeUserVisibleMessage(input.userVisibleMessage)
  return {
    expectedVersion,
    newConversationsPaused,
    viewerSendsPaused,
    operatorSendsPaused,
    reasonCode,
    userVisibleMessage,
    maxOpenConversations: boundedInteger(input.maxOpenConversations, 1, 100_000, 'maxOpenConversations'),
    maxActiveAssignmentsPerOperator: boundedInteger(
      input.maxActiveAssignmentsPerOperator,
      1,
      1_000,
      'maxActiveAssignmentsPerOperator',
    ),
    assignmentLeaseMinutes: boundedInteger(input.assignmentLeaseMinutes, 5, 1_440, 'assignmentLeaseMinutes'),
  }
}

function runtimeControlAuditValue(value: {
  newConversationsPaused: boolean
  viewerSendsPaused: boolean
  operatorSendsPaused: boolean
  maxOpenConversations: number
  maxActiveAssignmentsPerOperator: number
  assignmentLeaseMinutes: number
  version?: number
}) {
  return {
    newConversationsPaused: value.newConversationsPaused,
    viewerSendsPaused: value.viewerSendsPaused,
    operatorSendsPaused: value.operatorSendsPaused,
    maxOpenConversations: value.maxOpenConversations,
    maxActiveAssignmentsPerOperator: value.maxActiveAssignmentsPerOperator,
    assignmentLeaseMinutes: value.assignmentLeaseMinutes,
    version: value.version,
  }
}

function normalizeReportId(value: string): string {
  if (!REPORT_ID_PATTERN.test(value)) throw new AppSafetyError(404, 'REPORT_NOT_FOUND', '举报不存在')
  return value
}

function normalizeReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value.trim())) {
    throw new AppSafetyError(400, 'REASON_CODE_INVALID', '原因码必须为 3 至 80 位小写字母、数字或下划线')
  }
  return value.trim()
}

function normalizeUserVisibleMessage(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppSafetyError(400, 'USER_VISIBLE_MESSAGE_INVALID', '必须填写用户可见说明')
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (normalized.length < 1 || normalized.length > 300 || hasControlCharacter(normalized)) {
    throw new AppSafetyError(400, 'USER_VISIBLE_MESSAGE_INVALID', '用户可见说明必须为 1 至 300 个字符且不能包含控制字符')
  }
  return normalized
}

function boundedInteger(value: unknown, min: number, max: number, field: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AppSafetyError(400, 'RUNTIME_CONTROL_INVALID', `${field} 必须为 ${min} 至 ${max} 的整数`)
  }
  return number
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== 'boolean') {
    throw new AppSafetyError(400, 'RUNTIME_CONTROL_INVALID', `${field} 必须为布尔值`)
  }
  return value
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
  })
}

function normalizeTargetType(value: string): AppSafetyReportTargetType {
  if (value === 'media' || value === 'conversation' || value === 'message') return value
  return 'person_profile'
}

function normalizePriority(value: string): AppSafetyPriority {
  if (value === 'p0' || value === 'p1' || value === 'p2') return value
  return 'p3'
}

function normalizeVisibleStatus(value: string): AppSafetyReportStatus {
  if (value === 'processing' || value === 'actioned' || value === 'no_violation' || value === 'closed') return value
  return 'submitted'
}

function normalizeSenderType(value: string): 'viewer' | 'platform_operator' | 'system' {
  if (value === 'platform_operator' || value === 'system') return value
  return 'viewer'
}

function nullableNumber(value: number | null) {
  return value == null ? null : Number(value)
}

function isReportResolved(status: string) {
  return status === 'actioned' || status === 'no_violation' || status === 'closed'
}

function safetyReviewerScope(adminId: number) {
  return `safety-reviewer:${adminId}`
}

async function findSafetyIdempotency(
  db: D1Database,
  actorScope: string,
  operation: 'report_claim' | 'report_decision' | 'runtime_control_update',
  idempotencyKey: string,
): Promise<SafetyIdempotencyRow | null> {
  return db.prepare(`
    SELECT request_hash, result_id, result_version
    FROM app_safety_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<SafetyIdempotencyRow>()
}

function assertSafetyIdempotencyHash(row: SafetyIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于另一项操作')
  }
}

async function insertSafetyIdempotency(
  db: D1Database,
  actorScope: string,
  operation: 'report_claim',
  idempotencyKey: string,
  requestHash: string,
  resultType: 'report',
  resultId: string,
  resultVersion: number,
  now: Date,
) {
  try {
    await db.prepare(`
      INSERT INTO app_safety_idempotency (
        actor_scope, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      actorScope,
      operation,
      idempotencyKey,
      requestHash,
      resultType,
      resultId,
      resultVersion,
      now.toISOString(),
    ).run()
  }
  catch {
    const existing = await findSafetyIdempotency(db, actorScope, operation, idempotencyKey)
    if (!existing) throw new AppSafetyError(409, 'REPORT_ASSIGNMENT_CONFLICT', '举报分配状态已变化，请刷新后重试', true)
    assertSafetyIdempotencyHash(existing, requestHash)
  }
}
