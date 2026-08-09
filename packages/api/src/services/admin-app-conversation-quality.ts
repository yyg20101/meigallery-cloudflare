import {
  APP_MESSAGING_DISCLOSURE_TEXT,
  APP_MESSAGING_DISCLOSURE_VERSION,
  AppMessagingError,
  hashCanonical,
  normalizeIdempotencyKey,
  sha256Hex,
} from './app-messaging'

const SAMPLE_ID_PATTERN = /^cqs_[A-Za-z0-9_-]{1,76}$/u
const GROUP_ID_PATTERN = /^cgrp_[A-Za-z0-9_-]{1,74}$/u
const TASK_ID_PATTERN = /^cqit_[A-Za-z0-9_-]{1,75}$/u
const MAX_LIST_SIZE = 100
const DEFAULT_LIST_SIZE = 50
const MAX_SELECTION_POOL = 5000
const REVIEW_LEASE_MINUTES = 60

const SELECTION_REASONS = [
  'routine_quality_review',
  'disclosure_focus',
  'coaching_follow_up',
  'policy_follow_up',
] as const

const REVIEW_REASONS = [
  'routine_quality_review',
  'disclosure_investigation',
  'coaching_follow_up',
] as const

const ISSUE_CODES = [
  'disclosure_missing',
  'impersonation_or_identity_confusion',
  'prohibited_promise',
  'privacy_exposure',
  'harassment_or_disrespect',
  'inaccurate_public_information',
  'unresolved_viewer_need',
  'unsafe_language',
  'process_noncompliance',
  'other',
] as const

const SAFETY_REASON_CODES = [
  'suspected_impersonation',
  'harassment_threat',
  'fraud_inducement',
  'privacy_exposure',
  'minor_safety',
  'imminent_danger',
  'other',
] as const

export interface ConversationQualityActor {
  adminId: number
  role: string
}

export interface AdminConversationQualityListQuery {
  status: 'open' | 'pending' | 'in_review' | 'completed' | 'voided' | 'all'
  groupId: string | 'unscoped' | null
  limit: number
}

export interface AdminConversationQualitySampleSummary {
  sampleId: string
  selectionRunId: string
  conversationId: string
  messageId: string
  messageCreatedAt: string
  profile: {
    profileId: string
    displayName: string
  }
  group: {
    groupId: string | null
    name: string | null
  }
  actualOperator: {
    adminId: number
    displayName: string
  }
  disclosureVersion: string
  approvedScriptVersionId: string | null
  disclosureIntegrityStatus: DisclosureIntegrityStatus
  status: QualitySampleStatus
  review: {
    status: 'unassigned' | 'mine' | 'other'
    reviewerAdminId: number | null
    reviewerDisplayName: string | null
    leaseExpiresAt: string | null
    reasonCode: string | null
    canClaim: boolean
  }
  version: number
  conclusion: null | {
    identityDisclosureRating: 'pass' | 'fail'
    serviceQualityRating: QualityRating
    policyLanguageRating: QualityRating
    overallScore: number
    outcome: QualityOutcome
    issueCodes: string[]
    linkedSafetyEscalationId: string | null
    completedAt: string
  }
  voidReasonCode: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminConversationQualityTask {
  taskId: string
  sampleId: string
  group: { groupId: string | null; name: string | null }
  assignee: { adminId: number; displayName: string }
  issueCode: string
  title: string
  guidance: string
  status: 'open' | 'in_progress' | 'completed' | 'cancelled'
  dueAt: string
  version: number
  completionNote: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  canUpdate: boolean
  canCancel: boolean
}

export interface AdminConversationQualitySnapshot {
  generatedAt: string
  timezone: 'Asia/Shanghai'
  permissions: {
    isOwner: boolean
    reviewGroupIds: string[]
    canReviewUnscoped: boolean
    canCreateSelection: boolean
    canViewAllTasks: boolean
  }
  groups: Array<{
    groupId: string
    name: string
    memberRole: 'lead' | 'quality' | 'owner'
    activeOperatorCount: number
  }>
  operators: Array<{
    adminId: number
    displayName: string
    groupIds: string[]
  }>
  samples: AdminConversationQualitySampleSummary[]
  tasks: AdminConversationQualityTask[]
  selectionRuns: Array<{
    selectionRunId: string
    groupId: string | null
    groupName: string | null
    scopeType: 'group' | 'unscoped'
    windowStart: string
    windowEnd: string
    requestedSampleSize: number
    eligibleCount: number
    selectedCount: number
    reasonCode: string
    selectedByDisplayName: string
    createdAt: string
  }>
  counters: {
    pending: number
    inReview: number
    completed: number
    disclosureAttention: number
    overdueTasks: number
  }
  diagnostics: Array<{
    code: 'no_review_scope' | 'unscoped_messages' | 'disclosure_attention' | 'overdue_tasks'
    severity: 'info' | 'warning' | 'critical'
    count: number
    message: string
  }>
}

export interface CreateQualitySelectionRunInput {
  groupId?: unknown
  windowStart?: unknown
  windowEnd?: unknown
  sampleSize?: unknown
  reasonCode?: unknown
}

export interface ClaimQualitySampleInput {
  reviewReasonCode?: unknown
}

export interface DecideQualitySampleInput {
  expectedVersion?: unknown
  identityDisclosureRating?: unknown
  serviceQualityRating?: unknown
  policyLanguageRating?: unknown
  overallScore?: unknown
  outcome?: unknown
  issueCodes?: unknown
  reviewerSummary?: unknown
  improvementTask?: unknown
  safetyReferral?: unknown
}

export interface UpdateQualityTaskInput {
  expectedVersion?: unknown
  status?: unknown
  reasonCode?: unknown
  completionNote?: unknown
}

export interface VoidQualitySampleInput {
  expectedVersion?: unknown
  reasonCode?: unknown
}

export interface AdminConversationQualitySampleDetail extends AdminConversationQualitySampleSummary {
  bodyAccess: {
    status: 'authorized' | 'closed_after_review'
    purpose: 'quality_review' | null
    reasonCode: string | null
  }
  evidence: null | {
    evidenceDigest: string
    capturedAt: string
    integrityMatches: boolean
    messages: Array<{
      messageId: string
      sequence: number
      role: 'before' | 'target' | 'after'
      senderType: 'viewer' | 'platform_operator' | 'system'
      text: string
      bodySha256: string
      snapshotIntegrityMatches: boolean
    }>
    disclosure: null | {
      messageId: string
      sequence: number
      text: string
      bodySha256: string
      snapshotIntegrityMatches: boolean
      expectedIntegrityMatches: boolean | null
    }
  }
  reviewerSummary: string | null
}

type QualitySampleStatus = 'pending' | 'in_review' | 'completed' | 'voided'
type DisclosureIntegrityStatus = 'verified' | 'missing' | 'mismatch' | 'unverifiable'
type QualityRating = 'pass' | 'needs_improvement' | 'fail'
type QualityOutcome = 'pass' | 'coaching_required' | 'safety_referral'

type QualityScopeRow = {
  group_id: string
  group_name: string
  member_role: string | null
  active_operator_count: number
}

type QualityOperatorRow = {
  admin_id: number
  display_name: string
  group_id: string
}

type QualityAccess = {
  adminId: number
  isOwner: boolean
  groupIds: string[]
  groups: AdminConversationQualitySnapshot['groups']
}

type QualitySampleRow = {
  id: string
  selection_run_id: string
  conversation_id: string
  message_id: string
  message_created_at: string
  profile_id: string
  profile_display_name: string
  group_id: string | null
  group_name: string | null
  actual_operator_admin_id: number
  actual_operator_display_name: string
  assignment_version: number
  disclosure_version: string
  approved_script_version_id: string | null
  disclosure_integrity_status: string
  status: string
  assigned_reviewer_admin_id: number | null
  reviewer_display_name: string | null
  reviewer_lease_expires_at: string | null
  review_reason_code: string | null
  version: number
  identity_disclosure_rating: string | null
  service_quality_rating: string | null
  policy_language_rating: string | null
  overall_score: number | null
  outcome: string | null
  issue_codes_json: string | null
  reviewer_summary_text: string | null
  linked_safety_escalation_id: string | null
  void_reason_code: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

type QualityTaskRow = {
  id: string
  sample_id: string
  group_id: string | null
  group_name: string | null
  assignee_admin_id: number
  assignee_display_name: string
  issue_code: string
  title_text: string
  guidance_text: string
  status: string
  due_at: string
  version: number
  completion_note_text: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

type SelectionRunRow = {
  id: string
  group_id: string | null
  group_name: string | null
  scope_type: string
  window_start: string
  window_end: string
  requested_sample_size: number
  eligible_count: number
  selected_count: number
  reason_code: string
  selected_by_display_name: string
  created_at: string
}

type SelectionCandidateRow = {
  message_id: string
  conversation_id: string
  profile_id: string
  group_id: string | null
  assignment_version: number
  disclosure_version: string
  actual_operator_admin_id: number
  approved_script_version_id: string | null
  message_body_sha256: string
  message_created_at: string
  before_message_id: string | null
  before_body_sha256: string | null
  after_message_id: string | null
  after_body_sha256: string | null
  disclosure_message_id: string | null
  disclosure_body_sha256: string | null
}

type QualityEvidenceRow = {
  context_before_message_id: string | null
  context_before_body_sha256: string | null
  target_message_id: string
  target_message_body_sha256: string
  context_after_message_id: string | null
  context_after_body_sha256: string | null
  disclosure_message_id: string | null
  disclosure_message_body_sha256: string | null
  expected_disclosure_body_sha256: string | null
  evidence_digest: string
  captured_at: string
}

type QualityMessageRow = {
  id: string
  sequence: number
  sender_type: string
  actor_admin_id: number | null
  body_text: string
  body_sha256: string
}

type QualityIdempotencyRow = {
  request_hash: string
  result_type: string
  result_id: string
  result_version: number
}

type CounterRow = {
  pending_count: number
  in_review_count: number
  completed_count: number
  disclosure_attention_count: number
}

type CountRow = { count: number }

const SAMPLE_SELECT = `
  SELECT sample.id, sample.selection_run_id, sample.conversation_id, sample.message_id,
         message.created_at AS message_created_at,
         sample.profile_id, profile.display_name AS profile_display_name,
         sample.group_id, operation_group.name AS group_name,
         sample.actual_operator_admin_id,
         COALESCE(operator.nickname, operator.username, '管理员 #' || operator.id) AS actual_operator_display_name,
         sample.assignment_version, sample.disclosure_version, sample.approved_script_version_id,
         sample.disclosure_integrity_status, sample.status,
         sample.assigned_reviewer_admin_id,
         COALESCE(reviewer.nickname, reviewer.username, '管理员 #' || reviewer.id) AS reviewer_display_name,
         sample.reviewer_lease_expires_at, sample.review_reason_code, sample.version,
         sample.identity_disclosure_rating, sample.service_quality_rating,
         sample.policy_language_rating, sample.overall_score, sample.outcome,
         sample.issue_codes_json, sample.reviewer_summary_text,
         sample.linked_safety_escalation_id, sample.void_reason_code,
         sample.created_at, sample.updated_at, sample.completed_at
  FROM app_conversation_quality_samples sample
  JOIN app_conversation_messages message ON message.id = sample.message_id
  JOIN person_profiles profile ON profile.id = sample.profile_id
  JOIN users operator ON operator.id = sample.actual_operator_admin_id
  LEFT JOIN app_conversation_groups operation_group ON operation_group.id = sample.group_id
  LEFT JOIN users reviewer ON reviewer.id = sample.assigned_reviewer_admin_id
`

export function parseAdminConversationQualityListQuery(input: {
  status?: string
  groupId?: string
  limit?: string
}): AdminConversationQualityListQuery {
  const requestedStatus = input.status?.trim() || 'open'
  if (!['open', 'pending', 'in_review', 'completed', 'voided', 'all'].includes(requestedStatus)) {
    throw new AppMessagingError(400, 'QUALITY_STATUS_INVALID', '抽检状态筛选无效')
  }
  const requestedGroup = input.groupId?.trim() || null
  const groupId = requestedGroup === 'unscoped'
    ? 'unscoped'
    : requestedGroup ? normalizeGroupId(requestedGroup) : null
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    status: requestedStatus as AdminConversationQualityListQuery['status'],
    groupId,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIST_SIZE)
      : DEFAULT_LIST_SIZE,
  }
}

export async function getAdminConversationQualitySnapshot(
  db: D1Database,
  actor: ConversationQualityActor,
  query: AdminConversationQualityListQuery,
  now = new Date(),
): Promise<AdminConversationQualitySnapshot> {
  const access = await resolveQualityAccess(db, actor)
  assertRequestedScope(access, query.groupId)
  const sampleScope = buildSampleScope(access, query.groupId)
  const statusCondition = qualityStatusCondition(query.status)
  const taskScope = buildTaskScope(access, actor.adminId, query.groupId)
  const nowIso = now.toISOString()

  const [samplesResult, tasksResult, runsResult, counter, overdueTasks, unscopedFacts, operators] = await Promise.all([
    db.prepare(`${SAMPLE_SELECT}
      WHERE ${sampleScope.sql} AND ${statusCondition}
      ORDER BY
        CASE sample.status WHEN 'pending' THEN 0 WHEN 'in_review' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        sample.created_at ASC, sample.id ASC
      LIMIT ?
    `).bind(...sampleScope.bindings, query.limit).all<QualitySampleRow>(),
    db.prepare(`
      SELECT task.id, task.sample_id, task.group_id, operation_group.name AS group_name,
             task.assignee_admin_id,
             COALESCE(assignee.nickname, assignee.username, '管理员 #' || assignee.id) AS assignee_display_name,
             task.issue_code, task.title_text, task.guidance_text, task.status, task.due_at,
             task.version, task.completion_note_text, task.created_at, task.updated_at, task.completed_at
      FROM app_conversation_quality_improvement_tasks task
      JOIN users assignee ON assignee.id = task.assignee_admin_id
      LEFT JOIN app_conversation_groups operation_group ON operation_group.id = task.group_id
      WHERE ${taskScope.sql}
      ORDER BY
        CASE task.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        task.due_at ASC, task.id ASC
      LIMIT 100
    `).bind(...taskScope.bindings).all<QualityTaskRow>(),
    db.prepare(`
      SELECT run.id, run.group_id, operation_group.name AS group_name, run.scope_type,
             run.window_start, run.window_end, run.requested_sample_size,
             run.eligible_count, run.selected_count, run.reason_code,
             COALESCE(actor.nickname, actor.username, '管理员 #' || actor.id) AS selected_by_display_name,
             run.created_at
      FROM app_conversation_quality_selection_runs run
      JOIN users actor ON actor.id = run.selected_by_admin_id
      LEFT JOIN app_conversation_groups operation_group ON operation_group.id = run.group_id
      WHERE ${sampleScope.sql.replaceAll('sample.group_id', 'run.group_id')}
      ORDER BY run.created_at DESC, run.id DESC
      LIMIT 20
    `).bind(...sampleScope.bindings).all<SelectionRunRow>(),
    db.prepare(`
      SELECT
        SUM(CASE WHEN sample.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN sample.status = 'in_review' THEN 1 ELSE 0 END) AS in_review_count,
        SUM(CASE WHEN sample.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN sample.status IN ('pending', 'in_review')
          AND sample.disclosure_integrity_status IN ('missing', 'mismatch') THEN 1 ELSE 0 END)
          AS disclosure_attention_count
      FROM app_conversation_quality_samples sample
      WHERE ${sampleScope.sql}
    `).bind(...sampleScope.bindings).first<CounterRow>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_conversation_quality_improvement_tasks task
      WHERE ${taskScope.sql}
        AND task.status IN ('open', 'in_progress')
        AND datetime(task.due_at) < datetime(?)
    `).bind(...taskScope.bindings, nowIso).first<CountRow>(),
    access.isOwner
      ? db.prepare(`
          SELECT COUNT(*) AS count
          FROM app_conversation_operator_message_facts fact
          WHERE fact.group_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM app_conversation_quality_samples sample WHERE sample.message_id = fact.message_id
            )
        `).first<CountRow>()
      : Promise.resolve(null),
    listQualityOperators(db, access),
  ])

  const samples = samplesResult.results.map(row => mapSampleSummary(row, actor.adminId, access, now))
  const tasks = tasksResult.results.map(row => mapTask(row, actor.adminId, access))
  const counters = {
    pending: Number(counter?.pending_count ?? 0),
    inReview: Number(counter?.in_review_count ?? 0),
    completed: Number(counter?.completed_count ?? 0),
    disclosureAttention: Number(counter?.disclosure_attention_count ?? 0),
    overdueTasks: Number(overdueTasks?.count ?? 0),
  }
  const diagnostics: AdminConversationQualitySnapshot['diagnostics'] = []
  if (!access.isOwner && access.groupIds.length === 0) {
    diagnostics.push({
      code: 'no_review_scope',
      severity: 'info',
      count: 0,
      message: '当前账号没有运营组长或质检成员范围，只能查看分配给自己的改进任务。',
    })
  }
  if (Number(unscopedFacts?.count ?? 0) > 0) {
    diagnostics.push({
      code: 'unscoped_messages',
      severity: 'warning',
      count: Number(unscopedFacts!.count),
      message: '存在尚未归属运营组的回复事实，只允许 Owner 选择“未归组”范围抽检。',
    })
  }
  if (counters.disclosureAttention > 0) {
    diagnostics.push({
      code: 'disclosure_attention',
      severity: 'critical',
      count: counters.disclosureAttention,
      message: '存在披露缺失或完整性不一致的待处理样本，结论不能标记为通过。',
    })
  }
  if (counters.overdueTasks > 0) {
    diagnostics.push({
      code: 'overdue_tasks',
      severity: 'warning',
      count: counters.overdueTasks,
      message: '存在已超过截止时间的改进任务，请由负责人跟进。',
    })
  }

  return {
    generatedAt: nowIso,
    timezone: 'Asia/Shanghai',
    permissions: {
      isOwner: access.isOwner,
      reviewGroupIds: access.groupIds,
      canReviewUnscoped: access.isOwner,
      canCreateSelection: access.isOwner || access.groupIds.length > 0,
      canViewAllTasks: access.isOwner,
    },
    groups: access.groups,
    operators,
    samples,
    tasks,
    selectionRuns: runsResult.results.map(mapSelectionRun),
    counters,
    diagnostics,
  }
}

export async function createAdminConversationQualitySelectionRun(
  db: D1Database,
  actor: ConversationQualityActor,
  idempotencyKeyValue: string | null,
  input: CreateQualitySelectionRunInput,
  now = new Date(),
): Promise<{
  selectionRun: AdminConversationQualitySnapshot['selectionRuns'][number]
  sampleIds: string[]
  replayed: boolean
}> {
  const access = await resolveQualityAccess(db, actor)
  const normalized = normalizeSelectionInput(input, now)
  requireSelectionScope(access, normalized.groupId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical(normalized)
  const replay = await findQualityIdempotency(db, actor.adminId, 'selection_run_create', idempotencyKey)
  if (replay) {
    assertQualityIdempotency(replay, requestHash)
    return {
      selectionRun: mapSelectionRun(await requireSelectionRun(db, replay.result_id)),
      sampleIds: await listSelectionSampleIds(db, replay.result_id),
      replayed: true,
    }
  }

  const scopeSql = normalized.groupId ? 'fact.group_id = ?' : 'fact.group_id IS NULL'
  const scopeBindings = normalized.groupId ? [normalized.groupId] : []
  const eligible = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversation_operator_message_facts fact
    JOIN app_conversation_messages message ON message.id = fact.message_id
    WHERE ${scopeSql}
      AND datetime(fact.created_at) >= datetime(?)
      AND datetime(fact.created_at) < datetime(?)
      AND message.sender_type = 'platform_operator'
      AND message.actor_admin_id = fact.actual_operator_admin_id
      AND NOT EXISTS (
        SELECT 1 FROM app_conversation_quality_samples sample WHERE sample.message_id = fact.message_id
      )
  `).bind(...scopeBindings, normalized.windowStart, normalized.windowEnd).first<CountRow>()

  const candidates = await db.prepare(`
    SELECT fact.message_id, fact.conversation_id, fact.profile_id, fact.group_id,
           fact.assignment_version, fact.disclosure_version, fact.actual_operator_admin_id,
           fact.approved_script_version_id, fact.message_body_sha256,
           message.created_at AS message_created_at,
           before_message.id AS before_message_id,
           before_message.body_sha256 AS before_body_sha256,
           after_message.id AS after_message_id,
           after_message.body_sha256 AS after_body_sha256,
           disclosure.id AS disclosure_message_id,
           disclosure.body_sha256 AS disclosure_body_sha256
    FROM app_conversation_operator_message_facts fact
    JOIN app_conversation_messages message ON message.id = fact.message_id
    JOIN app_conversations conversation ON conversation.id = fact.conversation_id
    LEFT JOIN app_conversation_messages before_message
      ON before_message.conversation_id = message.conversation_id
     AND before_message.sequence = message.sequence - 1
    LEFT JOIN app_conversation_messages after_message
      ON after_message.conversation_id = message.conversation_id
     AND after_message.sequence = message.sequence + 1
    LEFT JOIN app_conversation_messages disclosure
      ON disclosure.conversation_id = conversation.id
     AND disclosure.sequence = 1
     AND disclosure.sender_type = 'system'
     AND disclosure.client_message_id = 'system.' || conversation.disclosure_version
    WHERE ${scopeSql}
      AND datetime(fact.created_at) >= datetime(?)
      AND datetime(fact.created_at) < datetime(?)
      AND message.sender_type = 'platform_operator'
      AND message.actor_admin_id = fact.actual_operator_admin_id
      AND NOT EXISTS (
        SELECT 1 FROM app_conversation_quality_samples sample WHERE sample.message_id = fact.message_id
      )
    ORDER BY fact.created_at ASC, fact.message_id ASC, fact.actual_operator_admin_id ASC
    LIMIT ?
  `).bind(
    ...scopeBindings,
    normalized.windowStart,
    normalized.windowEnd,
    MAX_SELECTION_POOL,
  ).all<SelectionCandidateRow>()

  const selected = selectCandidatesRoundRobin(candidates.results, normalized.sampleSize)
  const expectedDisclosureHash = await sha256Hex(APP_MESSAGING_DISCLOSURE_TEXT)
  const prepared = await Promise.all(selected.map(async (candidate) => {
    const expectedHash = candidate.disclosure_version === APP_MESSAGING_DISCLOSURE_VERSION
      ? expectedDisclosureHash
      : null
    const integrityStatus = resolveDisclosureIntegrity(candidate, expectedHash)
    const evidenceDigest = await hashCanonical({
      conversationId: candidate.conversation_id,
      before: [candidate.before_message_id, candidate.before_body_sha256],
      target: [candidate.message_id, candidate.message_body_sha256],
      after: [candidate.after_message_id, candidate.after_body_sha256],
      disclosure: [candidate.disclosure_message_id, candidate.disclosure_body_sha256, expectedHash],
      capturedAt: now.toISOString(),
    })
    return {
      candidate,
      sampleId: qualityId('cqs'),
      integrityStatus,
      expectedHash,
      evidenceDigest,
    }
  }))

  const runId = qualityId('cqsr')
  const nowIso = now.toISOString()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_conversation_quality_selection_runs (
        id, group_id, scope_type, window_start, window_end,
        requested_sample_size, eligible_count, selected_count,
        selection_strategy, reason_code, selected_by_admin_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'operator_round_robin_oldest', ?, ?, ?
      WHERE ? = 1 OR EXISTS (
        SELECT 1 FROM app_conversation_group_members live_member
        JOIN app_conversation_groups live_group ON live_group.id = live_member.group_id
        WHERE live_member.group_id = ? AND live_member.admin_id = ?
          AND live_member.status = 'active'
          AND live_member.member_role IN ('lead', 'quality')
          AND live_group.status = 'active'
      )
    `).bind(
      runId,
      normalized.groupId,
      normalized.groupId ? 'group' : 'unscoped',
      normalized.windowStart,
      normalized.windowEnd,
      normalized.sampleSize,
      Number(eligible?.count ?? 0),
      prepared.length,
      normalized.reasonCode,
      actor.adminId,
      nowIso,
      access.isOwner ? 1 : 0,
      normalized.groupId,
      actor.adminId,
    ),
  ]

  for (const item of prepared) {
    const candidate = item.candidate
    statements.push(
      db.prepare(`
        INSERT INTO app_conversation_quality_samples (
          id, selection_run_id, conversation_id, message_id, profile_id, group_id,
          actual_operator_admin_id, assignment_version, disclosure_version,
          approved_script_version_id, disclosure_integrity_status, status,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      `).bind(
        item.sampleId,
        runId,
        candidate.conversation_id,
        candidate.message_id,
        candidate.profile_id,
        candidate.group_id,
        candidate.actual_operator_admin_id,
        candidate.assignment_version,
        candidate.disclosure_version,
        candidate.approved_script_version_id,
        item.integrityStatus,
        nowIso,
        nowIso,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_sample_evidence (
          sample_id, context_before_message_id, context_before_body_sha256,
          target_message_id, target_message_body_sha256,
          context_after_message_id, context_after_body_sha256,
          disclosure_message_id, disclosure_message_body_sha256,
          expected_disclosure_body_sha256, evidence_digest, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        item.sampleId,
        candidate.before_message_id,
        candidate.before_body_sha256,
        candidate.message_id,
        candidate.message_body_sha256,
        candidate.after_message_id,
        candidate.after_body_sha256,
        candidate.disclosure_message_id,
        candidate.disclosure_body_sha256,
        item.expectedHash,
        item.evidenceDigest,
        nowIso,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_sample_events (
          id, sample_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        ) VALUES (?, ?, 1, 'selected', NULL, 'pending', ?, ?, ?)
      `).bind(qualityId('cqse'), item.sampleId, normalized.reasonCode, actor.adminId, nowIso),
    )
  }

  statements.push(
    db.prepare(`
      INSERT INTO app_conversation_quality_idempotency (
        admin_id, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, created_at
      ) SELECT ?, 'selection_run_create', ?, ?, 'selection_run', id, 1, ?
        FROM app_conversation_quality_selection_runs WHERE id = ?
    `).bind(actor.adminId, idempotencyKey, requestHash, nowIso, runId),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) SELECT ?, ?, 'app_conversation_quality.selection_run_create',
               'app_conversation_quality_selection_run', id, NULL, ?, ?
        FROM app_conversation_quality_selection_runs WHERE id = ?
    `).bind(
      qualityId('audit'),
      actor.adminId,
      JSON.stringify({
        groupId: normalized.groupId,
        windowStart: normalized.windowStart,
        windowEnd: normalized.windowEnd,
        requestedSampleSize: normalized.sampleSize,
        eligibleCount: Number(eligible?.count ?? 0),
        selectedCount: prepared.length,
        reasonCode: normalized.reasonCode,
      }),
      nowIso,
      runId,
    ),
  )

  try {
    await db.batch(statements)
  }
  catch {
    const concurrent = await findQualityIdempotency(db, actor.adminId, 'selection_run_create', idempotencyKey)
    if (concurrent) {
      assertQualityIdempotency(concurrent, requestHash)
      return {
        selectionRun: mapSelectionRun(await requireSelectionRun(db, concurrent.result_id)),
        sampleIds: await listSelectionSampleIds(db, concurrent.result_id),
        replayed: true,
      }
    }
    throw new AppMessagingError(409, 'QUALITY_SELECTION_CONFLICT', '抽样候选已变化，请刷新后重新选择', true)
  }

  const stored = await findQualityIdempotency(db, actor.adminId, 'selection_run_create', idempotencyKey)
  if (!stored) throw new AppMessagingError(409, 'QUALITY_SELECTION_CONFLICT', '抽样未能完整保存，请刷新后重试', true)
  return {
    selectionRun: mapSelectionRun(await requireSelectionRun(db, runId)),
    sampleIds: prepared.map(item => item.sampleId),
    replayed: false,
  }
}

export async function claimAdminConversationQualitySample(
  db: D1Database,
  actor: ConversationQualityActor,
  sampleIdValue: string,
  idempotencyKeyValue: string | null,
  input: ClaimQualitySampleInput,
  now = new Date(),
): Promise<{ sample: AdminConversationQualitySampleSummary; replayed: boolean }> {
  const sampleId = normalizeSampleId(sampleIdValue)
  const reasonCode = normalizeEnum(input.reviewReasonCode, REVIEW_REASONS, 'QUALITY_REVIEW_REASON_INVALID', '请选择有效的正文访问理由')
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ sampleId, reasonCode })
  const replay = await findQualityIdempotency(db, actor.adminId, 'sample_claim', idempotencyKey)
  const access = await resolveQualityAccess(db, actor)
  if (replay) {
    assertQualityIdempotency(replay, requestHash)
    const replayedSample = await requireSample(db, replay.result_id)
    assertSampleScope(access, replayedSample.group_id)
    return { sample: mapSampleSummary(replayedSample, actor.adminId, access, now), replayed: true }
  }

  const current = await requireSample(db, sampleId)
  assertSampleScope(access, current.group_id)
  if (current.actual_operator_admin_id === actor.adminId) {
    throw new AppMessagingError(403, 'QUALITY_REVIEW_SEPARATION_REQUIRED', '不能领取由本人实际回复的抽检样本')
  }
  if (current.status === 'completed' || current.status === 'voided') {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_FINALIZED', '该抽检样本已结束，不能重新领取')
  }
  const leaseActive = isFuture(current.reviewer_lease_expires_at, now)
  if (leaseActive && current.assigned_reviewer_admin_id !== actor.adminId) {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_TAKEN', '该样本正由其他质检员审核')
  }

  const nextVersion = Number(current.version) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + REVIEW_LEASE_MINUTES * 60_000).toISOString()
  const eventType = leaseActive && current.assigned_reviewer_admin_id === actor.adminId ? 'renewed' : 'claimed'
  const scopeGate = qualityScopeWriteGate(access, 'app_conversation_quality_samples.group_id')

  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_quality_samples
        SET status = 'in_review', assigned_reviewer_admin_id = ?,
            reviewer_lease_expires_at = ?, review_reason_code = ?,
            version = ?, mutation_token = ?, updated_at = ?
        WHERE id = ? AND version = ?
          AND status IN ('pending', 'in_review')
          AND actual_operator_admin_id <> ?
          AND (
            status = 'pending'
            OR datetime(reviewer_lease_expires_at) <= datetime(?)
            OR assigned_reviewer_admin_id = ?
          )
          AND ${scopeGate.sql}
      `).bind(
        actor.adminId,
        leaseExpiresAt,
        reasonCode,
        nextVersion,
        mutationToken,
        nowIso,
        sampleId,
        current.version,
        actor.adminId,
        nowIso,
        actor.adminId,
        ...scopeGate.bindings,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_sample_events (
          id, sample_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        )
        SELECT ?, sample.id,
               COALESCE((SELECT MAX(event.sequence) + 1
                 FROM app_conversation_quality_sample_events event WHERE event.sample_id = sample.id), 1),
               ?, ?, 'in_review', ?, ?, ?
        FROM app_conversation_quality_samples sample
        WHERE sample.id = ? AND sample.version = ? AND sample.mutation_token = ?
          AND sample.status = 'in_review' AND sample.assigned_reviewer_admin_id = ?
      `).bind(
        qualityId('cqse'),
        eventType,
        current.status,
        reasonCode,
        actor.adminId,
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
        actor.adminId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'sample_claim', ?, ?, 'sample', id, version, ?
        FROM app_conversation_quality_samples
        WHERE id = ? AND version = ? AND mutation_token = ?
          AND status = 'in_review' AND assigned_reviewer_admin_id = ?
      `).bind(
        actor.adminId,
        idempotencyKey,
        requestHash,
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
        actor.adminId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, ?, 'app_conversation_quality_sample', id, ?, ?, ?
        FROM app_conversation_quality_samples
        WHERE id = ? AND version = ? AND mutation_token = ?
          AND status = 'in_review' AND assigned_reviewer_admin_id = ?
      `).bind(
        qualityId('audit'),
        actor.adminId,
        eventType === 'renewed'
          ? 'app_conversation_quality.sample_renew'
          : 'app_conversation_quality.sample_claim',
        JSON.stringify({ status: current.status, version: current.version }),
        JSON.stringify({
          status: 'in_review',
          version: nextVersion,
          leaseExpiresAt,
          reviewReasonCode: reasonCode,
        }),
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
        actor.adminId,
      ),
    ])
  }
  catch {
    const concurrent = await findQualityIdempotency(db, actor.adminId, 'sample_claim', idempotencyKey)
    if (concurrent) {
      assertQualityIdempotency(concurrent, requestHash)
      return {
        sample: mapSampleSummary(await requireSample(db, concurrent.result_id), actor.adminId, access, now),
        replayed: true,
      }
    }
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_CLAIM_CONFLICT', '样本领取状态已变化，请刷新后重试', true)
  }

  const stored = await findQualityIdempotency(db, actor.adminId, 'sample_claim', idempotencyKey)
  if (!stored) throw new AppMessagingError(409, 'QUALITY_SAMPLE_CLAIM_CONFLICT', '样本领取状态已变化，请刷新后重试', true)
  return {
    sample: mapSampleSummary(await requireSample(db, sampleId), actor.adminId, access, now),
    replayed: false,
  }
}

export async function getAdminConversationQualitySample(
  db: D1Database,
  actor: ConversationQualityActor,
  sampleIdValue: string,
  accessReason: string,
  requestId: string,
  now = new Date(),
): Promise<AdminConversationQualitySampleDetail> {
  const sampleId = normalizeSampleId(sampleIdValue)
  const current = await requireSample(db, sampleId)
  const access = await resolveQualityAccess(db, actor)
  assertSampleScope(access, current.group_id)
  const summary = mapSampleSummary(current, actor.adminId, access, now)

  if (current.status === 'completed' || current.status === 'voided') {
    return {
      ...summary,
      bodyAccess: { status: 'closed_after_review', purpose: null, reasonCode: current.review_reason_code },
      evidence: null,
      reviewerSummary: current.actual_operator_admin_id === actor.adminId
        ? null
        : current.reviewer_summary_text,
    }
  }
  if (accessReason !== 'quality_review') {
    throw new AppMessagingError(400, 'QUALITY_ACCESS_REASON_INVALID', '正文访问目的必须为 quality_review')
  }
  if (
    current.status !== 'in_review'
    || current.assigned_reviewer_admin_id !== actor.adminId
    || !isFuture(current.reviewer_lease_expires_at, now)
  ) {
    await auditQualityBodyAccessDenied(db, actor.adminId, sampleId, requestId, now)
    throw new AppMessagingError(403, 'QUALITY_SAMPLE_CLAIM_REQUIRED', '请先领取样本并填写访问理由，再查看最小正文证据')
  }
  if (current.actual_operator_admin_id === actor.adminId) {
    await auditQualityBodyAccessDenied(db, actor.adminId, sampleId, requestId, now)
    throw new AppMessagingError(403, 'QUALITY_REVIEW_SEPARATION_REQUIRED', '不能查看由本人实际回复的抽检正文')
  }

  const evidence = await requireQualityEvidence(db, sampleId)
  const byId = await loadQualityEvidenceMessages(db, current.conversation_id, evidence)
  const target = byId.get(evidence.target_message_id)
  if (!target) {
    throw new AppMessagingError(409, 'QUALITY_EVIDENCE_UNAVAILABLE', '抽检目标正文不可用，请将样本作废并保留审计')
  }

  const evidenceMessages: NonNullable<AdminConversationQualitySampleDetail['evidence']>['messages'] = []
  pushEvidenceMessage(evidenceMessages, byId, evidence.context_before_message_id, evidence.context_before_body_sha256, 'before')
  pushEvidenceMessage(evidenceMessages, byId, evidence.target_message_id, evidence.target_message_body_sha256, 'target')
  pushEvidenceMessage(evidenceMessages, byId, evidence.context_after_message_id, evidence.context_after_body_sha256, 'after')
  const disclosure = evidence.disclosure_message_id
    ? mapDisclosureEvidence(
        byId.get(evidence.disclosure_message_id) ?? null,
        evidence.disclosure_message_body_sha256,
        evidence.expected_disclosure_body_sha256,
      )
    : null
  const integrityMatches = qualityEvidenceSnapshotMatches(current, evidence, byId)

  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app_conversation_quality.body_access',
              'app_conversation_quality_sample', ?, NULL, ?, ?)
  `).bind(
    qualityId('audit'),
    actor.adminId,
    sampleId,
    JSON.stringify({
      requestId,
      purpose: 'quality_review',
      reviewReasonCode: current.review_reason_code,
      evidenceDigest: evidence.evidence_digest,
      messageCount: evidenceMessages.length,
      disclosureIncluded: Boolean(disclosure),
      integrityMatches,
    }),
    now.toISOString(),
  ).run()

  return {
    ...summary,
    bodyAccess: {
      status: 'authorized',
      purpose: 'quality_review',
      reasonCode: current.review_reason_code,
    },
    evidence: {
      evidenceDigest: evidence.evidence_digest,
      capturedAt: evidence.captured_at,
      integrityMatches,
      messages: evidenceMessages,
      disclosure,
    },
    reviewerSummary: null,
  }
}

export async function decideAdminConversationQualitySample(
  db: D1Database,
  actor: ConversationQualityActor,
  sampleIdValue: string,
  idempotencyKeyValue: string | null,
  input: DecideQualitySampleInput,
  now = new Date(),
): Promise<{
  sample: AdminConversationQualitySampleSummary
  improvementTask: AdminConversationQualityTask | null
  replayed: boolean
}> {
  const sampleId = normalizeSampleId(sampleIdValue)
  const current = await requireSample(db, sampleId)
  const access = await resolveQualityAccess(db, actor)
  assertSampleScope(access, current.group_id)
  const decision = await normalizeQualityDecision(input, current, now)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ sampleId, ...decision })
  const replay = await findQualityIdempotency(db, actor.adminId, 'sample_decision', idempotencyKey)
  if (replay) {
    assertQualityIdempotency(replay, requestHash)
    const replayedSample = await requireSample(db, replay.result_id)
    return {
      sample: mapSampleSummary(replayedSample, actor.adminId, access, now),
      improvementTask: await findTaskForSample(db, replay.result_id, actor.adminId, access),
      replayed: true,
    }
  }

  if (current.status !== 'in_review') {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_NOT_IN_REVIEW', '样本不在审核中，请刷新后重试')
  }
  if (
    current.assigned_reviewer_admin_id !== actor.adminId
    || !isFuture(current.reviewer_lease_expires_at, now)
  ) {
    throw new AppMessagingError(403, 'QUALITY_SAMPLE_CLAIM_REQUIRED', '质检领取已失效，请重新领取后提交结论')
  }
  if (current.actual_operator_admin_id === actor.adminId) {
    throw new AppMessagingError(403, 'QUALITY_REVIEW_SEPARATION_REQUIRED', '不能审核由本人实际回复的样本')
  }
  if (decision.expectedVersion !== Number(current.version)) {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_VERSION_CONFLICT', '样本版本已变化，请刷新正文和结论后重试', true)
  }

  const evidence = await requireQualityEvidence(db, sampleId)
  const evidenceMessages = await loadQualityEvidenceMessages(db, current.conversation_id, evidence)
  if (!qualityEvidenceSnapshotMatches(current, evidence, evidenceMessages)) {
    throw new AppMessagingError(409, 'QUALITY_EVIDENCE_INTEGRITY_FAILED', '固定正文证据与抽样快照不一致，不能记录评分；请作废样本')
  }

  if (decision.improvementTask) {
    await requireValidTaskAssignee(
      db,
      decision.improvementTask.assigneeAdminId,
      current.group_id,
    )
  }

  const nowIso = now.toISOString()
  const nextVersion = Number(current.version) + 1
  const mutationToken = crypto.randomUUID()
  const safetyEscalationId = decision.safetyReferral ? qualityId('cse') : null
  const taskId = decision.improvementTask ? qualityId('cqit') : null
  const reviewerSummaryHash = await sha256Hex(decision.reviewerSummary)
  const safetySummaryHash = decision.safetyReferral
    ? await sha256Hex(decision.safetyReferral.summary)
    : null
  const safetyEvidenceDigest = decision.safetyReferral
    ? await hashCanonical({
        source: 'quality_sample',
        sampleId,
        target: [evidence.target_message_id, evidence.target_message_body_sha256],
        before: [evidence.context_before_message_id, evidence.context_before_body_sha256],
        after: [evidence.context_after_message_id, evidence.context_after_body_sha256],
        capturedAt: nowIso,
      })
    : null
  const taskGuidanceHash = decision.improvementTask
    ? await sha256Hex(decision.improvementTask.guidance)
    : null
  const scopeGate = qualityScopeWriteGate(access, 'sample.group_id')
  const statements: D1PreparedStatement[] = []

  if (decision.safetyReferral && safetyEscalationId && safetySummaryHash && safetyEvidenceDigest) {
    statements.push(
      db.prepare(`
        INSERT INTO app_conversation_safety_escalations (
          id, conversation_id, profile_id, reason_code, priority,
          summary_text, summary_sha256, summary_length, status,
          raised_by_admin_id, assigned_admin_id, version,
          created_at, updated_at
        )
        SELECT ?, sample.conversation_id, sample.profile_id, ?, ?, ?, ?, ?,
               'submitted', ?, NULL, 1, ?, ?
        FROM app_conversation_quality_samples sample
        WHERE sample.id = ? AND sample.version = ? AND sample.status = 'in_review'
          AND sample.assigned_reviewer_admin_id = ?
          AND datetime(sample.reviewer_lease_expires_at) > datetime(?)
          AND sample.actual_operator_admin_id <> ?
          AND ${scopeGate.sql}
      `).bind(
        safetyEscalationId,
        decision.safetyReferral.reasonCode,
        decision.safetyReferral.priority,
        decision.safetyReferral.summary,
        safetySummaryHash,
        decision.safetyReferral.summary.length,
        actor.adminId,
        nowIso,
        nowIso,
        sampleId,
        current.version,
        actor.adminId,
        nowIso,
        actor.adminId,
        ...scopeGate.bindings,
      ),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_evidence (
          escalation_id, target_message_id, target_message_sequence,
          target_message_body_sha256, context_before_message_id,
          context_after_message_id, conversation_last_sequence,
          evidence_digest, captured_at
        )
        SELECT ?, evidence.target_message_id, target.sequence,
               evidence.target_message_body_sha256,
               evidence.context_before_message_id, evidence.context_after_message_id,
               conversation.last_sequence, ?, ?
        FROM app_conversation_quality_sample_evidence evidence
        JOIN app_conversation_quality_samples sample ON sample.id = evidence.sample_id
        JOIN app_conversation_messages target ON target.id = evidence.target_message_id
        JOIN app_conversations conversation ON conversation.id = sample.conversation_id
        WHERE evidence.sample_id = ?
          AND EXISTS (SELECT 1 FROM app_conversation_safety_escalations escalation WHERE escalation.id = ?)
      `).bind(safetyEscalationId, safetyEvidenceDigest, nowIso, sampleId, safetyEscalationId),
      db.prepare(`
        INSERT INTO app_conversation_safety_escalation_events (
          id, escalation_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        )
        SELECT ?, id, 1, 'submitted', NULL, 'submitted', 'quality_referral', ?, ?
        FROM app_conversation_safety_escalations WHERE id = ?
      `).bind(qualityId('csee'), actor.adminId, nowIso, safetyEscalationId),
    )
  }

  statements.push(
    db.prepare(`
      UPDATE app_conversation_quality_samples AS sample
      SET status = 'completed', assigned_reviewer_admin_id = ?,
          reviewer_lease_expires_at = NULL,
          identity_disclosure_rating = ?, service_quality_rating = ?,
          policy_language_rating = ?, overall_score = ?, outcome = ?,
          issue_codes_json = ?, reviewer_summary_text = ?,
          reviewer_summary_sha256 = ?, reviewer_summary_length = ?,
          linked_safety_escalation_id = ?, version = ?, mutation_token = ?,
          updated_at = ?, completed_at = ?
      WHERE sample.id = ? AND sample.version = ? AND sample.status = 'in_review'
        AND sample.assigned_reviewer_admin_id = ?
        AND datetime(sample.reviewer_lease_expires_at) > datetime(?)
        AND sample.actual_operator_admin_id <> ?
        AND ${scopeGate.sql}
        AND EXISTS (
          SELECT 1 FROM app_conversation_quality_sample_evidence evidence
          JOIN app_conversation_messages message ON message.id = evidence.target_message_id
          WHERE evidence.sample_id = sample.id
            AND message.conversation_id = sample.conversation_id
            AND message.actor_admin_id = sample.actual_operator_admin_id
            AND message.body_sha256 = evidence.target_message_body_sha256
        )
        ${decision.improvementTask
          ? `AND EXISTS (
              SELECT 1 FROM users task_assignee
              WHERE task_assignee.id = ?
                AND task_assignee.status = 'active'
                AND task_assignee.role IN ('admin', 'owner')
                AND (
                  sample.group_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM app_conversation_group_members task_member
                    JOIN app_conversation_groups task_group ON task_group.id = task_member.group_id
                    WHERE task_member.group_id = sample.group_id
                      AND task_member.admin_id = task_assignee.id
                      AND task_member.status = 'active'
                      AND task_member.member_role IN ('operator', 'lead')
                      AND task_group.status = 'active'
                  )
                )
            )`
          : ''}
        ${safetyEscalationId
          ? 'AND EXISTS (SELECT 1 FROM app_conversation_safety_escalations escalation WHERE escalation.id = ?)'
          : ''}
    `).bind(
      actor.adminId,
      decision.identityDisclosureRating,
      decision.serviceQualityRating,
      decision.policyLanguageRating,
      decision.overallScore,
      decision.outcome,
      JSON.stringify(decision.issueCodes),
      decision.reviewerSummary,
      reviewerSummaryHash,
      decision.reviewerSummary.length,
      safetyEscalationId,
      nextVersion,
      mutationToken,
      nowIso,
      nowIso,
      sampleId,
      current.version,
      actor.adminId,
      nowIso,
      actor.adminId,
      ...scopeGate.bindings,
      ...(decision.improvementTask ? [decision.improvementTask.assigneeAdminId] : []),
      ...(safetyEscalationId ? [safetyEscalationId] : []),
    ),
    db.prepare(`
      INSERT INTO app_conversation_quality_sample_events (
        id, sample_id, sequence, event_type, status_from, status_to,
        reason_code, actor_admin_id, created_at
      )
      SELECT ?, sample.id,
             COALESCE((SELECT MAX(event.sequence) + 1
               FROM app_conversation_quality_sample_events event WHERE event.sample_id = sample.id), 1),
             'completed', 'in_review', 'completed', ?, ?, ?
      FROM app_conversation_quality_samples sample
      WHERE sample.id = ? AND sample.version = ? AND sample.mutation_token = ?
        AND sample.status = 'completed' AND sample.assigned_reviewer_admin_id = ?
    `).bind(
      qualityId('cqse'),
      decision.outcome,
      actor.adminId,
      nowIso,
      sampleId,
      nextVersion,
      mutationToken,
      actor.adminId,
    ),
  )

  if (decision.improvementTask && taskId && taskGuidanceHash) {
    const task = decision.improvementTask
    statements.push(
      db.prepare(`
        INSERT INTO app_conversation_quality_improvement_tasks (
          id, sample_id, group_id, assignee_admin_id, issue_code,
          title_text, guidance_text, guidance_sha256, guidance_length,
          status, due_at, version, created_by_admin_id, updated_by_admin_id,
          created_at, updated_at
        )
        SELECT ?, sample.id, sample.group_id, ?, ?, ?, ?, ?, ?,
               'open', ?, 1, ?, ?, ?, ?
        FROM app_conversation_quality_samples sample
        WHERE sample.id = ? AND sample.version = ? AND sample.mutation_token = ?
          AND sample.status = 'completed' AND sample.outcome = 'coaching_required'
      `).bind(
        taskId,
        task.assigneeAdminId,
        task.issueCode,
        task.title,
        task.guidance,
        taskGuidanceHash,
        task.guidance.length,
        task.dueAt,
        actor.adminId,
        actor.adminId,
        nowIso,
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_improvement_task_events (
          id, task_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        )
        SELECT ?, id, 1, 'created', NULL, 'open', 'quality_coaching_required', ?, ?
        FROM app_conversation_quality_improvement_tasks WHERE id = ?
      `).bind(qualityId('cqite'), actor.adminId, nowIso, taskId),
      db.prepare(`
        INSERT INTO app_conversation_quality_sample_events (
          id, sample_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        )
        SELECT ?, sample.id,
               COALESCE((SELECT MAX(event.sequence) + 1
                 FROM app_conversation_quality_sample_events event WHERE event.sample_id = sample.id), 1),
               'improvement_task_created', 'completed', 'completed', ?, ?, ?
        FROM app_conversation_quality_samples sample
        WHERE sample.id = ? AND sample.version = ? AND sample.mutation_token = ?
          AND EXISTS (SELECT 1 FROM app_conversation_quality_improvement_tasks task WHERE task.id = ?)
      `).bind(
        qualityId('cqse'),
        task.issueCode,
        actor.adminId,
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
        taskId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation_quality.improvement_task_create',
               'app_conversation_quality_improvement_task', id, NULL, ?, ?
        FROM app_conversation_quality_improvement_tasks WHERE id = ?
      `).bind(
        qualityId('audit'),
        actor.adminId,
        JSON.stringify({
          sampleId,
          assigneeAdminId: task.assigneeAdminId,
          issueCode: task.issueCode,
          dueAt: task.dueAt,
          guidanceSha256: taskGuidanceHash,
          guidanceLength: task.guidance.length,
        }),
        nowIso,
        taskId,
      ),
    )
  }

  if (safetyEscalationId) {
    statements.push(
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation_safety_escalation.create_from_quality',
               'app_conversation_safety_escalation', id, NULL, ?, ?
        FROM app_conversation_safety_escalations WHERE id = ?
      `).bind(
        qualityId('audit'),
        actor.adminId,
        JSON.stringify({
          sampleId,
          reasonCode: decision.safetyReferral!.reasonCode,
          priority: decision.safetyReferral!.priority,
          summarySha256: safetySummaryHash,
          summaryLength: decision.safetyReferral!.summary.length,
          evidenceDigest: safetyEvidenceDigest,
        }),
        nowIso,
        safetyEscalationId,
      ),
    )
  }

  statements.push(
    db.prepare(`
      INSERT INTO app_conversation_quality_idempotency (
        admin_id, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, created_at
      )
      SELECT ?, 'sample_decision', ?, ?, 'sample', id, version, ?
      FROM app_conversation_quality_samples
      WHERE id = ? AND version = ? AND mutation_token = ?
        AND status = 'completed' AND assigned_reviewer_admin_id = ?
    `).bind(
      actor.adminId,
      idempotencyKey,
      requestHash,
      nowIso,
      sampleId,
      nextVersion,
      mutationToken,
      actor.adminId,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app_conversation_quality.sample_decision',
             'app_conversation_quality_sample', id, ?, ?, ?
      FROM app_conversation_quality_samples
      WHERE id = ? AND version = ? AND mutation_token = ? AND status = 'completed'
    `).bind(
      qualityId('audit'),
      actor.adminId,
      JSON.stringify({ status: current.status, version: current.version }),
      JSON.stringify({
        status: 'completed',
        version: nextVersion,
        identityDisclosureRating: decision.identityDisclosureRating,
        serviceQualityRating: decision.serviceQualityRating,
        policyLanguageRating: decision.policyLanguageRating,
        overallScore: decision.overallScore,
        outcome: decision.outcome,
        issueCodes: decision.issueCodes,
        reviewerSummarySha256: reviewerSummaryHash,
        reviewerSummaryLength: decision.reviewerSummary.length,
        improvementTaskId: taskId,
        linkedSafetyEscalationId: safetyEscalationId,
      }),
      nowIso,
      sampleId,
      nextVersion,
      mutationToken,
    ),
  )

  try {
    await db.batch(statements)
  }
  catch {
    const concurrent = await findQualityIdempotency(db, actor.adminId, 'sample_decision', idempotencyKey)
    if (concurrent) {
      assertQualityIdempotency(concurrent, requestHash)
      return {
        sample: mapSampleSummary(await requireSample(db, concurrent.result_id), actor.adminId, access, now),
        improvementTask: await findTaskForSample(db, concurrent.result_id, actor.adminId, access),
        replayed: true,
      }
    }
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_DECISION_CONFLICT', '样本、正文证据或授权状态已变化，请刷新后重试', true)
  }

  const stored = await findQualityIdempotency(db, actor.adminId, 'sample_decision', idempotencyKey)
  if (!stored) throw new AppMessagingError(409, 'QUALITY_SAMPLE_DECISION_CONFLICT', '抽检结论未能完整保存，请刷新后重试', true)
  return {
    sample: mapSampleSummary(await requireSample(db, sampleId), actor.adminId, access, now),
    improvementTask: taskId ? await requireTask(db, taskId, actor.adminId, access) : null,
    replayed: false,
  }
}

export async function voidAdminConversationQualitySample(
  db: D1Database,
  actor: ConversationQualityActor,
  sampleIdValue: string,
  idempotencyKeyValue: string | null,
  input: VoidQualitySampleInput,
  now = new Date(),
): Promise<{ sample: AdminConversationQualitySampleSummary; replayed: boolean }> {
  const sampleId = normalizeSampleId(sampleIdValue)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'QUALITY_SAMPLE_VERSION_INVALID', '样本版本无效')
  const reasonCode = normalizeEnum(
    input.reasonCode,
    ['evidence_unavailable', 'scope_invalid', 'duplicate_sample'] as const,
    'QUALITY_VOID_REASON_INVALID',
    '样本作废原因无效',
  )
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ sampleId, expectedVersion, reasonCode })
  const replay = await findQualityIdempotency(db, actor.adminId, 'sample_void', idempotencyKey)
  const access = await resolveQualityAccess(db, actor)
  if (replay) {
    assertQualityIdempotency(replay, requestHash)
    return {
      sample: mapSampleSummary(await requireSample(db, replay.result_id), actor.adminId, access, now),
      replayed: true,
    }
  }
  const current = await requireSample(db, sampleId)
  assertSampleScope(access, current.group_id)
  if (current.status === 'completed' || current.status === 'voided') {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_FINALIZED', '已结束样本不能作废')
  }
  if (Number(current.version) !== expectedVersion) {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_VERSION_CONFLICT', '样本版本已变化，请刷新后重试', true)
  }
  if (!access.isOwner && reasonCode !== 'evidence_unavailable') {
    throw new AppMessagingError(403, 'QUALITY_SAMPLE_VOID_OWNER_REQUIRED', '只有 Owner 可以因范围或重复问题作废样本')
  }
  if (reasonCode === 'evidence_unavailable') {
    const evidence = await requireQualityEvidence(db, sampleId)
    const messages = await loadQualityEvidenceMessages(db, current.conversation_id, evidence)
    const evidenceIsComplete = qualityEvidenceSnapshotMatches(current, evidence, messages)
    if (evidenceIsComplete) {
      throw new AppMessagingError(409, 'QUALITY_EVIDENCE_STILL_AVAILABLE', '目标证据仍然完整，不能以证据不可用为由作废')
    }
  }
  const leaseActive = isFuture(current.reviewer_lease_expires_at, now)
  if (!access.isOwner && leaseActive && current.assigned_reviewer_admin_id !== actor.adminId) {
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_TAKEN', '样本正由其他质检员审核，不能作废')
  }
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const scopeGate = qualityScopeWriteGate(access, 'app_conversation_quality_samples.group_id')
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_quality_samples
        SET status = 'voided', reviewer_lease_expires_at = NULL,
            void_reason_code = ?, version = ?, mutation_token = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND version = ? AND status IN ('pending', 'in_review')
          AND ${scopeGate.sql}
          AND (? = 1 OR assigned_reviewer_admin_id IS NULL
            OR assigned_reviewer_admin_id = ?
            OR datetime(reviewer_lease_expires_at) <= datetime(?))
      `).bind(
        reasonCode,
        nextVersion,
        mutationToken,
        nowIso,
        nowIso,
        sampleId,
        expectedVersion,
        ...scopeGate.bindings,
        access.isOwner ? 1 : 0,
        actor.adminId,
        nowIso,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_sample_events (
          id, sample_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        )
        SELECT ?, sample.id,
               COALESCE((SELECT MAX(event.sequence) + 1
                 FROM app_conversation_quality_sample_events event WHERE event.sample_id = sample.id), 1),
               'voided', ?, 'voided', ?, ?, ?
        FROM app_conversation_quality_samples sample
        WHERE sample.id = ? AND sample.version = ? AND sample.mutation_token = ?
          AND sample.status = 'voided'
      `).bind(
        qualityId('cqse'),
        current.status,
        reasonCode,
        actor.adminId,
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'sample_void', ?, ?, 'sample', id, version, ?
        FROM app_conversation_quality_samples
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = 'voided'
      `).bind(actor.adminId, idempotencyKey, requestHash, nowIso, sampleId, nextVersion, mutationToken),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation_quality.sample_void',
               'app_conversation_quality_sample', id, ?, ?, ?
        FROM app_conversation_quality_samples
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = 'voided'
      `).bind(
        qualityId('audit'),
        actor.adminId,
        JSON.stringify({ status: current.status, version: current.version }),
        JSON.stringify({ status: 'voided', version: nextVersion, reasonCode }),
        nowIso,
        sampleId,
        nextVersion,
        mutationToken,
      ),
    ])
  }
  catch {
    const concurrent = await findQualityIdempotency(db, actor.adminId, 'sample_void', idempotencyKey)
    if (concurrent) {
      assertQualityIdempotency(concurrent, requestHash)
      return {
        sample: mapSampleSummary(await requireSample(db, concurrent.result_id), actor.adminId, access, now),
        replayed: true,
      }
    }
    throw new AppMessagingError(409, 'QUALITY_SAMPLE_VOID_CONFLICT', '样本状态已变化，请刷新后重试', true)
  }
  const stored = await findQualityIdempotency(db, actor.adminId, 'sample_void', idempotencyKey)
  if (!stored) throw new AppMessagingError(409, 'QUALITY_SAMPLE_VOID_CONFLICT', '样本状态已变化，请刷新后重试', true)
  return {
    sample: mapSampleSummary(await requireSample(db, sampleId), actor.adminId, access, now),
    replayed: false,
  }
}

export async function updateAdminConversationQualityTask(
  db: D1Database,
  actor: ConversationQualityActor,
  taskIdValue: string,
  idempotencyKeyValue: string | null,
  input: UpdateQualityTaskInput,
  now = new Date(),
): Promise<{ task: AdminConversationQualityTask; replayed: boolean }> {
  const taskId = normalizeTaskId(taskIdValue)
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'QUALITY_TASK_VERSION_INVALID', '任务版本无效')
  const status = normalizeEnum(
    input.status,
    ['in_progress', 'completed', 'cancelled'] as const,
    'QUALITY_TASK_STATUS_INVALID',
    '任务状态无效',
  )
  const reasonCode = normalizeReasonCode(input.reasonCode, '任务变更原因')
  const completionNote = status === 'completed'
    ? normalizeText(input.completionNote, 1000, '完成说明')
    : null
  const normalized = { taskId, expectedVersion, status, reasonCode, completionNote }
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical(normalized)
  const replay = await findQualityIdempotency(db, actor.adminId, 'task_update', idempotencyKey)
  const access = await resolveQualityAccess(db, actor)
  if (replay) {
    assertQualityIdempotency(replay, requestHash)
    return { task: await requireTask(db, replay.result_id, actor.adminId, access), replayed: true }
  }

  const current = await requireTaskRow(db, taskId)
  const isSupervisor = access.isOwner || Boolean(current.group_id && access.groupIds.includes(current.group_id))
  const isAssignee = current.assignee_admin_id === actor.adminId
  if (!isSupervisor && !isAssignee) {
    throw new AppMessagingError(403, 'QUALITY_TASK_SCOPE_REQUIRED', '无权修改该改进任务')
  }
  if (status === 'cancelled' && !isSupervisor) {
    throw new AppMessagingError(403, 'QUALITY_TASK_CANCEL_SCOPE_REQUIRED', '只有 Owner、运营组长或质检成员可以取消任务')
  }
  if (current.status === 'completed' || current.status === 'cancelled') {
    throw new AppMessagingError(409, 'QUALITY_TASK_FINALIZED', '已结束任务不能再次修改')
  }
  if (Number(current.version) !== expectedVersion) {
    throw new AppMessagingError(409, 'QUALITY_TASK_VERSION_CONFLICT', '任务版本已变化，请刷新后重试', true)
  }
  if (status === 'in_progress' && current.status !== 'open') {
    throw new AppMessagingError(409, 'QUALITY_TASK_TRANSITION_INVALID', '只有待开始任务可以进入处理中')
  }

  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const completionNoteHash = completionNote ? await sha256Hex(completionNote) : null
  const eventType = status === 'in_progress' ? 'started' : status === 'completed' ? 'completed' : 'cancelled'
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_quality_improvement_tasks
        SET status = ?, version = ?, mutation_token = ?,
            completion_note_text = ?, completion_note_sha256 = ?,
            completion_note_length = ?, updated_by_admin_id = ?, updated_at = ?,
            completed_at = CASE WHEN ? IN ('completed', 'cancelled') THEN ? ELSE NULL END
        WHERE id = ? AND version = ? AND status IN ('open', 'in_progress')
          AND (
            assignee_admin_id = ?
            OR ? = 1
            OR group_id IN (
              SELECT member.group_id FROM app_conversation_group_members member
              JOIN app_conversation_groups operation_group ON operation_group.id = member.group_id
              WHERE member.admin_id = ? AND member.status = 'active'
                AND member.member_role IN ('lead', 'quality')
                AND operation_group.status = 'active'
            )
          )
          AND (? <> 'cancelled' OR ? = 1 OR group_id IN (
            SELECT member.group_id FROM app_conversation_group_members member
            JOIN app_conversation_groups operation_group ON operation_group.id = member.group_id
            WHERE member.admin_id = ? AND member.status = 'active'
              AND member.member_role IN ('lead', 'quality')
              AND operation_group.status = 'active'
          ))
      `).bind(
        status,
        nextVersion,
        mutationToken,
        completionNote,
        completionNoteHash,
        completionNote?.length ?? null,
        actor.adminId,
        nowIso,
        status,
        nowIso,
        taskId,
        expectedVersion,
        actor.adminId,
        access.isOwner ? 1 : 0,
        actor.adminId,
        status,
        access.isOwner ? 1 : 0,
        actor.adminId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_improvement_task_events (
          id, task_id, sequence, event_type, status_from, status_to,
          reason_code, actor_admin_id, created_at
        )
        SELECT ?, task.id,
               COALESCE((SELECT MAX(event.sequence) + 1
                 FROM app_conversation_quality_improvement_task_events event WHERE event.task_id = task.id), 1),
               ?, ?, ?, ?, ?, ?
        FROM app_conversation_quality_improvement_tasks task
        WHERE task.id = ? AND task.version = ? AND task.mutation_token = ? AND task.status = ?
      `).bind(
        qualityId('cqite'),
        eventType,
        current.status,
        status,
        reasonCode,
        actor.adminId,
        nowIso,
        taskId,
        nextVersion,
        mutationToken,
        status,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quality_idempotency (
          admin_id, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'task_update', ?, ?, 'task', id, version, ?
        FROM app_conversation_quality_improvement_tasks
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = ?
      `).bind(
        actor.adminId,
        idempotencyKey,
        requestHash,
        nowIso,
        taskId,
        nextVersion,
        mutationToken,
        status,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation_quality.improvement_task_update',
               'app_conversation_quality_improvement_task', id, ?, ?, ?
        FROM app_conversation_quality_improvement_tasks
        WHERE id = ? AND version = ? AND mutation_token = ? AND status = ?
      `).bind(
        qualityId('audit'),
        actor.adminId,
        JSON.stringify({ status: current.status, version: current.version }),
        JSON.stringify({
          status,
          version: nextVersion,
          reasonCode,
          completionNoteSha256: completionNoteHash,
          completionNoteLength: completionNote?.length ?? null,
        }),
        nowIso,
        taskId,
        nextVersion,
        mutationToken,
        status,
      ),
    ])
  }
  catch {
    const concurrent = await findQualityIdempotency(db, actor.adminId, 'task_update', idempotencyKey)
    if (concurrent) {
      assertQualityIdempotency(concurrent, requestHash)
      return { task: await requireTask(db, concurrent.result_id, actor.adminId, access), replayed: true }
    }
    throw new AppMessagingError(409, 'QUALITY_TASK_UPDATE_CONFLICT', '任务状态或权限已变化，请刷新后重试', true)
  }
  const stored = await findQualityIdempotency(db, actor.adminId, 'task_update', idempotencyKey)
  if (!stored) throw new AppMessagingError(409, 'QUALITY_TASK_UPDATE_CONFLICT', '任务状态或权限已变化，请刷新后重试', true)
  return { task: await requireTask(db, taskId, actor.adminId, access), replayed: false }
}

async function resolveQualityAccess(
  db: D1Database,
  actor: ConversationQualityActor,
): Promise<QualityAccess> {
  const isOwner = actor.role === 'owner'
  const result = isOwner
    ? await db.prepare(`
        SELECT operation_group.id AS group_id, operation_group.name AS group_name,
               NULL AS member_role,
               (
                 SELECT COUNT(*) FROM app_conversation_group_members operator_member
                 JOIN users operator ON operator.id = operator_member.admin_id
                 WHERE operator_member.group_id = operation_group.id
                   AND operator_member.status = 'active'
                   AND operator_member.member_role IN ('operator', 'lead')
                   AND operator.status = 'active' AND operator.role IN ('admin', 'owner')
               ) AS active_operator_count
        FROM app_conversation_groups operation_group
        WHERE operation_group.status = 'active'
        ORDER BY operation_group.name ASC, operation_group.id ASC
      `).all<QualityScopeRow>()
    : await db.prepare(`
        SELECT operation_group.id AS group_id, operation_group.name AS group_name,
               member.member_role,
               (
                 SELECT COUNT(*) FROM app_conversation_group_members operator_member
                 JOIN users operator ON operator.id = operator_member.admin_id
                 WHERE operator_member.group_id = operation_group.id
                   AND operator_member.status = 'active'
                   AND operator_member.member_role IN ('operator', 'lead')
                   AND operator.status = 'active' AND operator.role IN ('admin', 'owner')
               ) AS active_operator_count
        FROM app_conversation_group_members member
        JOIN app_conversation_groups operation_group ON operation_group.id = member.group_id
        WHERE member.admin_id = ? AND member.status = 'active'
          AND member.member_role IN ('lead', 'quality')
          AND operation_group.status = 'active'
        ORDER BY operation_group.name ASC, operation_group.id ASC
      `).bind(actor.adminId).all<QualityScopeRow>()
  return {
    adminId: actor.adminId,
    isOwner,
    groupIds: result.results.map(row => row.group_id),
    groups: result.results.map(row => ({
      groupId: row.group_id,
      name: row.group_name,
      memberRole: isOwner ? 'owner' : row.member_role === 'lead' ? 'lead' : 'quality',
      activeOperatorCount: Math.max(0, Number(row.active_operator_count)),
    })),
  }
}

async function listQualityOperators(
  db: D1Database,
  access: QualityAccess,
): Promise<AdminConversationQualitySnapshot['operators']> {
  if (!access.isOwner && access.groupIds.length === 0) return []
  const placeholders = access.groupIds.map(() => '?').join(', ')
  const condition = access.isOwner ? '1 = 1' : `member.group_id IN (${placeholders})`
  const result = await db.prepare(`
    SELECT member.admin_id,
           COALESCE(admin.nickname, admin.username, '管理员 #' || admin.id) AS display_name,
           member.group_id
    FROM app_conversation_group_members member
    JOIN app_conversation_groups operation_group ON operation_group.id = member.group_id
    JOIN users admin ON admin.id = member.admin_id
    WHERE ${condition}
      AND member.status = 'active' AND operation_group.status = 'active'
      AND member.member_role IN ('operator', 'lead')
      AND admin.status = 'active' AND admin.role IN ('admin', 'owner')
    ORDER BY display_name ASC, member.admin_id ASC, member.group_id ASC
  `).bind(...(access.isOwner ? [] : access.groupIds)).all<QualityOperatorRow>()
  const operators = new Map<number, AdminConversationQualitySnapshot['operators'][number]>()
  for (const row of result.results) {
    const current = operators.get(row.admin_id)
    if (current) {
      if (!current.groupIds.includes(row.group_id)) current.groupIds.push(row.group_id)
    }
    else {
      operators.set(row.admin_id, {
        adminId: row.admin_id,
        displayName: row.display_name,
        groupIds: [row.group_id],
      })
    }
  }
  return [...operators.values()]
}

function buildSampleScope(
  access: QualityAccess,
  groupId: string | 'unscoped' | null,
): { sql: string; bindings: unknown[] } {
  if (groupId === 'unscoped') return { sql: 'sample.group_id IS NULL', bindings: [] }
  if (groupId) return { sql: 'sample.group_id = ?', bindings: [groupId] }
  if (access.isOwner) return { sql: '1 = 1', bindings: [] }
  if (access.groupIds.length === 0) return { sql: '1 = 0', bindings: [] }
  return {
    sql: `sample.group_id IN (${access.groupIds.map(() => '?').join(', ')})`,
    bindings: [...access.groupIds],
  }
}

function buildTaskScope(
  access: QualityAccess,
  adminId: number,
  groupId: string | 'unscoped' | null,
): { sql: string; bindings: unknown[] } {
  if (groupId === 'unscoped') return { sql: 'task.group_id IS NULL', bindings: [] }
  if (groupId) return { sql: 'task.group_id = ?', bindings: [groupId] }
  if (access.isOwner) return { sql: '1 = 1', bindings: [] }
  if (access.groupIds.length === 0) {
    return { sql: 'task.assignee_admin_id = ?', bindings: [adminId] }
  }
  return {
    sql: `(task.assignee_admin_id = ? OR task.group_id IN (${access.groupIds.map(() => '?').join(', ')}))`,
    bindings: [adminId, ...access.groupIds],
  }
}

function qualityScopeWriteGate(
  access: QualityAccess,
  column: string,
): { sql: string; bindings: unknown[] } {
  if (access.isOwner) return { sql: '1 = 1', bindings: [] }
  if (access.groupIds.length === 0) return { sql: '1 = 0', bindings: [] }
  return {
    sql: `EXISTS (
      SELECT 1 FROM app_conversation_group_members live_member
      JOIN app_conversation_groups live_group ON live_group.id = live_member.group_id
      WHERE live_member.group_id = ${column}
        AND live_member.admin_id = ?
        AND live_member.status = 'active'
        AND live_member.member_role IN ('lead', 'quality')
        AND live_group.status = 'active'
    )`,
    bindings: [access.adminId],
  }
}

function qualityStatusCondition(status: AdminConversationQualityListQuery['status']) {
  if (status === 'all') return '1 = 1'
  if (status === 'open') return "sample.status IN ('pending', 'in_review')"
  return `sample.status = '${status}'`
}

function assertRequestedScope(access: QualityAccess, groupId: string | 'unscoped' | null) {
  if (groupId === 'unscoped' && !access.isOwner) {
    throw new AppMessagingError(403, 'QUALITY_UNSCOPED_OWNER_REQUIRED', '只有 Owner 可以查看未归组样本')
  }
  if (groupId && groupId !== 'unscoped' && !access.isOwner && !access.groupIds.includes(groupId)) {
    throw new AppMessagingError(403, 'QUALITY_GROUP_SCOPE_REQUIRED', '无权查看该运营组的抽检样本')
  }
}

function requireSelectionScope(access: QualityAccess, groupId: string | null) {
  if (!groupId && !access.isOwner) {
    throw new AppMessagingError(403, 'QUALITY_UNSCOPED_OWNER_REQUIRED', '只有 Owner 可以选择未归组回复')
  }
  if (groupId && !access.isOwner && !access.groupIds.includes(groupId)) {
    throw new AppMessagingError(403, 'QUALITY_GROUP_SCOPE_REQUIRED', '无权为该运营组创建抽检样本')
  }
}

function assertSampleScope(access: QualityAccess, groupId: string | null) {
  if (access.isOwner) return
  if (!groupId || !access.groupIds.includes(groupId)) {
    throw new AppMessagingError(403, 'QUALITY_GROUP_SCOPE_REQUIRED', '无权访问该抽检样本')
  }
}

function mapSampleSummary(
  row: QualitySampleRow,
  adminId: number,
  access: QualityAccess,
  now: Date,
): AdminConversationQualitySampleSummary {
  const status = normalizeSampleStatus(row.status)
  const leaseActive = status === 'in_review' && isFuture(row.reviewer_lease_expires_at, now)
  const reviewStatus = leaseActive
    ? row.assigned_reviewer_admin_id === adminId ? 'mine' : 'other'
    : 'unassigned'
  const hasScope = access.isOwner || Boolean(row.group_id && access.groupIds.includes(row.group_id))
  const issueCodes = parseStringArray(row.issue_codes_json)
  return {
    sampleId: row.id,
    selectionRunId: row.selection_run_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    messageCreatedAt: row.message_created_at,
    profile: { profileId: row.profile_id, displayName: row.profile_display_name },
    group: { groupId: row.group_id, name: row.group_name },
    actualOperator: {
      adminId: row.actual_operator_admin_id,
      displayName: row.actual_operator_display_name,
    },
    disclosureVersion: row.disclosure_version,
    approvedScriptVersionId: row.approved_script_version_id,
    disclosureIntegrityStatus: normalizeDisclosureIntegrityStatus(row.disclosure_integrity_status),
    status,
    review: {
      status: reviewStatus,
      reviewerAdminId: leaseActive ? row.assigned_reviewer_admin_id : null,
      reviewerDisplayName: leaseActive ? row.reviewer_display_name : null,
      leaseExpiresAt: leaseActive ? row.reviewer_lease_expires_at : null,
      reasonCode: leaseActive ? row.review_reason_code : null,
      canClaim: hasScope
        && (status === 'pending' || status === 'in_review')
        && row.actual_operator_admin_id !== adminId
        && reviewStatus !== 'other',
    },
    version: Number(row.version),
    conclusion: status === 'completed' && row.outcome && row.completed_at
      ? {
          identityDisclosureRating: row.identity_disclosure_rating === 'fail' ? 'fail' : 'pass',
          serviceQualityRating: normalizeQualityRating(row.service_quality_rating),
          policyLanguageRating: normalizeQualityRating(row.policy_language_rating),
          overallScore: Number(row.overall_score ?? 0),
          outcome: normalizeQualityOutcome(row.outcome),
          issueCodes,
          linkedSafetyEscalationId: row.linked_safety_escalation_id,
          completedAt: row.completed_at,
        }
      : null,
    voidReasonCode: row.void_reason_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTask(
  row: QualityTaskRow,
  adminId: number,
  access: QualityAccess,
): AdminConversationQualityTask {
  const isSupervisor = access.isOwner || Boolean(row.group_id && access.groupIds.includes(row.group_id))
  const isAssignee = row.assignee_admin_id === adminId
  const open = row.status === 'open' || row.status === 'in_progress'
  return {
    taskId: row.id,
    sampleId: row.sample_id,
    group: { groupId: row.group_id, name: row.group_name },
    assignee: { adminId: row.assignee_admin_id, displayName: row.assignee_display_name },
    issueCode: row.issue_code,
    title: row.title_text,
    guidance: row.guidance_text,
    status: normalizeTaskStatus(row.status),
    dueAt: row.due_at,
    version: Number(row.version),
    completionNote: row.completion_note_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    canUpdate: open && (isSupervisor || isAssignee),
    canCancel: open && isSupervisor,
  }
}

function mapSelectionRun(row: SelectionRunRow): AdminConversationQualitySnapshot['selectionRuns'][number] {
  return {
    selectionRunId: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    scopeType: row.scope_type === 'unscoped' ? 'unscoped' : 'group',
    windowStart: row.window_start,
    windowEnd: row.window_end,
    requestedSampleSize: Number(row.requested_sample_size),
    eligibleCount: Number(row.eligible_count),
    selectedCount: Number(row.selected_count),
    reasonCode: row.reason_code,
    selectedByDisplayName: row.selected_by_display_name,
    createdAt: row.created_at,
  }
}

function normalizeSelectionInput(input: CreateQualitySelectionRunInput, now: Date) {
  const rawGroup = typeof input.groupId === 'string' ? input.groupId.trim() : ''
  const groupId = !rawGroup || rawGroup === 'unscoped' ? null : normalizeGroupId(rawGroup)
  const windowStart = normalizeIsoDate(input.windowStart, '抽样开始时间')
  const windowEnd = normalizeIsoDate(input.windowEnd, '抽样结束时间')
  const startTime = new Date(windowStart).getTime()
  const endTime = new Date(windowEnd).getTime()
  if (startTime >= endTime) {
    throw new AppMessagingError(400, 'QUALITY_WINDOW_INVALID', '抽样开始时间必须早于结束时间')
  }
  if (endTime - startTime > 31 * 24 * 60 * 60_000) {
    throw new AppMessagingError(400, 'QUALITY_WINDOW_TOO_LARGE', '单次抽样时间范围不能超过 31 天')
  }
  if (endTime > now.getTime() + 60_000) {
    throw new AppMessagingError(400, 'QUALITY_WINDOW_IN_FUTURE', '抽样结束时间不能晚于当前时间')
  }
  const sampleSize = normalizePositiveInteger(input.sampleSize, 'QUALITY_SAMPLE_SIZE_INVALID', '抽样数量无效')
  if (sampleSize > 50) throw new AppMessagingError(400, 'QUALITY_SAMPLE_SIZE_INVALID', '单次最多选择 50 个样本')
  const reasonCode = normalizeEnum(
    input.reasonCode,
    SELECTION_REASONS,
    'QUALITY_SELECTION_REASON_INVALID',
    '抽样原因无效',
  )
  return { groupId, windowStart, windowEnd, sampleSize, reasonCode }
}

function selectCandidatesRoundRobin(rows: SelectionCandidateRow[], size: number) {
  const queues = new Map<number, SelectionCandidateRow[]>()
  for (const row of rows) {
    const queue = queues.get(row.actual_operator_admin_id) ?? []
    queue.push(row)
    queues.set(row.actual_operator_admin_id, queue)
  }
  const operatorIds = [...queues.keys()].sort((left, right) => {
    const leftFirst = queues.get(left)?.[0]?.message_created_at ?? ''
    const rightFirst = queues.get(right)?.[0]?.message_created_at ?? ''
    return leftFirst.localeCompare(rightFirst) || left - right
  })
  const selected: SelectionCandidateRow[] = []
  while (selected.length < size) {
    let progressed = false
    for (const operatorId of operatorIds) {
      const next = queues.get(operatorId)?.shift()
      if (!next) continue
      selected.push(next)
      progressed = true
      if (selected.length >= size) break
    }
    if (!progressed) break
  }
  return selected
}

function resolveDisclosureIntegrity(
  candidate: SelectionCandidateRow,
  expectedHash: string | null,
): DisclosureIntegrityStatus {
  if (!candidate.disclosure_message_id || !candidate.disclosure_body_sha256) return 'missing'
  if (!expectedHash) return 'unverifiable'
  return candidate.disclosure_body_sha256 === expectedHash ? 'verified' : 'mismatch'
}

type NormalizedQualityDecision = {
  expectedVersion: number
  identityDisclosureRating: 'pass' | 'fail'
  serviceQualityRating: QualityRating
  policyLanguageRating: QualityRating
  overallScore: number
  outcome: QualityOutcome
  issueCodes: string[]
  reviewerSummary: string
  improvementTask: null | {
    assigneeAdminId: number
    issueCode: string
    title: string
    guidance: string
    dueAt: string
  }
  safetyReferral: null | {
    reasonCode: typeof SAFETY_REASON_CODES[number]
    priority: 'p0' | 'p1' | 'p2' | 'p3'
    summary: string
  }
}

async function normalizeQualityDecision(
  input: DecideQualitySampleInput,
  sample: QualitySampleRow,
  now: Date,
): Promise<NormalizedQualityDecision> {
  const expectedVersion = normalizePositiveInteger(input.expectedVersion, 'QUALITY_SAMPLE_VERSION_INVALID', '样本版本无效')
  const identityDisclosureRating = normalizeEnum(
    input.identityDisclosureRating,
    ['pass', 'fail'] as const,
    'QUALITY_IDENTITY_RATING_INVALID',
    '身份披露评分无效',
  )
  const serviceQualityRating = normalizeEnum(
    input.serviceQualityRating,
    ['pass', 'needs_improvement', 'fail'] as const,
    'QUALITY_SERVICE_RATING_INVALID',
    '服务质量评分无效',
  )
  const policyLanguageRating = normalizeEnum(
    input.policyLanguageRating,
    ['pass', 'needs_improvement', 'fail'] as const,
    'QUALITY_LANGUAGE_RATING_INVALID',
    '话术合规评分无效',
  )
  const overallScore = normalizeNonNegativeInteger(input.overallScore, 'QUALITY_SCORE_INVALID', '综合评分必须为 0—100 的整数')
  if (overallScore > 100) throw new AppMessagingError(400, 'QUALITY_SCORE_INVALID', '综合评分必须为 0—100 的整数')
  const outcome = normalizeEnum(
    input.outcome,
    ['pass', 'coaching_required', 'safety_referral'] as const,
    'QUALITY_OUTCOME_INVALID',
    '抽检结论无效',
  )
  const issueCodes = normalizeIssueCodes(input.issueCodes)
  const reviewerSummary = normalizeText(input.reviewerSummary, 1000, '质检结论说明')
  const improvementTask = normalizeImprovementTask(input.improvementTask, sample.actual_operator_admin_id, now)
  const safetyReferral = normalizeSafetyReferral(input.safetyReferral)

  if (sample.disclosure_integrity_status === 'missing' || sample.disclosure_integrity_status === 'mismatch') {
    if (identityDisclosureRating !== 'fail' || !issueCodes.includes('disclosure_missing') || outcome === 'pass') {
      throw new AppMessagingError(
        400,
        'QUALITY_DISCLOSURE_FAILURE_REQUIRED',
        '披露缺失或完整性不一致时，身份披露必须判为失败、选择披露缺失问题且不能通过',
      )
    }
  }
  if (outcome === 'pass') {
    if (
      identityDisclosureRating !== 'pass'
      || serviceQualityRating !== 'pass'
      || policyLanguageRating !== 'pass'
      || overallScore < 80
      || issueCodes.length > 0
      || improvementTask
      || safetyReferral
    ) {
      throw new AppMessagingError(400, 'QUALITY_PASS_INCONSISTENT', '通过结论要求三项均通过、得分不低于 80 且没有问题、任务或安全转介')
    }
  }
  if (outcome === 'coaching_required') {
    if (issueCodes.length === 0 || !improvementTask || safetyReferral) {
      throw new AppMessagingError(400, 'QUALITY_COACHING_INCONSISTENT', '需要改进的结论必须选择问题并创建改进任务，不能同时创建安全转介')
    }
    if (!issueCodes.includes(improvementTask.issueCode)) {
      throw new AppMessagingError(400, 'QUALITY_TASK_ISSUE_MISMATCH', '改进任务问题码必须包含在抽检问题中')
    }
  }
  if (outcome === 'safety_referral') {
    if (issueCodes.length === 0 || !safetyReferral || improvementTask) {
      throw new AppMessagingError(400, 'QUALITY_SAFETY_REFERRAL_INCONSISTENT', '安全转介必须选择问题并填写独立安全案件，不能同时创建改进任务')
    }
  }

  return {
    expectedVersion,
    identityDisclosureRating,
    serviceQualityRating,
    policyLanguageRating,
    overallScore,
    outcome,
    issueCodes,
    reviewerSummary,
    improvementTask,
    safetyReferral,
  }
}

function normalizeImprovementTask(
  value: unknown,
  defaultAssigneeAdminId: number,
  now: Date,
): NormalizedQualityDecision['improvementTask'] {
  if (value == null) return null
  if (!isRecord(value)) {
    throw new AppMessagingError(400, 'QUALITY_TASK_INVALID', '改进任务格式无效')
  }
  const rawAssignee = value.assigneeAdminId == null ? defaultAssigneeAdminId : value.assigneeAdminId
  const assigneeAdminId = normalizePositiveInteger(rawAssignee, 'QUALITY_TASK_ASSIGNEE_INVALID', '任务负责人无效')
  const issueCode = normalizeEnum(
    value.issueCode,
    ISSUE_CODES,
    'QUALITY_TASK_ISSUE_INVALID',
    '改进任务问题码无效',
  )
  const title = normalizeText(value.title, 120, '改进任务标题')
  const guidance = normalizeText(value.guidance, 1000, '改进指导')
  const dueAt = normalizeIsoDate(value.dueAt, '任务截止时间')
  const dueTime = new Date(dueAt).getTime()
  if (dueTime <= now.getTime()) throw new AppMessagingError(400, 'QUALITY_TASK_DUE_INVALID', '任务截止时间必须晚于当前时间')
  if (dueTime > now.getTime() + 180 * 24 * 60 * 60_000) {
    throw new AppMessagingError(400, 'QUALITY_TASK_DUE_TOO_LATE', '任务截止时间不能超过 180 天')
  }
  return { assigneeAdminId, issueCode, title, guidance, dueAt }
}

function normalizeSafetyReferral(value: unknown): NormalizedQualityDecision['safetyReferral'] {
  if (value == null) return null
  if (!isRecord(value)) {
    throw new AppMessagingError(400, 'QUALITY_SAFETY_REFERRAL_INVALID', '安全转介格式无效')
  }
  return {
    reasonCode: normalizeEnum(
      value.reasonCode,
      SAFETY_REASON_CODES,
      'QUALITY_SAFETY_REASON_INVALID',
      '安全转介原因无效',
    ),
    priority: normalizeEnum(
      value.priority,
      ['p0', 'p1', 'p2', 'p3'] as const,
      'QUALITY_SAFETY_PRIORITY_INVALID',
      '安全转介优先级无效',
    ),
    summary: normalizeText(value.summary, 1000, '安全转介说明'),
  }
}

function normalizeIssueCodes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AppMessagingError(400, 'QUALITY_ISSUE_CODES_INVALID', '问题码必须为数组')
  const result = [...new Set(value.map(item => {
    if (typeof item !== 'string' || !ISSUE_CODES.includes(item as typeof ISSUE_CODES[number])) {
      throw new AppMessagingError(400, 'QUALITY_ISSUE_CODES_INVALID', '包含不支持的抽检问题码')
    }
    return item
  }))]
  if (result.length > 8) throw new AppMessagingError(400, 'QUALITY_ISSUE_CODES_INVALID', '单个样本最多选择 8 个问题')
  return result
}

async function requireValidTaskAssignee(
  db: D1Database,
  adminId: number,
  groupId: string | null,
) {
  const row = await db.prepare(`
    SELECT admin.id
    FROM users admin
    WHERE admin.id = ? AND admin.status = 'active' AND admin.role IN ('admin', 'owner')
      AND (
        ? IS NULL
        OR EXISTS (
          SELECT 1 FROM app_conversation_group_members member
          JOIN app_conversation_groups operation_group ON operation_group.id = member.group_id
          WHERE member.group_id = ? AND member.admin_id = admin.id
            AND member.status = 'active' AND operation_group.status = 'active'
            AND member.member_role IN ('operator', 'lead')
        )
      )
  `).bind(adminId, groupId, groupId).first<{ id: number }>()
  if (!row) throw new AppMessagingError(400, 'QUALITY_TASK_ASSIGNEE_INVALID', '任务负责人必须是目标运营组内的有效管理员')
}

async function requireSample(db: D1Database, sampleId: string): Promise<QualitySampleRow> {
  const row = await db.prepare(`${SAMPLE_SELECT} WHERE sample.id = ? LIMIT 1`)
    .bind(sampleId)
    .first<QualitySampleRow>()
  if (!row) throw new AppMessagingError(404, 'QUALITY_SAMPLE_NOT_FOUND', '抽检样本不存在')
  return row
}

async function requireQualityEvidence(db: D1Database, sampleId: string): Promise<QualityEvidenceRow> {
  const row = await db.prepare(`
    SELECT context_before_message_id, context_before_body_sha256,
           target_message_id, target_message_body_sha256,
           context_after_message_id, context_after_body_sha256,
           disclosure_message_id, disclosure_message_body_sha256,
           expected_disclosure_body_sha256, evidence_digest, captured_at
    FROM app_conversation_quality_sample_evidence WHERE sample_id = ?
  `).bind(sampleId).first<QualityEvidenceRow>()
  if (!row) throw new AppMessagingError(409, 'QUALITY_EVIDENCE_UNAVAILABLE', '抽检证据引用不存在，请作废样本')
  return row
}

async function requireSelectionRun(db: D1Database, runId: string): Promise<SelectionRunRow> {
  const row = await db.prepare(`
    SELECT run.id, run.group_id, operation_group.name AS group_name, run.scope_type,
           run.window_start, run.window_end, run.requested_sample_size,
           run.eligible_count, run.selected_count, run.reason_code,
           COALESCE(actor.nickname, actor.username, '管理员 #' || actor.id) AS selected_by_display_name,
           run.created_at
    FROM app_conversation_quality_selection_runs run
    JOIN users actor ON actor.id = run.selected_by_admin_id
    LEFT JOIN app_conversation_groups operation_group ON operation_group.id = run.group_id
    WHERE run.id = ?
  `).bind(runId).first<SelectionRunRow>()
  if (!row) throw new AppMessagingError(404, 'QUALITY_SELECTION_RUN_NOT_FOUND', '抽样批次不存在')
  return row
}

async function listSelectionSampleIds(db: D1Database, runId: string) {
  const result = await db.prepare(`
    SELECT id FROM app_conversation_quality_samples
    WHERE selection_run_id = ? ORDER BY created_at ASC, id ASC
  `).bind(runId).all<{ id: string }>()
  return result.results.map(row => row.id)
}

async function requireTaskRow(db: D1Database, taskId: string): Promise<QualityTaskRow> {
  const row = await db.prepare(`
    SELECT task.id, task.sample_id, task.group_id, operation_group.name AS group_name,
           task.assignee_admin_id,
           COALESCE(assignee.nickname, assignee.username, '管理员 #' || assignee.id) AS assignee_display_name,
           task.issue_code, task.title_text, task.guidance_text, task.status, task.due_at,
           task.version, task.completion_note_text, task.created_at, task.updated_at, task.completed_at
    FROM app_conversation_quality_improvement_tasks task
    JOIN users assignee ON assignee.id = task.assignee_admin_id
    LEFT JOIN app_conversation_groups operation_group ON operation_group.id = task.group_id
    WHERE task.id = ?
  `).bind(taskId).first<QualityTaskRow>()
  if (!row) throw new AppMessagingError(404, 'QUALITY_TASK_NOT_FOUND', '改进任务不存在')
  return row
}

async function requireTask(
  db: D1Database,
  taskId: string,
  adminId: number,
  access: QualityAccess,
) {
  const row = await requireTaskRow(db, taskId)
  if (
    row.assignee_admin_id !== adminId
    && !access.isOwner
    && (!row.group_id || !access.groupIds.includes(row.group_id))
  ) {
    throw new AppMessagingError(403, 'QUALITY_TASK_SCOPE_REQUIRED', '无权查看该改进任务')
  }
  return mapTask(row, adminId, access)
}

async function findTaskForSample(
  db: D1Database,
  sampleId: string,
  adminId: number,
  access: QualityAccess,
): Promise<AdminConversationQualityTask | null> {
  const row = await db.prepare(`
    SELECT task.id, task.sample_id, task.group_id, operation_group.name AS group_name,
           task.assignee_admin_id,
           COALESCE(assignee.nickname, assignee.username, '管理员 #' || assignee.id) AS assignee_display_name,
           task.issue_code, task.title_text, task.guidance_text, task.status, task.due_at,
           task.version, task.completion_note_text, task.created_at, task.updated_at, task.completed_at
    FROM app_conversation_quality_improvement_tasks task
    JOIN users assignee ON assignee.id = task.assignee_admin_id
    LEFT JOIN app_conversation_groups operation_group ON operation_group.id = task.group_id
    WHERE task.sample_id = ?
    ORDER BY task.created_at DESC, task.id DESC LIMIT 1
  `).bind(sampleId).first<QualityTaskRow>()
  if (!row) return null
  if (row.assignee_admin_id !== adminId && !access.isOwner && (!row.group_id || !access.groupIds.includes(row.group_id))) return null
  return mapTask(row, adminId, access)
}

async function findQualityIdempotency(
  db: D1Database,
  adminId: number,
  operation: 'selection_run_create' | 'sample_claim' | 'sample_decision' | 'sample_void' | 'task_update',
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_type, result_id, result_version
    FROM app_conversation_quality_idempotency
    WHERE admin_id = ? AND operation = ? AND idempotency_key = ?
  `).bind(adminId, operation, idempotencyKey).first<QualityIdempotencyRow>()
}

function assertQualityIdempotency(row: QualityIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppMessagingError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于另一项质量操作')
  }
}

function pushEvidenceMessage(
  output: NonNullable<AdminConversationQualitySampleDetail['evidence']>['messages'],
  byId: Map<string, QualityMessageRow>,
  messageId: string | null,
  expectedHash: string | null,
  role: 'before' | 'target' | 'after',
) {
  if (!messageId || !expectedHash) return
  const message = byId.get(messageId)
  if (!message) return
  output.push({
    messageId: message.id,
    sequence: Number(message.sequence),
    role,
    senderType: normalizeSenderType(message.sender_type),
    text: message.body_text,
    bodySha256: message.body_sha256,
    snapshotIntegrityMatches: message.body_sha256 === expectedHash,
  })
}

async function loadQualityEvidenceMessages(
  db: D1Database,
  conversationId: string,
  evidence: QualityEvidenceRow,
) {
  const ids = [
    evidence.context_before_message_id,
    evidence.target_message_id,
    evidence.context_after_message_id,
    evidence.disclosure_message_id,
  ].filter((value): value is string => Boolean(value))
  const result = await db.prepare(`
    SELECT id, sequence, sender_type, actor_admin_id, body_text, body_sha256
    FROM app_conversation_messages
    WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(', ')})
    ORDER BY sequence ASC, id ASC
  `).bind(conversationId, ...ids).all<QualityMessageRow>()
  return new Map(result.results.map(message => [message.id, message]))
}

function qualityEvidenceSnapshotMatches(
  sample: QualitySampleRow,
  evidence: QualityEvidenceRow,
  messages: Map<string, QualityMessageRow>,
) {
  const references: Array<[string | null, string | null]> = [
    [evidence.context_before_message_id, evidence.context_before_body_sha256],
    [evidence.target_message_id, evidence.target_message_body_sha256],
    [evidence.context_after_message_id, evidence.context_after_body_sha256],
    [evidence.disclosure_message_id, evidence.disclosure_message_body_sha256],
  ]
  for (const [messageId, bodySha256] of references) {
    if (Boolean(messageId) !== Boolean(bodySha256)) return false
    if (!messageId || !bodySha256) continue
    if (messages.get(messageId)?.body_sha256 !== bodySha256) return false
  }
  const target = messages.get(evidence.target_message_id)
  return Boolean(
    target
    && target.sender_type === 'platform_operator'
    && target.actor_admin_id === sample.actual_operator_admin_id,
  )
}

function mapDisclosureEvidence(
  message: QualityMessageRow | null,
  snapshotHash: string | null,
  expectedHash: string | null,
): NonNullable<NonNullable<AdminConversationQualitySampleDetail['evidence']>['disclosure']> | null {
  if (!message || !snapshotHash) return null
  return {
    messageId: message.id,
    sequence: Number(message.sequence),
    text: message.body_text,
    bodySha256: message.body_sha256,
    snapshotIntegrityMatches: message.body_sha256 === snapshotHash,
    expectedIntegrityMatches: expectedHash ? message.body_sha256 === expectedHash : null,
  }
}

async function auditQualityBodyAccessDenied(
  db: D1Database,
  adminId: number,
  sampleId: string,
  requestId: string,
  now: Date,
) {
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app_conversation_quality.body_access_denied',
              'app_conversation_quality_sample', ?, NULL, ?, ?)
  `).bind(
    qualityId('audit'),
    adminId,
    sampleId,
    JSON.stringify({ requestId, reasonCode: 'QUALITY_SAMPLE_CLAIM_REQUIRED' }),
    now.toISOString(),
  ).run()
}

function normalizeSampleId(value: string) {
  const normalized = value.trim()
  if (!SAMPLE_ID_PATTERN.test(normalized)) {
    throw new AppMessagingError(400, 'QUALITY_SAMPLE_ID_INVALID', '抽检样本 ID 无效')
  }
  return normalized
}

function normalizeGroupId(value: string) {
  const normalized = value.trim()
  if (!GROUP_ID_PATTERN.test(normalized)) {
    throw new AppMessagingError(400, 'QUALITY_GROUP_ID_INVALID', '运营组 ID 无效')
  }
  return normalized
}

function normalizeTaskId(value: string) {
  const normalized = value.trim()
  if (!TASK_ID_PATTERN.test(normalized)) {
    throw new AppMessagingError(400, 'QUALITY_TASK_ID_INVALID', '改进任务 ID 无效')
  }
  return normalized
}

function normalizeIsoDate(value: unknown, label: string) {
  if (typeof value !== 'string') throw new AppMessagingError(400, 'QUALITY_DATE_INVALID', `${label}无效`)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new AppMessagingError(400, 'QUALITY_DATE_INVALID', `${label}无效`)
  return parsed.toISOString()
}

function normalizePositiveInteger(value: unknown, code: string, message: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new AppMessagingError(400, code, message)
  return parsed
}

function normalizeNonNegativeInteger(value: unknown, code: string, message: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new AppMessagingError(400, code, message)
  return parsed
}

function normalizeEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: string,
  message: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value as T[number])) {
    throw new AppMessagingError(400, code, message)
  }
  return value as T[number]
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string') throw new AppMessagingError(400, 'QUALITY_TEXT_INVALID', `${label}不能为空`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new AppMessagingError(400, 'QUALITY_TEXT_INVALID', `${label}需为 1—${maxLength} 个字符`)
  }
  return normalized
}

function normalizeReasonCode(value: unknown, label: string) {
  if (typeof value !== 'string') throw new AppMessagingError(400, 'QUALITY_REASON_INVALID', `${label}无效`)
  const normalized = value.trim()
  if (!/^[a-z0-9_]{3,80}$/u.test(normalized)) {
    throw new AppMessagingError(400, 'QUALITY_REASON_INVALID', `${label}无效`)
  }
  return normalized
}

function normalizeSampleStatus(value: string): QualitySampleStatus {
  if (value === 'in_review' || value === 'completed' || value === 'voided') return value
  return 'pending'
}

function normalizeDisclosureIntegrityStatus(value: string): DisclosureIntegrityStatus {
  if (value === 'missing' || value === 'mismatch' || value === 'unverifiable') return value
  return 'verified'
}

function normalizeQualityRating(value: string | null): QualityRating {
  if (value === 'needs_improvement' || value === 'fail') return value
  return 'pass'
}

function normalizeQualityOutcome(value: string): QualityOutcome {
  if (value === 'coaching_required' || value === 'safety_referral') return value
  return 'pass'
}

function normalizeTaskStatus(value: string): AdminConversationQualityTask['status'] {
  if (value === 'in_progress' || value === 'completed' || value === 'cancelled') return value
  return 'open'
}

function normalizeSenderType(value: string): 'viewer' | 'platform_operator' | 'system' {
  if (value === 'platform_operator' || value === 'system') return value
  return 'viewer'
}

function parseStringArray(value: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  }
  catch {
    return []
  }
}

function isFuture(value: string | null, now: Date) {
  return Boolean(value && new Date(value).getTime() > now.getTime())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function qualityId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}
