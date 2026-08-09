import {
  AppMessagingError,
  hashCanonical,
  normalizeIdempotencyKey,
} from './app-messaging'
import {
  autoAssignConversationIfEligible,
  shanghaiClock,
  type ConversationAutoAssignmentOutcome,
} from './app-conversation-auto-assignment'

export type ConversationGroupStatus = 'active' | 'inactive'
export type ConversationGroupMemberRole = 'operator' | 'lead' | 'quality'
export type ConversationRoutingMode = 'manual' | 'automatic'
export type ConversationRoutingMatchType = 'default' | 'profile' | 'region'

export interface ConversationRoutingActor {
  adminId: number
  role: string
}

export interface AdminConversationRoutingPolicy {
  mode: ConversationRoutingMode
  strategy: 'least_loaded_oldest'
  unassignedBehavior: 'keep_unassigned'
  timezone: 'Asia/Shanghai'
  maxDispatchBatch: number
  version: number
  updatedAt: string
}

export interface AdminConversationGroupMember {
  adminId: number
  displayName: string
  accountRole: 'admin' | 'owner'
  memberRole: ConversationGroupMemberRole
  status: ConversationGroupStatus
  acceptsNewAssignments: boolean
  maxActiveAssignments: number
  maxNewFirstResponsesPerServiceDay: number
  activeAssignmentCount: number
  newFirstResponsesToday: number
  version: number
  updatedAt: string
}

export interface AdminConversationGroupShift {
  shiftId: string
  name: string
  weekday: number
  startMinute: number
  endMinute: number
  overnight: boolean
  status: ConversationGroupStatus
  version: number
  updatedAt: string
}

export interface AdminConversationGroup {
  groupId: string
  code: string
  name: string
  status: ConversationGroupStatus
  timezone: 'Asia/Shanghai'
  maxActiveAssignments: number
  maxNewFirstResponsesPerServiceDay: number
  activeAssignmentCount: number
  newFirstResponsesToday: number
  loadPercent: number
  onDuty: boolean
  configurationState: 'ready' | 'no_member' | 'no_shift' | 'inactive'
  version: number
  updatedAt: string
  members: AdminConversationGroupMember[]
  shifts: AdminConversationGroupShift[]
}

export interface AdminConversationRoutingRule {
  ruleId: string
  name: string
  matchType: ConversationRoutingMatchType
  matchValue: string
  groupId: string
  groupName: string
  groupStatus: ConversationGroupStatus
  priority: number
  status: ConversationGroupStatus
  version: number
  updatedAt: string
}

export interface AdminConversationRoutingSnapshot {
  generatedAt: string
  localTime: string
  serviceDay: string
  permissions: {
    canManageGlobal: boolean
    manageableGroupIds: string[]
  }
  policy: AdminConversationRoutingPolicy | null
  queue: {
    awaitingOperator: number
    unassignedAwaitingOperator: number
    assignedAwaitingOperator: number
  }
  diagnostics: {
    state: 'normal' | 'no_shift' | 'overloaded' | 'configuration_conflict'
    messages: string[]
  }
  operators: Array<{
    adminId: number
    displayName: string
    accountRole: 'admin' | 'owner'
    accountStatus: string
  }>
  groups: AdminConversationGroup[]
  rules: AdminConversationRoutingRule[]
}

export interface CreateConversationGroupInput {
  code?: unknown
  name?: unknown
  maxActiveAssignments?: unknown
  maxNewFirstResponsesPerServiceDay?: unknown
}

export interface UpdateConversationGroupInput extends CreateConversationGroupInput {
  status?: unknown
  expectedVersion?: unknown
}

export interface UpsertConversationGroupMemberInput {
  memberRole?: unknown
  status?: unknown
  acceptsNewAssignments?: unknown
  maxActiveAssignments?: unknown
  maxNewFirstResponsesPerServiceDay?: unknown
  expectedVersion?: unknown
}

export interface CreateConversationGroupShiftInput {
  name?: unknown
  weekday?: unknown
  startMinute?: unknown
  endMinute?: unknown
}

export interface UpdateConversationGroupShiftInput extends CreateConversationGroupShiftInput {
  status?: unknown
  expectedVersion?: unknown
}

export interface UpsertConversationRoutingPolicyInput {
  mode?: unknown
  maxDispatchBatch?: unknown
  expectedVersion?: unknown
}

export interface CreateConversationRoutingRuleInput {
  name?: unknown
  matchType?: unknown
  matchValue?: unknown
  groupId?: unknown
  priority?: unknown
}

export interface UpdateConversationRoutingRuleInput extends CreateConversationRoutingRuleInput {
  status?: unknown
  expectedVersion?: unknown
}

export interface AdminConversationDispatchResult {
  dispatchId: string
  requested: number
  assigned: number
  alreadyAssigned: number
  skipped: number
  outcomes: ConversationAutoAssignmentOutcome[]
  replayed: boolean
}

type GroupRow = {
  id: string
  code: string
  name: string
  status: string
  timezone: string
  max_active_assignments: number
  max_new_first_responses_per_service_day: number
  version: number
  updated_at: string
}

type MemberRow = {
  group_id: string
  admin_id: number
  nickname: string | null
  username: string | null
  account_role: string
  account_status: string
  member_role: string
  member_status: string
  accepts_new_assignments: number
  max_active_assignments: number
  max_new_first_responses_per_service_day: number
  active_assignment_count: number
  new_first_response_count: number
  version: number
  updated_at: string
}

type ShiftRow = {
  id: string
  group_id: string
  name: string
  weekday: number
  start_minute: number
  end_minute: number
  status: string
  version: number
  updated_at: string
}

type RuleRow = {
  id: string
  name: string
  match_type: string
  match_value: string
  group_id: string
  group_name: string
  group_status: string
  priority: number
  status: string
  version: number
  updated_at: string
}

type PolicyRow = {
  mode: string
  strategy: string
  unassigned_behavior: string
  timezone: string
  max_dispatch_batch: number
  version: number
  updated_at: string
}

type IdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
  result_json: string | null
}

const GROUP_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/u
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/u
const REGION_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/u

export async function getAdminConversationRoutingSnapshot(
  db: D1Database,
  actor: ConversationRoutingActor,
  now = new Date(),
): Promise<AdminConversationRoutingSnapshot> {
  const nowIso = now.toISOString()
  const local = shanghaiClock(now)
  const [policy, groupsResult, membersResult, shiftsResult, rulesResult, operatorsResult, queue] = await Promise.all([
    db.prepare(`
      SELECT mode, strategy, unassigned_behavior, timezone,
             max_dispatch_batch, version, updated_at
      FROM app_conversation_assignment_policies WHERE scope = 'global'
    `).first<PolicyRow>(),
    db.prepare(`
      SELECT id, code, name, status, timezone, max_active_assignments,
             max_new_first_responses_per_service_day, version, updated_at
      FROM app_conversation_groups
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name ASC, id ASC
    `).all<GroupRow>(),
    db.prepare(`
      SELECT member.group_id, member.admin_id, admin.nickname, admin.username,
             admin.role AS account_role, admin.status AS account_status,
             member.member_role, member.status AS member_status,
             member.accepts_new_assignments, member.max_active_assignments,
             member.max_new_first_responses_per_service_day,
             member.version, member.updated_at,
             (
               SELECT COUNT(*) FROM app_conversation_assignment_state assignment
               WHERE assignment.assigned_admin_id = member.admin_id
                 AND assignment.status = 'active'
                 AND datetime(assignment.lease_expires_at) > datetime(?)
             ) AS active_assignment_count,
             (
               SELECT COUNT(*) FROM app_conversation_routing_assignment_events event
               WHERE event.admin_id = member.admin_id
                 AND event.service_day = ?
                 AND event.is_new_first_response = 1
             ) AS new_first_response_count
      FROM app_conversation_group_members member
      JOIN users admin ON admin.id = member.admin_id
      ORDER BY member.group_id ASC,
               CASE member.member_role WHEN 'lead' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,
               COALESCE(NULLIF(trim(admin.nickname), ''), NULLIF(trim(admin.username), ''), CAST(admin.id AS TEXT)) ASC
    `).bind(nowIso, local.serviceDay).all<MemberRow>(),
    db.prepare(`
      SELECT id, group_id, name, weekday, start_minute, end_minute,
             status, version, updated_at
      FROM app_conversation_group_shifts
      ORDER BY group_id ASC, weekday ASC, start_minute ASC, id ASC
    `).all<ShiftRow>(),
    db.prepare(`
      SELECT rule.id, rule.name, rule.match_type, rule.match_value,
             rule.group_id, operation_group.name AS group_name,
             operation_group.status AS group_status,
             rule.priority, rule.status, rule.version, rule.updated_at
      FROM app_conversation_routing_rules rule
      JOIN app_conversation_groups operation_group ON operation_group.id = rule.group_id
      ORDER BY CASE rule.status WHEN 'active' THEN 0 ELSE 1 END,
               CASE rule.match_type WHEN 'profile' THEN 0 WHEN 'region' THEN 1 ELSE 2 END,
               rule.priority ASC, rule.id ASC
    `).all<RuleRow>(),
    db.prepare(`
      SELECT id, nickname, username, role, status
      FROM users
      WHERE role IN ('admin', 'owner')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,
               COALESCE(NULLIF(trim(nickname), ''), NULLIF(trim(username), ''), CAST(id AS TEXT)) ASC,
               id ASC
    `).all<{
      id: number
      nickname: string | null
      username: string | null
      role: string
      status: string
    }>(),
    db.prepare(`
      SELECT
        COUNT(*) AS awaiting_operator,
        SUM(CASE WHEN assignment.conversation_id IS NULL
                      OR assignment.status <> 'active'
                      OR datetime(assignment.lease_expires_at) <= datetime(?)
                 THEN 1 ELSE 0 END) AS unassigned_awaiting_operator,
        SUM(CASE WHEN assignment.status = 'active'
                      AND datetime(assignment.lease_expires_at) > datetime(?)
                 THEN 1 ELSE 0 END) AS assigned_awaiting_operator
      FROM app_conversations conversation
      LEFT JOIN app_conversation_assignment_state assignment
        ON assignment.conversation_id = conversation.id
      WHERE conversation.status = 'active' AND conversation.queue_status = 'awaiting_operator'
    `).bind(nowIso, nowIso).first<{
      awaiting_operator: number
      unassigned_awaiting_operator: number | null
      assigned_awaiting_operator: number | null
    }>(),
  ])

  const membersByGroup = groupBy(membersResult.results, row => row.group_id)
  const shiftsByGroup = groupBy(shiftsResult.results, row => row.group_id)
  const groups = await Promise.all(groupsResult.results.map(async (row): Promise<AdminConversationGroup> => {
    const memberRows = membersByGroup.get(row.id) ?? []
    const shiftRows = shiftsByGroup.get(row.id) ?? []
    const activeMemberIds = new Set(
      memberRows.filter(member => member.member_status === 'active').map(member => Number(member.admin_id)),
    )
    const activeAssignmentCount = memberRows
      .filter(member => activeMemberIds.has(Number(member.admin_id)))
      .reduce((total, member) => total + Number(member.active_assignment_count), 0)
    const newFirstResponsesToday = await readGroupNewFirstResponseCount(db, row.id, local.serviceDay)
    const onDuty = row.status === 'active' && shiftRows.some(shift => isShiftActive(shift, local.weekday, local.minute))
    const activeMembers = memberRows.filter(member =>
      member.member_status === 'active'
      && member.accepts_new_assignments === 1
      && ['operator', 'lead'].includes(member.member_role),
    )
    const configurationState: AdminConversationGroup['configurationState'] = row.status !== 'active'
      ? 'inactive'
      : activeMembers.length === 0
        ? 'no_member'
        : shiftRows.every(shift => shift.status !== 'active')
          ? 'no_shift'
          : 'ready'
    return {
      groupId: row.id,
      code: row.code,
      name: row.name,
      status: normalizeStatus(row.status),
      timezone: 'Asia/Shanghai',
      maxActiveAssignments: Number(row.max_active_assignments),
      maxNewFirstResponsesPerServiceDay: Number(row.max_new_first_responses_per_service_day),
      activeAssignmentCount,
      newFirstResponsesToday,
      loadPercent: Math.min(999, Math.round(activeAssignmentCount * 100 / Number(row.max_active_assignments))),
      onDuty,
      configurationState,
      version: Number(row.version),
      updatedAt: row.updated_at,
      members: memberRows.map(mapMember),
      shifts: shiftRows.map(mapShift),
    }
  }))
  const rules = rulesResult.results.map(mapRule)
  const activeGroups = groups.filter(group => group.status === 'active')
  const messages: string[] = []
  let diagnosticState: AdminConversationRoutingSnapshot['diagnostics']['state'] = 'normal'
  if (policy?.mode === 'automatic' && rules.every(rule => rule.status !== 'active')) {
    diagnosticState = 'configuration_conflict'
    messages.push('自动分配已启用，但没有生效中的路由规则。')
  }
  const invalidRule = rules.find(rule => rule.status === 'active' && rule.groupStatus !== 'active')
  if (invalidRule) {
    diagnosticState = 'configuration_conflict'
    messages.push(`规则“${invalidRule.name}”仍指向停用运营组。`)
  }
  const incompleteGroup = activeGroups.find(group => group.configurationState !== 'ready')
  if (incompleteGroup) {
    diagnosticState = 'configuration_conflict'
    messages.push(`运营组“${incompleteGroup.name}”缺少可接单成员或有效班次。`)
  }
  const overloaded = activeGroups.find(group =>
    group.activeAssignmentCount >= group.maxActiveAssignments
    || group.newFirstResponsesToday >= group.maxNewFirstResponsesPerServiceDay,
  )
  if (diagnosticState === 'normal' && overloaded) {
    diagnosticState = 'overloaded'
    messages.push(`运营组“${overloaded.name}”已达到当前容量或服务日首次响应上限。`)
  }
  if (diagnosticState === 'normal' && activeGroups.length > 0 && activeGroups.every(group => !group.onDuty)) {
    diagnosticState = 'no_shift'
    messages.push('当前上海时间没有运营组处于值班时段，待处理话题将保持未分配。')
  }
  if (messages.length === 0) messages.push('当前规则、班次与容量未发现阻断性冲突。')

  const manageableGroupIds = actor.role === 'owner'
    ? groups.map(group => group.groupId)
    : groups
        .filter(group => group.members.some(member =>
          member.adminId === actor.adminId
          && member.memberRole === 'lead'
          && member.status === 'active',
        ))
        .map(group => group.groupId)

  return {
    generatedAt: nowIso,
    localTime: local.localTime,
    serviceDay: local.serviceDay,
    permissions: {
      canManageGlobal: actor.role === 'owner',
      manageableGroupIds,
    },
    policy: policy ? mapPolicy(policy) : null,
    queue: {
      awaitingOperator: Number(queue?.awaiting_operator ?? 0),
      unassignedAwaitingOperator: Number(queue?.unassigned_awaiting_operator ?? 0),
      assignedAwaitingOperator: Number(queue?.assigned_awaiting_operator ?? 0),
    },
    diagnostics: { state: diagnosticState, messages },
    operators: operatorsResult.results.map(row => ({
      adminId: Number(row.id),
      displayName: displayName(row),
      accountRole: row.role === 'owner' ? 'owner' : 'admin',
      accountStatus: row.status,
    })),
    groups,
    rules,
  }
}

export type AdminConversationRoutingMutationResult = {
  snapshot: AdminConversationRoutingSnapshot
  replayed: boolean
}

export async function createAdminConversationGroup(
  db: D1Database,
  actor: ConversationRoutingActor,
  idempotencyKeyValue: string | null,
  body: CreateConversationGroupInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  requireOwner(actor)
  const input = normalizeGroupInput(body)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical(input)
  const replay = await findIdempotency(db, actor.adminId, 'group_create', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  const groupId = prefixedId('cgrp')
  const nowIso = now.toISOString()
  const mutationToken = crypto.randomUUID()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_groups (
          id, code, name, status, timezone, max_active_assignments,
          max_new_first_responses_per_service_day, version, mutation_token,
          created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', 'Asia/Shanghai', ?, ?, 1, ?, ?, ?, ?, ?)
      `).bind(
        groupId,
        input.code,
        input.name,
        input.maxActiveAssignments,
        input.maxNewFirstResponsesPerServiceDay,
        mutationToken,
        actor.adminId,
        actor.adminId,
        nowIso,
        nowIso,
      ),
      idempotencyInsert(db, {
        actor,
        operation: 'group_create',
        idempotencyKey,
        requestHash,
        resultType: 'group',
        resultId: groupId,
        resultVersion: 1,
        nowIso,
        condition: `EXISTS (
          SELECT 1 FROM app_conversation_groups
          WHERE id = '${groupId}' AND mutation_token = '${mutationToken}'
        )`,
      }),
      auditInsert(db, actor.adminId, 'app_conversation_group.create', 'app_conversation_group', groupId, null, {
        code: input.code,
        name: input.name,
        status: 'active',
        maxActiveAssignments: input.maxActiveAssignments,
        maxNewFirstResponsesPerServiceDay: input.maxNewFirstResponsesPerServiceDay,
        version: 1,
      }, nowIso, `EXISTS (
        SELECT 1 FROM app_conversation_groups
        WHERE id = '${groupId}' AND mutation_token = '${mutationToken}'
      )`),
    ])
  }
  catch {
    const raced = await findIdempotency(db, actor.adminId, 'group_create', idempotencyKey)
    if (raced) return replaySnapshot(db, actor, raced, requestHash, now)
    const duplicate = await db.prepare('SELECT id FROM app_conversation_groups WHERE code = ?')
      .bind(input.code).first<{ id: string }>()
    if (duplicate) throw new AppMessagingError(409, 'GROUP_CODE_CONFLICT', '运营组编码已存在')
    throw new AppMessagingError(503, 'GROUP_WRITE_FAILED', '运营组暂时无法创建，请稍后重试', true)
  }
  await requireStoredIdempotency(db, actor.adminId, 'group_create', idempotencyKey)
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function updateAdminConversationGroup(
  db: D1Database,
  actor: ConversationRoutingActor,
  groupIdValue: string,
  idempotencyKeyValue: string | null,
  body: UpdateConversationGroupInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  const groupId = normalizeGroupId(groupIdValue)
  await requireGroupManager(db, actor, groupId)
  const existing = await requireGroup(db, groupId)
  const expectedVersion = normalizeExpectedVersion(body.expectedVersion, false)
  const input = {
    ...normalizeGroupInput(body),
    status: normalizeStatusInput(body.status),
    expectedVersion,
  }
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ groupId, ...input })
  const replay = await findIdempotency(db, actor.adminId, 'group_update', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  if (Number(existing.version) !== expectedVersion) throw versionConflict('运营组')
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_conversation_groups
      SET code = ?, name = ?, status = ?, max_active_assignments = ?,
          max_new_first_responses_per_service_day = ?, version = ?,
          mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(
      input.code,
      input.name,
      input.status,
      input.maxActiveAssignments,
      input.maxNewFirstResponsesPerServiceDay,
      nextVersion,
      mutationToken,
      actor.adminId,
      nowIso,
      groupId,
      expectedVersion,
    ),
    idempotencyInsert(db, {
      actor,
      operation: 'group_update',
      idempotencyKey,
      requestHash,
      resultType: 'group',
      resultId: groupId,
      resultVersion: nextVersion,
      nowIso,
      condition: `EXISTS (
        SELECT 1 FROM app_conversation_groups
        WHERE id = '${groupId}' AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
      )`,
    }),
    auditInsert(db, actor.adminId, 'app_conversation_group.update', 'app_conversation_group', groupId, groupAudit(existing), {
      code: input.code,
      name: input.name,
      status: input.status,
      maxActiveAssignments: input.maxActiveAssignments,
      maxNewFirstResponsesPerServiceDay: input.maxNewFirstResponsesPerServiceDay,
      version: nextVersion,
    }, nowIso, `EXISTS (
      SELECT 1 FROM app_conversation_groups
      WHERE id = '${groupId}' AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
    )`),
  ])
  const stored = await findIdempotency(db, actor.adminId, 'group_update', idempotencyKey)
  if (!stored) {
    const latest = await requireGroup(db, groupId)
    if (Number(latest.version) !== expectedVersion) throw versionConflict('运营组')
    throw new AppMessagingError(503, 'GROUP_WRITE_FAILED', '运营组暂时无法保存，请稍后重试', true)
  }
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function upsertAdminConversationGroupMember(
  db: D1Database,
  actor: ConversationRoutingActor,
  groupIdValue: string,
  targetAdminIdValue: string,
  idempotencyKeyValue: string | null,
  body: UpsertConversationGroupMemberInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  const groupId = normalizeGroupId(groupIdValue)
  await requireGroupManager(db, actor, groupId)
  const targetAdminId = normalizeAdminId(targetAdminIdValue)
  await requireActiveAdmin(db, targetAdminId)
  const existing = await findMember(db, groupId, targetAdminId)
  const expectedVersion = normalizeExpectedVersion(body.expectedVersion, existing === null)
  const input = {
    memberRole: normalizeMemberRole(body.memberRole),
    status: normalizeStatusInput(body.status),
    acceptsNewAssignments: normalizeBoolean(body.acceptsNewAssignments, '是否接收新分配'),
    maxActiveAssignments: normalizeInteger(body.maxActiveAssignments, '个人待处理上限', 1, 1000),
    maxNewFirstResponsesPerServiceDay: normalizeInteger(
      body.maxNewFirstResponsesPerServiceDay,
      '个人服务日首次响应上限',
      1,
      1000,
    ),
    expectedVersion,
  }
  if (actor.role !== 'owner' && (input.memberRole === 'lead' || existing?.member_role === 'lead')) {
    throw new AppMessagingError(403, 'OWNER_REQUIRED', '只有站长可以授予或修改运营组长身份')
  }
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ groupId, targetAdminId, ...input })
  const replay = await findIdempotency(db, actor.adminId, 'member_upsert', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  if (existing && Number(existing.version) !== expectedVersion) throw versionConflict('运营组成员')
  const nextVersion = expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const state = existing
    ? db.prepare(`
        UPDATE app_conversation_group_members
        SET member_role = ?, status = ?, accepts_new_assignments = ?,
            max_active_assignments = ?, max_new_first_responses_per_service_day = ?,
            version = ?, mutation_token = ?, updated_by = ?, updated_at = ?
        WHERE group_id = ? AND admin_id = ? AND version = ?
      `).bind(
        input.memberRole,
        input.status,
        input.acceptsNewAssignments ? 1 : 0,
        input.maxActiveAssignments,
        input.maxNewFirstResponsesPerServiceDay,
        nextVersion,
        mutationToken,
        actor.adminId,
        nowIso,
        groupId,
        targetAdminId,
        expectedVersion,
      )
    : db.prepare(`
        INSERT INTO app_conversation_group_members (
          group_id, admin_id, member_role, status, accepts_new_assignments,
          max_active_assignments, max_new_first_responses_per_service_day,
          version, mutation_token, created_by, updated_by, created_at, updated_at
        )
        SELECT ?, admin.id, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
        FROM users admin
        WHERE admin.id = ? AND admin.status = 'active' AND admin.role IN ('admin', 'owner')
          AND EXISTS (SELECT 1 FROM app_conversation_groups WHERE id = ?)
      `).bind(
        groupId,
        input.memberRole,
        input.status,
        input.acceptsNewAssignments ? 1 : 0,
        input.maxActiveAssignments,
        input.maxNewFirstResponsesPerServiceDay,
        mutationToken,
        actor.adminId,
        actor.adminId,
        nowIso,
        nowIso,
        targetAdminId,
        groupId,
      )
  await db.batch([
    state,
    idempotencyInsert(db, {
      actor,
      operation: 'member_upsert',
      idempotencyKey,
      requestHash,
      resultType: 'member',
      resultId: `${groupId}:${targetAdminId}`,
      resultVersion: nextVersion,
      nowIso,
      condition: `EXISTS (
        SELECT 1 FROM app_conversation_group_members
        WHERE group_id = '${groupId}' AND admin_id = ${targetAdminId}
          AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
      )`,
    }),
    auditInsert(db, actor.adminId, 'app_conversation_group.member_upsert', 'app_conversation_group', groupId, existing ? memberAudit(existing) : null, {
      targetAdminId,
      memberRole: input.memberRole,
      status: input.status,
      acceptsNewAssignments: input.acceptsNewAssignments,
      maxActiveAssignments: input.maxActiveAssignments,
      maxNewFirstResponsesPerServiceDay: input.maxNewFirstResponsesPerServiceDay,
      version: nextVersion,
    }, nowIso, `EXISTS (
      SELECT 1 FROM app_conversation_group_members
      WHERE group_id = '${groupId}' AND admin_id = ${targetAdminId}
        AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
    )`),
  ])
  const stored = await findIdempotency(db, actor.adminId, 'member_upsert', idempotencyKey)
  if (!stored) {
    const latest = await findMember(db, groupId, targetAdminId)
    if (latest && Number(latest.version) !== expectedVersion) throw versionConflict('运营组成员')
    throw new AppMessagingError(503, 'GROUP_MEMBER_WRITE_FAILED', '运营组成员暂时无法保存，请稍后重试', true)
  }
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function createAdminConversationGroupShift(
  db: D1Database,
  actor: ConversationRoutingActor,
  groupIdValue: string,
  idempotencyKeyValue: string | null,
  body: CreateConversationGroupShiftInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  const groupId = normalizeGroupId(groupIdValue)
  await requireGroupManager(db, actor, groupId)
  await requireGroup(db, groupId)
  const input = normalizeShiftInput(body)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ groupId, ...input })
  const replay = await findIdempotency(db, actor.adminId, 'shift_create', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  const shiftId = prefixedId('csh')
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      INSERT INTO app_conversation_group_shifts (
        id, group_id, name, weekday, start_minute, end_minute, status,
        version, mutation_token, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)
    `).bind(
      shiftId,
      groupId,
      input.name,
      input.weekday,
      input.startMinute,
      input.endMinute,
      mutationToken,
      actor.adminId,
      actor.adminId,
      nowIso,
      nowIso,
    ),
    idempotencyInsert(db, {
      actor,
      operation: 'shift_create',
      idempotencyKey,
      requestHash,
      resultType: 'shift',
      resultId: shiftId,
      resultVersion: 1,
      nowIso,
      condition: `EXISTS (
        SELECT 1 FROM app_conversation_group_shifts
        WHERE id = '${shiftId}' AND mutation_token = '${mutationToken}'
      )`,
    }),
    auditInsert(db, actor.adminId, 'app_conversation_group.shift_create', 'app_conversation_group_shift', shiftId, null, {
      groupId,
      ...input,
      status: 'active',
      version: 1,
    }, nowIso, `EXISTS (
      SELECT 1 FROM app_conversation_group_shifts
      WHERE id = '${shiftId}' AND mutation_token = '${mutationToken}'
    )`),
  ])
  await requireStoredIdempotency(db, actor.adminId, 'shift_create', idempotencyKey)
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function updateAdminConversationGroupShift(
  db: D1Database,
  actor: ConversationRoutingActor,
  groupIdValue: string,
  shiftIdValue: string,
  idempotencyKeyValue: string | null,
  body: UpdateConversationGroupShiftInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  const groupId = normalizeGroupId(groupIdValue)
  const shiftId = normalizeShiftId(shiftIdValue)
  await requireGroupManager(db, actor, groupId)
  const existing = await requireShift(db, groupId, shiftId)
  const input = {
    ...normalizeShiftInput(body),
    status: normalizeStatusInput(body.status),
    expectedVersion: normalizeExpectedVersion(body.expectedVersion, false),
  }
  if (Number(existing.version) !== input.expectedVersion) throw versionConflict('班次')
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ groupId, shiftId, ...input })
  const replay = await findIdempotency(db, actor.adminId, 'shift_update', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  const nextVersion = input.expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_conversation_group_shifts
      SET name = ?, weekday = ?, start_minute = ?, end_minute = ?, status = ?,
          version = ?, mutation_token = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND group_id = ? AND version = ?
    `).bind(
      input.name,
      input.weekday,
      input.startMinute,
      input.endMinute,
      input.status,
      nextVersion,
      mutationToken,
      actor.adminId,
      nowIso,
      shiftId,
      groupId,
      input.expectedVersion,
    ),
    idempotencyInsert(db, {
      actor,
      operation: 'shift_update',
      idempotencyKey,
      requestHash,
      resultType: 'shift',
      resultId: shiftId,
      resultVersion: nextVersion,
      nowIso,
      condition: `EXISTS (
        SELECT 1 FROM app_conversation_group_shifts
        WHERE id = '${shiftId}' AND group_id = '${groupId}'
          AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
      )`,
    }),
    auditInsert(db, actor.adminId, 'app_conversation_group.shift_update', 'app_conversation_group_shift', shiftId, shiftAudit(existing), {
      groupId,
      name: input.name,
      weekday: input.weekday,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      status: input.status,
      version: nextVersion,
    }, nowIso, `EXISTS (
      SELECT 1 FROM app_conversation_group_shifts
      WHERE id = '${shiftId}' AND group_id = '${groupId}'
        AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
    )`),
  ])
  const stored = await findIdempotency(db, actor.adminId, 'shift_update', idempotencyKey)
  if (!stored) throw versionConflict('班次')
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function upsertAdminConversationRoutingPolicy(
  db: D1Database,
  actor: ConversationRoutingActor,
  idempotencyKeyValue: string | null,
  body: UpsertConversationRoutingPolicyInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  requireOwner(actor)
  const existing = await db.prepare(`
    SELECT mode, strategy, unassigned_behavior, timezone,
           max_dispatch_batch, version, updated_at
    FROM app_conversation_assignment_policies WHERE scope = 'global'
  `).first<PolicyRow>()
  const input = {
    mode: normalizePolicyMode(body.mode),
    maxDispatchBatch: normalizeInteger(body.maxDispatchBatch, '单次分配上限', 1, 200),
    expectedVersion: normalizeExpectedVersion(body.expectedVersion, existing === null),
  }
  if (existing && Number(existing.version) !== input.expectedVersion) throw versionConflict('分配策略')
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical(input)
  const replay = await findIdempotency(db, actor.adminId, 'policy_upsert', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  const nextVersion = input.expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const state = existing
    ? db.prepare(`
        UPDATE app_conversation_assignment_policies
        SET mode = ?, max_dispatch_batch = ?, version = ?, mutation_token = ?,
            updated_by = ?, updated_at = ?
        WHERE scope = 'global' AND version = ?
      `).bind(
        input.mode,
        input.maxDispatchBatch,
        nextVersion,
        mutationToken,
        actor.adminId,
        nowIso,
        input.expectedVersion,
      )
    : db.prepare(`
        INSERT INTO app_conversation_assignment_policies (
          scope, mode, strategy, unassigned_behavior, timezone,
          max_dispatch_batch, version, mutation_token, updated_by, created_at, updated_at
        ) VALUES (
          'global', ?, 'least_loaded_oldest', 'keep_unassigned', 'Asia/Shanghai',
          ?, 1, ?, ?, ?, ?
        )
      `).bind(input.mode, input.maxDispatchBatch, mutationToken, actor.adminId, nowIso, nowIso)
  await db.batch([
    state,
    idempotencyInsert(db, {
      actor,
      operation: 'policy_upsert',
      idempotencyKey,
      requestHash,
      resultType: 'policy',
      resultId: 'global',
      resultVersion: nextVersion,
      nowIso,
      condition: `EXISTS (
        SELECT 1 FROM app_conversation_assignment_policies
        WHERE scope = 'global' AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
      )`,
    }),
    auditInsert(db, actor.adminId, 'app_conversation_routing.policy_upsert', 'app_conversation_assignment_policy', 'global', existing ? policyAudit(existing) : null, {
      mode: input.mode,
      strategy: 'least_loaded_oldest',
      unassignedBehavior: 'keep_unassigned',
      timezone: 'Asia/Shanghai',
      maxDispatchBatch: input.maxDispatchBatch,
      version: nextVersion,
    }, nowIso, `EXISTS (
      SELECT 1 FROM app_conversation_assignment_policies
      WHERE scope = 'global' AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
    )`),
  ])
  const stored = await findIdempotency(db, actor.adminId, 'policy_upsert', idempotencyKey)
  if (!stored) throw versionConflict('分配策略')
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function createAdminConversationRoutingRule(
  db: D1Database,
  actor: ConversationRoutingActor,
  idempotencyKeyValue: string | null,
  body: CreateConversationRoutingRuleInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  requireOwner(actor)
  const input = normalizeRuleInput(body)
  await requireGroup(db, input.groupId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical(input)
  const replay = await findIdempotency(db, actor.adminId, 'rule_create', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  const ruleId = prefixedId('crr')
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_routing_rules (
          id, name, match_type, match_value, group_id, priority, status,
          version, mutation_token, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)
      `).bind(
        ruleId,
        input.name,
        input.matchType,
        input.matchValue,
        input.groupId,
        input.priority,
        mutationToken,
        actor.adminId,
        actor.adminId,
        nowIso,
        nowIso,
      ),
      idempotencyInsert(db, {
        actor,
        operation: 'rule_create',
        idempotencyKey,
        requestHash,
        resultType: 'rule',
        resultId: ruleId,
        resultVersion: 1,
        nowIso,
        condition: `EXISTS (
          SELECT 1 FROM app_conversation_routing_rules
          WHERE id = '${ruleId}' AND mutation_token = '${mutationToken}'
        )`,
      }),
      auditInsert(db, actor.adminId, 'app_conversation_routing.rule_create', 'app_conversation_routing_rule', ruleId, null, {
        ...input,
        status: 'active',
        version: 1,
      }, nowIso, `EXISTS (
        SELECT 1 FROM app_conversation_routing_rules
        WHERE id = '${ruleId}' AND mutation_token = '${mutationToken}'
      )`),
    ])
  }
  catch {
    const raced = await findIdempotency(db, actor.adminId, 'rule_create', idempotencyKey)
    if (raced) return replaySnapshot(db, actor, raced, requestHash, now)
    const conflict = await findActiveRule(db, input.matchType, input.matchValue)
    if (conflict) throw new AppMessagingError(409, 'ROUTING_RULE_CONFLICT', '该匹配条件已有生效中的路由规则')
    throw new AppMessagingError(503, 'ROUTING_RULE_WRITE_FAILED', '分配规则暂时无法创建，请稍后重试', true)
  }
  await requireStoredIdempotency(db, actor.adminId, 'rule_create', idempotencyKey)
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function updateAdminConversationRoutingRule(
  db: D1Database,
  actor: ConversationRoutingActor,
  ruleIdValue: string,
  idempotencyKeyValue: string | null,
  body: UpdateConversationRoutingRuleInput,
  now = new Date(),
): Promise<AdminConversationRoutingMutationResult> {
  requireOwner(actor)
  const ruleId = normalizeRuleId(ruleIdValue)
  const existing = await requireRule(db, ruleId)
  const input = {
    ...normalizeRuleInput(body),
    status: normalizeStatusInput(body.status),
    expectedVersion: normalizeExpectedVersion(body.expectedVersion, false),
  }
  if (Number(existing.version) !== input.expectedVersion) throw versionConflict('分配规则')
  await requireGroup(db, input.groupId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ ruleId, ...input })
  const replay = await findIdempotency(db, actor.adminId, 'rule_update', idempotencyKey)
  if (replay) return replaySnapshot(db, actor, replay, requestHash, now)
  const nextVersion = input.expectedVersion + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_routing_rules
        SET name = ?, match_type = ?, match_value = ?, group_id = ?, priority = ?,
            status = ?, version = ?, mutation_token = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).bind(
        input.name,
        input.matchType,
        input.matchValue,
        input.groupId,
        input.priority,
        input.status,
        nextVersion,
        mutationToken,
        actor.adminId,
        nowIso,
        ruleId,
        input.expectedVersion,
      ),
      idempotencyInsert(db, {
        actor,
        operation: 'rule_update',
        idempotencyKey,
        requestHash,
        resultType: 'rule',
        resultId: ruleId,
        resultVersion: nextVersion,
        nowIso,
        condition: `EXISTS (
          SELECT 1 FROM app_conversation_routing_rules
          WHERE id = '${ruleId}' AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
        )`,
      }),
      auditInsert(db, actor.adminId, 'app_conversation_routing.rule_update', 'app_conversation_routing_rule', ruleId, ruleAudit(existing), {
        name: input.name,
        matchType: input.matchType,
        matchValue: input.matchValue,
        groupId: input.groupId,
        priority: input.priority,
        status: input.status,
        version: nextVersion,
      }, nowIso, `EXISTS (
        SELECT 1 FROM app_conversation_routing_rules
        WHERE id = '${ruleId}' AND version = ${nextVersion} AND mutation_token = '${mutationToken}'
      )`),
    ])
  }
  catch {
    const raced = await findIdempotency(db, actor.adminId, 'rule_update', idempotencyKey)
    if (raced) return replaySnapshot(db, actor, raced, requestHash, now)
    const conflict = await findActiveRule(db, input.matchType, input.matchValue)
    if (conflict && conflict.id !== ruleId) {
      throw new AppMessagingError(409, 'ROUTING_RULE_CONFLICT', '该匹配条件已有生效中的路由规则')
    }
    throw new AppMessagingError(503, 'ROUTING_RULE_WRITE_FAILED', '分配规则暂时无法保存，请稍后重试', true)
  }
  await requireStoredIdempotency(db, actor.adminId, 'rule_update', idempotencyKey)
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: false }
}

export async function dispatchAdminConversationQueue(
  db: D1Database,
  actor: ConversationRoutingActor,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<AdminConversationDispatchResult> {
  requireOwner(actor)
  const policy = await db.prepare(`
    SELECT mode, strategy, unassigned_behavior, timezone,
           max_dispatch_batch, version, updated_at
    FROM app_conversation_assignment_policies WHERE scope = 'global'
  `).first<PolicyRow>()
  if (!policy || policy.mode !== 'automatic') {
    throw new AppMessagingError(409, 'AUTO_ASSIGNMENT_DISABLED', '请先保存并启用自动分配策略')
  }
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ scope: 'global', policyVersion: Number(policy.version) })
  const replay = await findIdempotency(db, actor.adminId, 'dispatch_run', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    if (!replay.result_json) throw new AppMessagingError(409, 'IDEMPOTENCY_RESULT_INVALID', '原分配结果不可恢复')
    const result = JSON.parse(replay.result_json) as Omit<AdminConversationDispatchResult, 'replayed'>
    return { ...result, replayed: true }
  }
  const rows = await db.prepare(`
    SELECT conversation.id
    FROM app_conversations conversation
    LEFT JOIN app_conversation_assignment_state assignment
      ON assignment.conversation_id = conversation.id
    WHERE conversation.status = 'active'
      AND conversation.queue_status = 'awaiting_operator'
      AND (
        assignment.conversation_id IS NULL
        OR assignment.status <> 'active'
        OR datetime(assignment.lease_expires_at) <= datetime(?)
      )
    ORDER BY conversation.updated_at ASC, conversation.id ASC
    LIMIT ?
  `).bind(now.toISOString(), Number(policy.max_dispatch_batch)).all<{ id: string }>()
  const outcomes: ConversationAutoAssignmentOutcome[] = []
  for (const row of rows.results) {
    outcomes.push(await autoAssignConversationIfEligible(db, row.id, 'manual_dispatch', now))
  }
  const dispatchId = prefixedId('cdr')
  const result: Omit<AdminConversationDispatchResult, 'replayed'> = {
    dispatchId,
    requested: rows.results.length,
    assigned: outcomes.filter(item => item.status === 'assigned').length,
    alreadyAssigned: outcomes.filter(item => item.status === 'already_assigned').length,
    skipped: outcomes.filter(item => !['assigned', 'already_assigned'].includes(item.status)).length,
    outcomes,
  }
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      INSERT INTO app_conversation_routing_idempotency (
        admin_id, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, result_json, created_at
      ) VALUES (?, 'dispatch_run', ?, ?, 'dispatch', ?, ?, ?, ?)
    `).bind(
      actor.adminId,
      idempotencyKey,
      requestHash,
      dispatchId,
      Number(policy.version),
      JSON.stringify(result),
      nowIso,
    ),
    auditInsert(db, actor.adminId, 'app_conversation_routing.dispatch_run', 'app_conversation_assignment_policy', 'global', null, {
      dispatchId,
      policyVersion: Number(policy.version),
      requested: result.requested,
      assigned: result.assigned,
      alreadyAssigned: result.alreadyAssigned,
      skipped: result.skipped,
    }, nowIso),
  ])
  return { ...result, replayed: false }
}

function mapPolicy(row: PolicyRow): AdminConversationRoutingPolicy {
  return {
    mode: normalizePolicyMode(row.mode),
    strategy: 'least_loaded_oldest',
    unassignedBehavior: 'keep_unassigned',
    timezone: 'Asia/Shanghai',
    maxDispatchBatch: Number(row.max_dispatch_batch),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}

function mapMember(row: MemberRow): AdminConversationGroupMember {
  return {
    adminId: Number(row.admin_id),
    displayName: displayName({
      id: row.admin_id,
      nickname: row.nickname,
      username: row.username,
    }),
    accountRole: row.account_role === 'owner' ? 'owner' : 'admin',
    memberRole: normalizeMemberRole(row.member_role),
    status: normalizeStatus(row.member_status),
    acceptsNewAssignments: row.accepts_new_assignments === 1,
    maxActiveAssignments: Number(row.max_active_assignments),
    maxNewFirstResponsesPerServiceDay: Number(row.max_new_first_responses_per_service_day),
    activeAssignmentCount: Math.max(0, Number(row.active_assignment_count)),
    newFirstResponsesToday: Math.max(0, Number(row.new_first_response_count)),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}

function mapShift(row: ShiftRow): AdminConversationGroupShift {
  return {
    shiftId: row.id,
    name: row.name,
    weekday: Number(row.weekday),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute),
    overnight: Number(row.start_minute) > Number(row.end_minute),
    status: normalizeStatus(row.status),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}

function mapRule(row: RuleRow): AdminConversationRoutingRule {
  return {
    ruleId: row.id,
    name: row.name,
    matchType: normalizeMatchType(row.match_type),
    matchValue: row.match_value,
    groupId: row.group_id,
    groupName: row.group_name,
    groupStatus: normalizeStatus(row.group_status),
    priority: Number(row.priority),
    status: normalizeStatus(row.status),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}

function normalizeGroupInput(body: CreateConversationGroupInput) {
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!GROUP_CODE_PATTERN.test(code)) {
    throw new AppMessagingError(400, 'INVALID_GROUP_CODE', '运营组编码需为 2–40 位小写字母、数字或连字符')
  }
  return {
    code,
    name: normalizeText(body.name, '运营组名称', 80),
    maxActiveAssignments: normalizeInteger(body.maxActiveAssignments, '运营组待处理上限', 1, 10000),
    maxNewFirstResponsesPerServiceDay: normalizeInteger(
      body.maxNewFirstResponsesPerServiceDay,
      '运营组服务日首次响应上限',
      1,
      10000,
    ),
  }
}

function normalizeShiftInput(body: CreateConversationGroupShiftInput) {
  const startMinute = normalizeInteger(body.startMinute, '班次开始分钟', 0, 1439)
  const endMinute = normalizeInteger(body.endMinute, '班次结束分钟', 0, 1439)
  if (startMinute === endMinute) {
    throw new AppMessagingError(400, 'INVALID_SHIFT_RANGE', '班次开始与结束时间不能相同')
  }
  return {
    name: normalizeText(body.name, '班次名称', 80),
    weekday: normalizeInteger(body.weekday, '星期', 1, 7),
    startMinute,
    endMinute,
  }
}

function normalizeRuleInput(body: CreateConversationRoutingRuleInput) {
  const matchType = normalizeMatchType(body.matchType)
  const rawMatchValue = typeof body.matchValue === 'string' ? body.matchValue.trim() : ''
  let matchValue = rawMatchValue
  if (matchType === 'default') {
    if (rawMatchValue !== '*') throw new AppMessagingError(400, 'INVALID_RULE_MATCH', '默认规则匹配值必须为 *')
  }
  else if (matchType === 'profile') {
    if (!PROFILE_ID_PATTERN.test(rawMatchValue)) {
      throw new AppMessagingError(400, 'INVALID_RULE_MATCH', '真人规则必须填写有效 profileId')
    }
  }
  else {
    matchValue = rawMatchValue.toLowerCase()
    if (!REGION_CODE_PATTERN.test(matchValue)) {
      throw new AppMessagingError(400, 'INVALID_RULE_MATCH', '地区规则必须填写稳定的小写地区编码')
    }
  }
  return {
    name: normalizeText(body.name, '规则名称', 80),
    matchType,
    matchValue,
    groupId: normalizeGroupId(body.groupId),
    priority: normalizeInteger(body.priority, '规则优先级', 0, 10000),
  }
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AppMessagingError(400, 'INVALID_INPUT', `${label}不能为空`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new AppMessagingError(400, 'INVALID_INPUT', `${label}长度必须为 1–${maxLength} 个字符`)
  }
  return normalized
}

function normalizeInteger(value: unknown, label: string, min: number, max: number): number {
  const normalized = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new AppMessagingError(400, 'INVALID_INPUT', `${label}必须为 ${min}–${max} 的整数`)
  }
  return normalized
}

function normalizeExpectedVersion(value: unknown, creating: boolean): number {
  const version = normalizeInteger(value, 'expectedVersion', creating ? 0 : 1, 1_000_000_000)
  if (creating && version !== 0) {
    throw new AppMessagingError(409, 'VERSION_CONFLICT', '首次创建时 expectedVersion 必须为 0')
  }
  return version
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new AppMessagingError(400, 'INVALID_INPUT', `${label}必须为布尔值`)
  return value
}

function normalizeStatusInput(value: unknown): ConversationGroupStatus {
  if (value !== 'active' && value !== 'inactive') {
    throw new AppMessagingError(400, 'INVALID_STATUS', '状态必须为 active 或 inactive')
  }
  return value
}

function normalizeStatus(value: string): ConversationGroupStatus {
  return value === 'active' ? 'active' : 'inactive'
}

function normalizeMemberRole(value: unknown): ConversationGroupMemberRole {
  if (value === 'operator' || value === 'lead' || value === 'quality') return value
  throw new AppMessagingError(400, 'INVALID_MEMBER_ROLE', '成员角色不受支持')
}

function normalizePolicyMode(value: unknown): ConversationRoutingMode {
  if (value === 'manual' || value === 'automatic') return value
  throw new AppMessagingError(400, 'INVALID_ROUTING_MODE', '分配模式不受支持')
}

function normalizeMatchType(value: unknown): ConversationRoutingMatchType {
  if (value === 'default' || value === 'profile' || value === 'region') return value
  throw new AppMessagingError(400, 'INVALID_RULE_MATCH', '规则匹配类型不受支持')
}

function normalizeGroupId(value: unknown): string {
  if (typeof value !== 'string' || !/^cgrp_[A-Za-z0-9_-]{1,75}$/u.test(value.trim())) {
    throw new AppMessagingError(400, 'INVALID_GROUP_ID', '运营组 ID 格式无效')
  }
  return value.trim()
}

function normalizeShiftId(value: unknown): string {
  if (typeof value !== 'string' || !/^csh_[A-Za-z0-9_-]{1,76}$/u.test(value.trim())) {
    throw new AppMessagingError(400, 'INVALID_SHIFT_ID', '班次 ID 格式无效')
  }
  return value.trim()
}

function normalizeRuleId(value: unknown): string {
  if (typeof value !== 'string' || !/^crr_[A-Za-z0-9_-]{1,76}$/u.test(value.trim())) {
    throw new AppMessagingError(400, 'INVALID_RULE_ID', '规则 ID 格式无效')
  }
  return value.trim()
}

function normalizeAdminId(value: unknown): number {
  return normalizeInteger(value, '管理员 ID', 1, Number.MAX_SAFE_INTEGER)
}

function requireOwner(actor: ConversationRoutingActor) {
  if (actor.role !== 'owner') {
    throw new AppMessagingError(403, 'OWNER_REQUIRED', '该全局分配操作仅允许站长执行')
  }
}

async function requireGroupManager(
  db: D1Database,
  actor: ConversationRoutingActor,
  groupId: string,
): Promise<void> {
  if (actor.role === 'owner') return
  const lead = await db.prepare(`
    SELECT 1 AS allowed
    FROM app_conversation_group_members
    WHERE group_id = ? AND admin_id = ?
      AND member_role = 'lead' AND status = 'active'
  `).bind(groupId, actor.adminId).first<{ allowed: number }>()
  if (!lead) throw new AppMessagingError(403, 'GROUP_LEAD_REQUIRED', '只有该运营组组长或站长可以修改')
}

async function requireGroup(db: D1Database, groupId: string): Promise<GroupRow> {
  const row = await db.prepare(`
    SELECT id, code, name, status, timezone, max_active_assignments,
           max_new_first_responses_per_service_day, version, updated_at
    FROM app_conversation_groups WHERE id = ?
  `).bind(groupId).first<GroupRow>()
  if (!row) throw new AppMessagingError(404, 'GROUP_NOT_FOUND', '运营组不存在')
  return row
}

type StoredMemberRow = {
  group_id: string
  admin_id: number
  member_role: string
  status: string
  accepts_new_assignments: number
  max_active_assignments: number
  max_new_first_responses_per_service_day: number
  version: number
}

async function findMember(db: D1Database, groupId: string, adminId: number): Promise<StoredMemberRow | null> {
  return await db.prepare(`
    SELECT group_id, admin_id, member_role, status, accepts_new_assignments,
           max_active_assignments, max_new_first_responses_per_service_day, version
    FROM app_conversation_group_members
    WHERE group_id = ? AND admin_id = ?
  `).bind(groupId, adminId).first<StoredMemberRow>()
}

async function requireActiveAdmin(db: D1Database, adminId: number): Promise<void> {
  const row = await db.prepare(`
    SELECT id FROM users
    WHERE id = ? AND status = 'active' AND role IN ('admin', 'owner')
  `).bind(adminId).first<{ id: number }>()
  if (!row) throw new AppMessagingError(400, 'OPERATOR_NOT_ELIGIBLE', '目标账号不是有效管理员')
}

async function requireShift(db: D1Database, groupId: string, shiftId: string): Promise<ShiftRow> {
  const row = await db.prepare(`
    SELECT id, group_id, name, weekday, start_minute, end_minute,
           status, version, updated_at
    FROM app_conversation_group_shifts WHERE id = ? AND group_id = ?
  `).bind(shiftId, groupId).first<ShiftRow>()
  if (!row) throw new AppMessagingError(404, 'SHIFT_NOT_FOUND', '班次不存在')
  return row
}

type StoredRuleRow = {
  id: string
  name: string
  match_type: string
  match_value: string
  group_id: string
  priority: number
  status: string
  version: number
}

async function requireRule(db: D1Database, ruleId: string): Promise<StoredRuleRow> {
  const row = await db.prepare(`
    SELECT id, name, match_type, match_value, group_id, priority, status, version
    FROM app_conversation_routing_rules WHERE id = ?
  `).bind(ruleId).first<StoredRuleRow>()
  if (!row) throw new AppMessagingError(404, 'ROUTING_RULE_NOT_FOUND', '分配规则不存在')
  return row
}

async function findActiveRule(
  db: D1Database,
  matchType: ConversationRoutingMatchType,
  matchValue: string,
): Promise<{ id: string } | null> {
  return await db.prepare(`
    SELECT id FROM app_conversation_routing_rules
    WHERE match_type = ? AND match_value = ? AND status = 'active'
  `).bind(matchType, matchValue).first<{ id: string }>()
}

async function readGroupNewFirstResponseCount(
  db: D1Database,
  groupId: string,
  serviceDay: string,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversation_routing_assignment_events
    WHERE group_id = ? AND service_day = ? AND is_new_first_response = 1
  `).bind(groupId, serviceDay).first<{ count: number }>()
  return Math.max(0, Number(row?.count ?? 0))
}

function isShiftActive(row: ShiftRow, weekday: number, minute: number): boolean {
  if (row.status !== 'active') return false
  const previousWeekday = weekday === 1 ? 7 : weekday - 1
  const start = Number(row.start_minute)
  const end = Number(row.end_minute)
  if (start < end) return Number(row.weekday) === weekday && start <= minute && end > minute
  return (Number(row.weekday) === weekday && start <= minute)
    || (Number(row.weekday) === previousWeekday && end > minute)
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>()
  for (const item of items) {
    const groupKey = key(item)
    const list = result.get(groupKey) ?? []
    list.push(item)
    result.set(groupKey, list)
  }
  return result
}

function displayName(row: { id: number; nickname?: string | null; username?: string | null }): string {
  return row.nickname?.trim() || row.username?.trim() || `管理员 #${row.id}`
}

type RoutingOperation =
  | 'group_create'
  | 'group_update'
  | 'member_upsert'
  | 'shift_create'
  | 'shift_update'
  | 'policy_upsert'
  | 'rule_create'
  | 'rule_update'
  | 'dispatch_run'

async function findIdempotency(
  db: D1Database,
  adminId: number,
  operation: RoutingOperation,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  return await db.prepare(`
    SELECT request_hash, result_id, result_version, result_json
    FROM app_conversation_routing_idempotency
    WHERE admin_id = ? AND operation = ? AND idempotency_key = ?
  `).bind(adminId, operation, idempotencyKey).first<IdempotencyRow>()
}

function assertIdempotencyHash(row: IdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppMessagingError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于不同的分配请求')
  }
}

async function replaySnapshot(
  db: D1Database,
  actor: ConversationRoutingActor,
  row: IdempotencyRow,
  requestHash: string,
  now: Date,
): Promise<AdminConversationRoutingMutationResult> {
  assertIdempotencyHash(row, requestHash)
  return { snapshot: await getAdminConversationRoutingSnapshot(db, actor, now), replayed: true }
}

function idempotencyInsert(db: D1Database, input: {
  actor: ConversationRoutingActor
  operation: RoutingOperation
  idempotencyKey: string
  requestHash: string
  resultType: 'group' | 'member' | 'shift' | 'policy' | 'rule'
  resultId: string
  resultVersion: number
  nowIso: string
  condition: string
}): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO app_conversation_routing_idempotency (
      admin_id, operation, idempotency_key, request_hash,
      result_type, result_id, result_version, result_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?
    WHERE ${input.condition}
  `).bind(
    input.actor.adminId,
    input.operation,
    input.idempotencyKey,
    input.requestHash,
    input.resultType,
    input.resultId,
    input.resultVersion,
    input.nowIso,
  )
}

function auditInsert(
  db: D1Database,
  adminId: number,
  action: string,
  targetType: string,
  targetId: string,
  beforeValue: unknown,
  afterValue: unknown,
  nowIso: string,
  condition = '1 = 1',
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id,
      before_value, after_value, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${condition}
  `).bind(
    `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
    adminId,
    action,
    targetType,
    targetId,
    beforeValue === null ? null : JSON.stringify(beforeValue),
    JSON.stringify(afterValue),
    nowIso,
  )
}

async function requireStoredIdempotency(
  db: D1Database,
  adminId: number,
  operation: RoutingOperation,
  idempotencyKey: string,
): Promise<void> {
  if (!await findIdempotency(db, adminId, operation, idempotencyKey)) {
    throw new AppMessagingError(503, 'ROUTING_WRITE_FAILED', '分配配置暂时无法保存，请刷新后重试', true)
  }
}

function groupAudit(row: GroupRow) {
  return {
    code: row.code,
    name: row.name,
    status: row.status,
    maxActiveAssignments: Number(row.max_active_assignments),
    maxNewFirstResponsesPerServiceDay: Number(row.max_new_first_responses_per_service_day),
    version: Number(row.version),
  }
}

function memberAudit(row: StoredMemberRow) {
  return {
    targetAdminId: Number(row.admin_id),
    memberRole: row.member_role,
    status: row.status,
    acceptsNewAssignments: row.accepts_new_assignments === 1,
    maxActiveAssignments: Number(row.max_active_assignments),
    maxNewFirstResponsesPerServiceDay: Number(row.max_new_first_responses_per_service_day),
    version: Number(row.version),
  }
}

function shiftAudit(row: ShiftRow) {
  return {
    groupId: row.group_id,
    name: row.name,
    weekday: Number(row.weekday),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute),
    status: row.status,
    version: Number(row.version),
  }
}

function policyAudit(row: PolicyRow) {
  return {
    mode: row.mode,
    strategy: row.strategy,
    unassignedBehavior: row.unassigned_behavior,
    timezone: row.timezone,
    maxDispatchBatch: Number(row.max_dispatch_batch),
    version: Number(row.version),
  }
}

function ruleAudit(row: StoredRuleRow) {
  return {
    name: row.name,
    matchType: row.match_type,
    matchValue: row.match_value,
    groupId: row.group_id,
    priority: Number(row.priority),
    status: row.status,
    version: Number(row.version),
  }
}

function versionConflict(label: string) {
  return new AppMessagingError(409, 'VERSION_CONFLICT', `${label}已被其他管理员更新，请刷新后重试`)
}

function prefixedId(prefix: 'cgrp' | 'csh' | 'crr' | 'cdr') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}
