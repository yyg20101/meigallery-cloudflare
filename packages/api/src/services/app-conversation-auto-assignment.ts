import { normalizeConversationId } from './app-messaging'

export type ConversationAutoAssignmentTrigger = 'viewer_message' | 'manual_dispatch'
export type ConversationAutoAssignmentStatus =
  | 'assigned'
  | 'already_assigned'
  | 'policy_disabled'
  | 'conversation_ineligible'
  | 'no_matching_rule'
  | 'no_active_shift'
  | 'group_overloaded'
  | 'no_available_operator'
  | 'conflict'

export interface ConversationAutoAssignmentOutcome {
  conversationId: string
  status: ConversationAutoAssignmentStatus
  assignmentVersion: number | null
  groupId: string | null
  adminId: number | null
}

export type ConversationRoutingClaimAccessStatus =
  | 'legacy_unscoped'
  | 'eligible'
  | 'no_matching_rule'
  | 'not_group_member'
  | 'no_active_shift'

export interface ConversationRoutingClaimAccess {
  status: ConversationRoutingClaimAccessStatus
  canClaim: boolean
  policyVersion: number | null
  ruleId: string | null
  ruleVersion: number | null
  groupId: string | null
  groupName: string | null
  memberVersion: number | null
}

export interface ConversationRoutingClaimSubject {
  conversationId: string
  profileId: string
  regionCode: string | null
}

type PolicyRow = {
  mode: string
  strategy: string
  version: number
}

type ConversationRow = {
  id: string
  profile_id: string
  region_code: string | null
  status: string
  queue_status: string
  has_operator_response: number
  assignment_status: string | null
  assignment_version: number | null
  assigned_admin_id: number | null
  lease_expires_at: string | null
}

type RoutingRuleRow = {
  id: string
  version: number
  group_id: string
  group_name: string
  group_capacity: number
  group_daily_limit: number
}

type CandidateRow = {
  admin_id: number
  operator_active_before: number
  operator_capacity: number
  operator_new_today: number
  operator_daily_limit: number
  last_assigned_at: string | null
}

const SHANGHAI_TIMEZONE = 'Asia/Shanghai'

export async function resolveConversationRoutingClaimAccesses(
  db: D1Database,
  adminId: number,
  subjects: ConversationRoutingClaimSubject[],
  now = new Date(),
): Promise<Map<string, ConversationRoutingClaimAccess>> {
  const result = new Map<string, ConversationRoutingClaimAccess>()
  if (subjects.length === 0) return result
  const policy = await db.prepare(`
    SELECT version FROM app_conversation_assignment_policies WHERE scope = 'global'
  `).first<{ version: number }>()
  if (!policy) {
    for (const subject of subjects) result.set(subject.conversationId, legacyClaimAccess())
    return result
  }
  const [rulesResult, membershipsResult, shiftsResult] = await Promise.all([
    db.prepare(`
      SELECT rule.id, rule.version, rule.match_type, rule.match_value,
             rule.group_id, operation_group.name AS group_name, rule.priority
      FROM app_conversation_routing_rules rule
      JOIN app_conversation_groups operation_group ON operation_group.id = rule.group_id
      WHERE rule.status = 'active' AND operation_group.status = 'active'
      ORDER BY CASE rule.match_type WHEN 'profile' THEN 0 WHEN 'region' THEN 1 ELSE 2 END,
               rule.priority ASC, rule.id ASC
    `).all<{
      id: string
      version: number
      match_type: string
      match_value: string
      group_id: string
      group_name: string
      priority: number
    }>(),
    db.prepare(`
      SELECT group_id, version
      FROM app_conversation_group_members
      WHERE admin_id = ? AND status = 'active'
        AND accepts_new_assignments = 1
        AND member_role IN ('operator', 'lead')
    `).bind(adminId).all<{ group_id: string; version: number }>(),
    db.prepare(`
      SELECT id, group_id, weekday, start_minute, end_minute
      FROM app_conversation_group_shifts
      WHERE status = 'active'
    `).all<{
      id: string
      group_id: string
      weekday: number
      start_minute: number
      end_minute: number
    }>(),
  ])
  const membershipVersions = new Map(
    membershipsResult.results.map(row => [row.group_id, Number(row.version)]),
  )
  const local = shanghaiClock(now)
  const activeShiftGroups = new Set(
    shiftsResult.results
      .filter(shift => shiftActiveAt(shift, local.weekday, local.minute))
      .map(shift => shift.group_id),
  )
  for (const subject of subjects) {
    const rule = rulesResult.results.find(candidate =>
      (candidate.match_type === 'profile' && candidate.match_value === subject.profileId)
      || (candidate.match_type === 'region' && candidate.match_value === subject.regionCode)
      || (candidate.match_type === 'default' && candidate.match_value === '*'),
    )
    if (!rule) {
      result.set(subject.conversationId, configuredClaimAccess('no_matching_rule', policy.version))
      continue
    }
    const memberVersion = membershipVersions.get(rule.group_id) ?? null
    if (memberVersion === null) {
      result.set(subject.conversationId, {
        ...configuredClaimAccess('not_group_member', policy.version),
        ruleId: rule.id,
        ruleVersion: Number(rule.version),
        groupId: rule.group_id,
        groupName: rule.group_name,
      })
      continue
    }
    if (!activeShiftGroups.has(rule.group_id)) {
      result.set(subject.conversationId, {
        ...configuredClaimAccess('no_active_shift', policy.version),
        ruleId: rule.id,
        ruleVersion: Number(rule.version),
        groupId: rule.group_id,
        groupName: rule.group_name,
        memberVersion,
      })
      continue
    }
    result.set(subject.conversationId, {
      status: 'eligible',
      canClaim: true,
      policyVersion: Number(policy.version),
      ruleId: rule.id,
      ruleVersion: Number(rule.version),
      groupId: rule.group_id,
      groupName: rule.group_name,
      memberVersion,
    })
  }
  return result
}

export async function autoAssignConversationIfEligible(
  db: D1Database,
  conversationIdValue: string,
  trigger: ConversationAutoAssignmentTrigger,
  now = new Date(),
): Promise<ConversationAutoAssignmentOutcome> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const empty = (status: ConversationAutoAssignmentStatus): ConversationAutoAssignmentOutcome => ({
    conversationId,
    status,
    assignmentVersion: null,
    groupId: null,
    adminId: null,
  })
  const policy = await db.prepare(`
    SELECT mode, strategy, version
    FROM app_conversation_assignment_policies
    WHERE scope = 'global'
  `).first<PolicyRow>()
  if (!policy || policy.mode !== 'automatic' || policy.strategy !== 'least_loaded_oldest') {
    return empty('policy_disabled')
  }

  const nowIso = now.toISOString()
  const conversation = await db.prepare(`
    SELECT conversation.id, conversation.profile_id, projection.region_code,
           conversation.status, conversation.queue_status,
           EXISTS (
             SELECT 1 FROM app_conversation_messages message
             WHERE message.conversation_id = conversation.id
               AND message.sender_type = 'platform_operator'
               AND message.status = 'accepted'
           ) AS has_operator_response,
           assignment.status AS assignment_status,
           assignment.version AS assignment_version,
           assignment.assigned_admin_id,
           assignment.lease_expires_at
    FROM app_conversations conversation
    JOIN profile_public_projections projection ON projection.profile_id = conversation.profile_id
    LEFT JOIN app_conversation_assignment_state assignment
      ON assignment.conversation_id = conversation.id
    WHERE conversation.id = ?
  `).bind(conversationId).first<ConversationRow>()
  if (!conversation || conversation.status !== 'active' || conversation.queue_status !== 'awaiting_operator') {
    return empty('conversation_ineligible')
  }
  if (
    conversation.assignment_status === 'active'
    && conversation.assigned_admin_id !== null
    && conversation.lease_expires_at
    && new Date(conversation.lease_expires_at).getTime() > now.getTime()
  ) {
    return {
      conversationId,
      status: 'already_assigned',
      assignmentVersion: Number(conversation.assignment_version),
      groupId: null,
      adminId: Number(conversation.assigned_admin_id),
    }
  }

  const rule = await findRoutingRule(db, conversation.profile_id, conversation.region_code)
  if (!rule) return empty('no_matching_rule')

  const local = shanghaiClock(now)
  const shift = await findActiveShift(db, rule.group_id, local)
  if (!shift) {
    return { ...empty('no_active_shift'), groupId: rule.group_id }
  }

  const isNewFirstResponse = conversation.has_operator_response !== 1
  const groupLoad = await readGroupLoad(db, rule.group_id, local.serviceDay, nowIso)
  if (
    groupLoad.active >= Number(rule.group_capacity)
    || (isNewFirstResponse && groupLoad.newFirstResponses >= Number(rule.group_daily_limit))
  ) {
    return { ...empty('group_overloaded'), groupId: rule.group_id }
  }

  const candidate = await findCandidate(
    db,
    rule.group_id,
    local.serviceDay,
    nowIso,
    isNewFirstResponse,
  )
  if (!candidate) return { ...empty('no_available_operator'), groupId: rule.group_id }

  const currentVersion = Number(conversation.assignment_version ?? 0)
  const nextVersion = currentVersion + 1
  const mutationToken = crypto.randomUUID()
  const assignmentEventId = prefixedId('cae')
  const autoEventId = prefixedId('cra')
  const runtime = await db.prepare(`
    SELECT assignment_lease_minutes
    FROM app_messaging_runtime_controls
    WHERE scope = 'global'
  `).first<{ assignment_lease_minutes: number }>()
  if (!runtime) return { ...empty('conflict'), groupId: rule.group_id }
  const leaseExpiresAt = new Date(
    now.getTime() + Number(runtime.assignment_lease_minutes) * 60_000,
  ).toISOString()
  const stateStatement = currentVersion > 0
    ? db.prepare(`
        UPDATE app_conversation_assignment_state
        SET assigned_admin_id = ?, status = 'active', version = ?,
            lease_expires_at = ?, mutation_token = ?, assigned_at = ?,
            released_at = NULL, updated_at = ?
        WHERE conversation_id = ? AND version = ?
          AND (status <> 'active' OR datetime(lease_expires_at) <= datetime(?))
          AND EXISTS (
            SELECT 1 FROM app_conversations conversation
            WHERE conversation.id = ?
              AND conversation.status = 'active'
              AND conversation.queue_status = 'awaiting_operator'
          )
          AND EXISTS (
            SELECT 1
            FROM app_conversation_assignment_policies policy
            JOIN app_conversation_routing_rules rule ON rule.id = ?
            JOIN app_conversation_groups operation_group ON operation_group.id = rule.group_id
            JOIN app_conversation_group_members member
              ON member.group_id = operation_group.id AND member.admin_id = ?
            JOIN users admin ON admin.id = member.admin_id
            JOIN app_messaging_runtime_controls runtime ON runtime.scope = 'global'
            JOIN app_conversations conversation
              ON conversation.id = app_conversation_assignment_state.conversation_id
            JOIN profile_public_projections projection ON projection.profile_id = conversation.profile_id
            WHERE policy.scope = 'global'
              AND policy.mode = 'automatic'
              AND policy.version = ?
              AND rule.status = 'active'
              AND rule.group_id = ?
              AND operation_group.status = 'active'
              AND member.status = 'active'
              AND member.accepts_new_assignments = 1
              AND member.member_role IN ('operator', 'lead')
              AND admin.status = 'active'
              AND admin.role IN ('admin', 'owner')
              AND (
                (rule.match_type = 'profile' AND rule.match_value = conversation.profile_id)
                OR (rule.match_type = 'region' AND rule.match_value = projection.region_code)
                OR (rule.match_type = 'default' AND rule.match_value = '*')
              )
              AND rule.id = (
                SELECT candidate_rule.id
                FROM app_conversation_routing_rules candidate_rule
                JOIN app_conversation_groups candidate_group
                  ON candidate_group.id = candidate_rule.group_id
                WHERE candidate_rule.status = 'active' AND candidate_group.status = 'active'
                  AND (
                    (candidate_rule.match_type = 'profile' AND candidate_rule.match_value = conversation.profile_id)
                    OR (candidate_rule.match_type = 'region' AND candidate_rule.match_value = projection.region_code)
                    OR (candidate_rule.match_type = 'default' AND candidate_rule.match_value = '*')
                  )
                ORDER BY
                  CASE candidate_rule.match_type WHEN 'profile' THEN 0 WHEN 'region' THEN 1 ELSE 2 END,
                  candidate_rule.priority ASC,
                  candidate_rule.id ASC
                LIMIT 1
              )
              AND (
                SELECT COUNT(*) FROM app_conversation_assignment_state operator_assignment
                WHERE operator_assignment.assigned_admin_id = member.admin_id
                  AND operator_assignment.status = 'active'
                  AND datetime(operator_assignment.lease_expires_at) > datetime(?)
              ) < MIN(member.max_active_assignments, runtime.max_active_assignments_per_operator)
              AND (
                SELECT COUNT(DISTINCT group_assignment.conversation_id)
                FROM app_conversation_assignment_state group_assignment
                JOIN app_conversation_group_members group_member
                  ON group_member.group_id = operation_group.id
                 AND group_member.admin_id = group_assignment.assigned_admin_id
                WHERE group_member.status = 'active'
                  AND group_assignment.status = 'active'
                  AND datetime(group_assignment.lease_expires_at) > datetime(?)
              ) < operation_group.max_active_assignments
              AND (
                ? = 0
                OR (
                  (
                    SELECT COUNT(*) FROM app_conversation_routing_assignment_events operator_event
                    WHERE operator_event.admin_id = member.admin_id
                      AND operator_event.service_day = ?
                      AND operator_event.is_new_first_response = 1
                  ) < member.max_new_first_responses_per_service_day
                  AND (
                    SELECT COUNT(*) FROM app_conversation_routing_assignment_events group_event
                    WHERE group_event.group_id = operation_group.id
                      AND group_event.service_day = ?
                      AND group_event.is_new_first_response = 1
                  ) < operation_group.max_new_first_responses_per_service_day
                )
              )
              AND EXISTS (
                SELECT 1 FROM app_conversation_group_shifts shift
                WHERE shift.group_id = operation_group.id AND shift.status = 'active'
                  AND (
                    (shift.weekday = ? AND shift.start_minute < shift.end_minute
                      AND shift.start_minute <= ? AND shift.end_minute > ?)
                    OR (shift.weekday = ? AND shift.start_minute > shift.end_minute
                      AND shift.start_minute <= ?)
                    OR (shift.weekday = ? AND shift.start_minute > shift.end_minute
                      AND shift.end_minute > ?)
                  )
              )
          )
      `).bind(
        candidate.admin_id,
        nextVersion,
        leaseExpiresAt,
        mutationToken,
        nowIso,
        nowIso,
        conversationId,
        currentVersion,
        nowIso,
        conversationId,
        rule.id,
        candidate.admin_id,
        policy.version,
        rule.group_id,
        nowIso,
        nowIso,
        isNewFirstResponse ? 1 : 0,
        local.serviceDay,
        local.serviceDay,
        local.weekday,
        local.minute,
        local.minute,
        local.weekday,
        local.minute,
        local.previousWeekday,
        local.minute,
      )
    : db.prepare(`
        INSERT INTO app_conversation_assignment_state (
          conversation_id, assigned_admin_id, status, version,
          lease_expires_at, mutation_token, assigned_at, released_at, updated_at
        )
        SELECT conversation.id, ?, 'active', 1, ?, ?, ?, NULL, ?
        FROM app_conversations conversation
        JOIN app_conversation_assignment_policies policy ON policy.scope = 'global'
        JOIN app_conversation_routing_rules rule ON rule.id = ?
        JOIN app_conversation_groups operation_group ON operation_group.id = rule.group_id
        JOIN app_conversation_group_members member
          ON member.group_id = operation_group.id AND member.admin_id = ?
        JOIN users admin ON admin.id = member.admin_id
        JOIN app_messaging_runtime_controls runtime ON runtime.scope = 'global'
        JOIN profile_public_projections projection ON projection.profile_id = conversation.profile_id
        WHERE conversation.id = ?
          AND conversation.status = 'active'
          AND conversation.queue_status = 'awaiting_operator'
          AND policy.mode = 'automatic'
          AND policy.version = ?
          AND rule.status = 'active'
          AND rule.group_id = ?
          AND operation_group.status = 'active'
          AND member.status = 'active'
          AND member.accepts_new_assignments = 1
          AND member.member_role IN ('operator', 'lead')
          AND admin.status = 'active'
          AND admin.role IN ('admin', 'owner')
          AND (
            (rule.match_type = 'profile' AND rule.match_value = conversation.profile_id)
            OR (rule.match_type = 'region' AND rule.match_value = projection.region_code)
            OR (rule.match_type = 'default' AND rule.match_value = '*')
          )
          AND rule.id = (
            SELECT candidate_rule.id
            FROM app_conversation_routing_rules candidate_rule
            JOIN app_conversation_groups candidate_group
              ON candidate_group.id = candidate_rule.group_id
            WHERE candidate_rule.status = 'active' AND candidate_group.status = 'active'
              AND (
                (candidate_rule.match_type = 'profile' AND candidate_rule.match_value = conversation.profile_id)
                OR (candidate_rule.match_type = 'region' AND candidate_rule.match_value = projection.region_code)
                OR (candidate_rule.match_type = 'default' AND candidate_rule.match_value = '*')
              )
            ORDER BY
              CASE candidate_rule.match_type WHEN 'profile' THEN 0 WHEN 'region' THEN 1 ELSE 2 END,
              candidate_rule.priority ASC,
              candidate_rule.id ASC
            LIMIT 1
          )
          AND (
            SELECT COUNT(*) FROM app_conversation_assignment_state operator_assignment
            WHERE operator_assignment.assigned_admin_id = member.admin_id
              AND operator_assignment.status = 'active'
              AND datetime(operator_assignment.lease_expires_at) > datetime(?)
          ) < MIN(member.max_active_assignments, runtime.max_active_assignments_per_operator)
          AND (
            SELECT COUNT(DISTINCT group_assignment.conversation_id)
            FROM app_conversation_assignment_state group_assignment
            JOIN app_conversation_group_members group_member
              ON group_member.group_id = operation_group.id
             AND group_member.admin_id = group_assignment.assigned_admin_id
            WHERE group_member.status = 'active'
              AND group_assignment.status = 'active'
              AND datetime(group_assignment.lease_expires_at) > datetime(?)
          ) < operation_group.max_active_assignments
          AND (
            ? = 0
            OR (
              (
                SELECT COUNT(*) FROM app_conversation_routing_assignment_events operator_event
                WHERE operator_event.admin_id = member.admin_id
                  AND operator_event.service_day = ?
                  AND operator_event.is_new_first_response = 1
              ) < member.max_new_first_responses_per_service_day
              AND (
                SELECT COUNT(*) FROM app_conversation_routing_assignment_events group_event
                WHERE group_event.group_id = operation_group.id
                  AND group_event.service_day = ?
                  AND group_event.is_new_first_response = 1
              ) < operation_group.max_new_first_responses_per_service_day
            )
          )
          AND EXISTS (
            SELECT 1 FROM app_conversation_group_shifts shift
            WHERE shift.group_id = operation_group.id AND shift.status = 'active'
              AND (
                (shift.weekday = ? AND shift.start_minute < shift.end_minute
                  AND shift.start_minute <= ? AND shift.end_minute > ?)
                OR (shift.weekday = ? AND shift.start_minute > shift.end_minute
                  AND shift.start_minute <= ?)
                OR (shift.weekday = ? AND shift.start_minute > shift.end_minute
                  AND shift.end_minute > ?)
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM app_conversation_assignment_state existing
            WHERE existing.conversation_id = conversation.id
          )
      `).bind(
        candidate.admin_id,
        leaseExpiresAt,
        mutationToken,
        nowIso,
        nowIso,
        rule.id,
        candidate.admin_id,
        conversationId,
        policy.version,
        rule.group_id,
        nowIso,
        nowIso,
        isNewFirstResponse ? 1 : 0,
        local.serviceDay,
        local.serviceDay,
        local.weekday,
        local.minute,
        local.minute,
        local.weekday,
        local.minute,
        local.previousWeekday,
        local.minute,
      )

  try {
    await db.batch([
      stateStatement,
      db.prepare(`
        INSERT INTO app_conversation_assignment_events (
          id, conversation_id, version, event_type, subject_admin_id,
          actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
        )
        SELECT ?, conversation_id, version, 'claimed', assigned_admin_id,
               'system', NULL, 'auto_assignment', lease_expires_at, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ?
          AND status = 'active' AND assigned_admin_id = ?
      `).bind(
        assignmentEventId,
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
        candidate.admin_id,
      ),
      db.prepare(`
        INSERT INTO app_conversation_routing_assignment_events (
          id, conversation_id, assignment_version, group_id, admin_id,
          policy_version, routing_rule_id, trigger_code, service_day,
          is_new_first_response, operator_active_before, operator_capacity,
          group_active_before, group_capacity, created_at
        )
        SELECT ?, conversation_id, version, ?, assigned_admin_id,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ?
          AND status = 'active' AND assigned_admin_id = ?
      `).bind(
        autoEventId,
        rule.group_id,
        policy.version,
        rule.id,
        trigger,
        local.serviceDay,
        isNewFirstResponse ? 1 : 0,
        candidate.operator_active_before,
        candidate.operator_capacity,
        groupLoad.active,
        rule.group_capacity,
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
        candidate.admin_id,
      ),
    ])
  }
  catch {
    return await resolveConflictOutcome(db, conversationId, rule.group_id, now)
  }

  const stored = await db.prepare(`
    SELECT assigned_admin_id, version
    FROM app_conversation_assignment_state
    WHERE conversation_id = ? AND mutation_token = ?
      AND status = 'active' AND assigned_admin_id = ?
  `).bind(conversationId, mutationToken, candidate.admin_id).first<{
    assigned_admin_id: number
    version: number
  }>()
  if (!stored) return await resolveConflictOutcome(db, conversationId, rule.group_id, now)
  return {
    conversationId,
    status: 'assigned',
    assignmentVersion: Number(stored.version),
    groupId: rule.group_id,
    adminId: Number(stored.assigned_admin_id),
  }
}

async function findRoutingRule(
  db: D1Database,
  profileId: string,
  regionCode: string | null,
): Promise<RoutingRuleRow | null> {
  return await db.prepare(`
    SELECT rule.id, rule.group_id,
           rule.version, operation_group.name AS group_name,
           operation_group.max_active_assignments AS group_capacity,
           operation_group.max_new_first_responses_per_service_day AS group_daily_limit
    FROM app_conversation_routing_rules rule
    JOIN app_conversation_groups operation_group ON operation_group.id = rule.group_id
    WHERE rule.status = 'active'
      AND operation_group.status = 'active'
      AND (
        (rule.match_type = 'profile' AND rule.match_value = ?)
        OR (rule.match_type = 'region' AND rule.match_value = ?)
        OR (rule.match_type = 'default' AND rule.match_value = '*')
      )
    ORDER BY
      CASE rule.match_type WHEN 'profile' THEN 0 WHEN 'region' THEN 1 ELSE 2 END,
      rule.priority ASC,
      rule.id ASC
    LIMIT 1
  `).bind(profileId, regionCode ?? '').first<RoutingRuleRow>()
}

function legacyClaimAccess(): ConversationRoutingClaimAccess {
  return {
    status: 'legacy_unscoped',
    canClaim: true,
    policyVersion: null,
    ruleId: null,
    ruleVersion: null,
    groupId: null,
    groupName: null,
    memberVersion: null,
  }
}

function configuredClaimAccess(
  status: Exclude<ConversationRoutingClaimAccessStatus, 'legacy_unscoped' | 'eligible'>,
  policyVersion: number,
): ConversationRoutingClaimAccess {
  return {
    status,
    canClaim: false,
    policyVersion: Number(policyVersion),
    ruleId: null,
    ruleVersion: null,
    groupId: null,
    groupName: null,
    memberVersion: null,
  }
}

function shiftActiveAt(
  shift: { weekday: number; start_minute: number; end_minute: number },
  weekday: number,
  minute: number,
): boolean {
  const start = Number(shift.start_minute)
  const end = Number(shift.end_minute)
  const previousWeekday = weekday === 1 ? 7 : weekday - 1
  if (start < end) return Number(shift.weekday) === weekday && start <= minute && end > minute
  return (Number(shift.weekday) === weekday && start <= minute)
    || (Number(shift.weekday) === previousWeekday && end > minute)
}

async function findActiveShift(
  db: D1Database,
  groupId: string,
  local: ShanghaiClock,
): Promise<{ id: string } | null> {
  return await db.prepare(`
    SELECT id
    FROM app_conversation_group_shifts
    WHERE group_id = ? AND status = 'active'
      AND (
        (
          weekday = ?
          AND start_minute < end_minute
          AND start_minute <= ? AND end_minute > ?
        )
        OR (
          weekday = ?
          AND start_minute > end_minute
          AND start_minute <= ?
        )
        OR (
          weekday = ?
          AND start_minute > end_minute
          AND end_minute > ?
        )
      )
    ORDER BY weekday ASC, start_minute ASC, id ASC
    LIMIT 1
  `).bind(
    groupId,
    local.weekday,
    local.minute,
    local.minute,
    local.weekday,
    local.minute,
    local.previousWeekday,
    local.minute,
  ).first<{ id: string }>()
}

async function readGroupLoad(
  db: D1Database,
  groupId: string,
  serviceDay: string,
  nowIso: string,
): Promise<{ active: number; newFirstResponses: number }> {
  const row = await db.prepare(`
    SELECT
      (
        SELECT COUNT(DISTINCT assignment.conversation_id)
        FROM app_conversation_assignment_state assignment
        JOIN app_conversation_group_members member
          ON member.group_id = ? AND member.admin_id = assignment.assigned_admin_id
        WHERE member.status = 'active'
          AND assignment.status = 'active'
          AND datetime(assignment.lease_expires_at) > datetime(?)
      ) AS active_count,
      (
        SELECT COUNT(*)
        FROM app_conversation_routing_assignment_events event
        WHERE event.group_id = ?
          AND event.service_day = ?
          AND event.is_new_first_response = 1
      ) AS new_first_response_count
  `).bind(groupId, nowIso, groupId, serviceDay).first<{
    active_count: number
    new_first_response_count: number
  }>()
  return {
    active: Math.max(0, Number(row?.active_count ?? 0)),
    newFirstResponses: Math.max(0, Number(row?.new_first_response_count ?? 0)),
  }
}

async function findCandidate(
  db: D1Database,
  groupId: string,
  serviceDay: string,
  nowIso: string,
  isNewFirstResponse: boolean,
): Promise<CandidateRow | null> {
  return await db.prepare(`
    WITH candidate_load AS (
      SELECT member.admin_id,
             MIN(member.max_active_assignments, runtime.max_active_assignments_per_operator)
               AS operator_capacity,
             member.max_new_first_responses_per_service_day AS operator_daily_limit,
             (
               SELECT COUNT(*) FROM app_conversation_assignment_state assignment
               WHERE assignment.assigned_admin_id = member.admin_id
                 AND assignment.status = 'active'
                 AND datetime(assignment.lease_expires_at) > datetime(?)
             ) AS operator_active_before,
             (
               SELECT COUNT(*) FROM app_conversation_routing_assignment_events event
               WHERE event.admin_id = member.admin_id
                 AND event.service_day = ?
                 AND event.is_new_first_response = 1
             ) AS operator_new_today,
             (
               SELECT MAX(event.created_at) FROM app_conversation_routing_assignment_events event
               WHERE event.admin_id = member.admin_id
             ) AS last_assigned_at
      FROM app_conversation_group_members member
      JOIN users admin ON admin.id = member.admin_id
      JOIN app_messaging_runtime_controls runtime ON runtime.scope = 'global'
      WHERE member.group_id = ?
        AND member.status = 'active'
        AND member.accepts_new_assignments = 1
        AND member.member_role IN ('operator', 'lead')
        AND admin.status = 'active'
        AND admin.role IN ('admin', 'owner')
    )
    SELECT admin_id, operator_active_before, operator_capacity,
           operator_new_today, operator_daily_limit, last_assigned_at
    FROM candidate_load
    WHERE operator_active_before < operator_capacity
      AND (? = 0 OR operator_new_today < operator_daily_limit)
    ORDER BY
      (operator_active_before * 1.0 / operator_capacity) ASC,
      operator_active_before ASC,
      COALESCE(last_assigned_at, '') ASC,
      admin_id ASC
    LIMIT 1
  `).bind(nowIso, serviceDay, groupId, isNewFirstResponse ? 1 : 0).first<CandidateRow>()
}

async function resolveConflictOutcome(
  db: D1Database,
  conversationId: string,
  groupId: string,
  now: Date,
): Promise<ConversationAutoAssignmentOutcome> {
  const assignment = await db.prepare(`
    SELECT assigned_admin_id, version, lease_expires_at
    FROM app_conversation_assignment_state
    WHERE conversation_id = ? AND status = 'active'
  `).bind(conversationId).first<{
    assigned_admin_id: number | null
    version: number
    lease_expires_at: string | null
  }>()
  if (
    assignment?.assigned_admin_id !== null
    && assignment?.lease_expires_at
    && new Date(assignment.lease_expires_at).getTime() > now.getTime()
  ) {
    return {
      conversationId,
      status: 'already_assigned',
      assignmentVersion: Number(assignment.version),
      groupId,
      adminId: Number(assignment.assigned_admin_id),
    }
  }
  return {
    conversationId,
    status: 'conflict',
    assignmentVersion: null,
    groupId,
    adminId: null,
  }
}

type ShanghaiClock = {
  serviceDay: string
  weekday: number
  previousWeekday: number
  minute: number
  localTime: string
}

export function shanghaiClock(now: Date): ShanghaiClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHANGHAI_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as const)[
    value('weekday') as keyof { Mon: 1; Tue: 2; Wed: 3; Thu: 4; Fri: 5; Sat: 6; Sun: 7 }
  ] ?? 1
  const hour = Number(value('hour'))
  const minuteValue = Number(value('minute'))
  const year = value('year')
  const month = value('month')
  const day = value('day')
  return {
    serviceDay: `${year}-${month}-${day}`,
    weekday,
    previousWeekday: weekday === 1 ? 7 : weekday - 1,
    minute: hour * 60 + minuteValue,
    localTime: `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}:00+08:00`,
  }
}

function prefixedId(prefix: 'cae' | 'cra') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}
