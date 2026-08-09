import type { AppConversationMessage, AppConversationQueueStatus, AppConversationStatus } from '@meigallery/shared'
import {
  AppMessagingError,
  assertMessagingIdempotencyHash,
  findConversationForAdmin,
  findMessageByClientId,
  findMessageById,
  findMessagingIdempotency,
  hashCanonical,
  mapAppConversationMessage,
  normalizeClientMessageId,
  normalizeConversationId,
  normalizeIdempotencyKey,
  normalizeMessageText,
  prefixedId,
  sha256Hex,
  type AppConversationInternalRow,
} from './app-messaging'
import { getAppMessagingRuntimeControl } from './app-safety'
import {
  resolveConversationRoutingClaimAccesses,
  shanghaiClock,
  type ConversationRoutingClaimAccess,
} from './app-conversation-auto-assignment'

const MAX_ADMIN_LIST_SIZE = 100
const DEFAULT_ADMIN_LIST_SIZE = 40
const MAX_ADMIN_MESSAGE_PAGE_SIZE = 100
const DEFAULT_ADMIN_MESSAGE_PAGE_SIZE = 100
const OPERATOR_MESSAGES_PER_MINUTE = 60
const ACCESS_REASON = 'service_operation'
const PROHIBITED_OPERATOR_PHRASES = [
  '我是本人',
  '我就是本人',
  '本人已读',
  '她已读',
  '他已读',
  '正在等你',
  '保证回复',
  '保证见面',
  '一定见面',
  '关系结果',
] as const

export interface AdminAppConversationListQuery {
  queueStatus: AppConversationQueueStatus | null
  limit: number
}

export interface AdminAppConversationMessageQuery {
  afterSequence: number
  limit: number
}

export interface AdminAppConversationSummary {
  conversationId: string
  status: AppConversationStatus
  queueStatus: AppConversationQueueStatus
  account: {
    accountId: string
    nickname: string | null
  }
  profile: {
    profileId: string
    displayName: string
  }
  operationMode: 'platform_managed'
  receiverLabel: string
  assignment: {
    status: 'unassigned' | 'mine' | 'other'
    version: number
    leaseExpiresAt: string | null
    canClaim: boolean
  }
  routing: {
    groupId: string | null
    groupName: string | null
    claimAccess: ConversationRoutingClaimAccess['status']
  }
  unreadViewerCount: number
  lastSequence: number
  lastMessageAt: string
  createdAt: string
  updatedAt: string
}

export interface AdminAppConversationDetail extends AdminAppConversationSummary {
  disclosureVersion: string
  accessReason: typeof ACCESS_REASON
  operatorReadSequence: number
  viewerReadSequence: number
}

export interface AdminSendAppMessageInput {
  clientMessageId?: unknown
  contentType?: unknown
  text?: unknown
}

export interface AdminConversationAssignment {
  status: 'mine' | 'unassigned'
  version: number
  leaseExpiresAt: string | null
}

type SafetyIdempotencyRow = {
  request_hash: string
  result_id: string
  result_version: number
}

type AdminConversationRow = {
  id: string
  account_id: number
  account_public_id: string
  nickname: string | null
  profile_id: string
  region_code: string | null
  display_name: string
  operation_mode: string
  receiver_label: string
  disclosure_version: string
  status: string
  queue_status: string
  last_sequence: number
  viewer_read_sequence: number
  operator_read_sequence: number
  last_message_at: string
  created_at: string
  updated_at: string
  unread_count: number
  assigned_admin_id: number | null
  assignment_status: string | null
  assignment_version: number | null
  lease_expires_at: string | null
}

export type ConversationAssignmentRow = {
  assigned_admin_id: number | null
  status: string
  version: number
  lease_expires_at: string | null
  assigned_at: string | null
}

export function parseAdminAppConversationListQuery(input: {
  queueStatus?: string
  limit?: string
}): AdminAppConversationListQuery {
  const queueStatus = normalizeQueueStatus(input.queueStatus)
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    queueStatus,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_ADMIN_LIST_SIZE)
      : DEFAULT_ADMIN_LIST_SIZE,
  }
}

export function parseAdminAppConversationMessageQuery(input: {
  afterSequence?: string
  limit?: string
}): AdminAppConversationMessageQuery {
  const rawAfter = input.afterSequence?.trim() || '0'
  const afterSequence = Number(rawAfter)
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new AppMessagingError(400, 'INVALID_SEQUENCE', 'afterSequence 必须为非负整数')
  }
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    afterSequence,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_ADMIN_MESSAGE_PAGE_SIZE)
      : DEFAULT_ADMIN_MESSAGE_PAGE_SIZE,
  }
}

export async function listAdminAppConversations(
  db: D1Database,
  adminId: number,
  query: AdminAppConversationListQuery,
  now = new Date(),
): Promise<AdminAppConversationSummary[]> {
  const condition = query.queueStatus ? 'AND conversation.queue_status = ?' : ''
  const params: unknown[] = query.queueStatus ? [query.queueStatus] : []
  const result = await db.prepare(`
    SELECT conversation.id, conversation.account_id, security.account_public_id,
           account.nickname, conversation.profile_id, profile.display_name, profile.region_code,
           conversation.operation_mode, conversation.receiver_label,
           conversation.disclosure_version, conversation.status,
           conversation.queue_status, conversation.last_sequence,
           conversation.viewer_read_sequence, conversation.operator_read_sequence,
           conversation.last_message_at, conversation.created_at,
           conversation.updated_at,
           assignment.assigned_admin_id,
           assignment.status AS assignment_status,
           assignment.version AS assignment_version,
           assignment.lease_expires_at,
           (
             SELECT COUNT(*) FROM app_conversation_messages message
             WHERE message.conversation_id = conversation.id
               AND message.sender_type = 'viewer'
               AND message.sequence > conversation.operator_read_sequence
           ) AS unread_count
    FROM app_conversations conversation
    JOIN users account ON account.id = conversation.account_id
    JOIN app_account_security security ON security.account_id = conversation.account_id
    JOIN person_profiles profile ON profile.id = conversation.profile_id
    LEFT JOIN app_conversation_assignment_state assignment
      ON assignment.conversation_id = conversation.id
    WHERE 1 = 1 ${condition}
    ORDER BY
      CASE conversation.queue_status WHEN 'awaiting_operator' THEN 0 WHEN 'awaiting_viewer' THEN 1 ELSE 2 END,
      conversation.updated_at ASC,
      conversation.id ASC
    LIMIT ?
  `).bind(...params, query.limit).all<AdminConversationRow>()
  const routingAccesses = await resolveConversationRoutingClaimAccesses(
    db,
    adminId,
    result.results.map(row => ({
      conversationId: row.id,
      profileId: row.profile_id,
      regionCode: row.region_code,
    })),
    now,
  )
  return result.results.map(row => mapAdminConversationSummary(
    row,
    adminId,
    now,
    routingAccesses.get(row.id),
  ))
}

export async function getAdminAppConversation(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  now = new Date(),
): Promise<AdminAppConversationDetail> {
  await requireAdminConversationAssignment(db, adminId, conversationIdValue, now)
  const row = await getAdminConversationRow(db, conversationIdValue)
  const routingAccesses = await resolveConversationRoutingClaimAccesses(db, adminId, [{
    conversationId: row.id,
    profileId: row.profile_id,
    regionCode: row.region_code,
  }], now)
  return {
    ...mapAdminConversationSummary(row, adminId, now, routingAccesses.get(row.id)),
    disclosureVersion: row.disclosure_version,
    accessReason: ACCESS_REASON,
    operatorReadSequence: Number(row.operator_read_sequence),
    viewerReadSequence: Number(row.viewer_read_sequence),
  }
}

export async function listAdminAppConversationMessages(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  query: AdminAppConversationMessageQuery,
  now = new Date(),
): Promise<{ items: AppConversationMessage[]; nextAfterSequence: number | null; hasMore: boolean }> {
  await requireAdminConversationAssignment(db, adminId, conversationIdValue, now)
  const conversationId = normalizeConversationId(conversationIdValue)
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  const result = await db.prepare(`
    SELECT id, conversation_id, sequence, sender_type, client_message_id,
           content_type, body_text, body_sha256, status,
           actor_account_id, actor_admin_id, created_at
    FROM app_conversation_messages
    WHERE conversation_id = ? AND sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `).bind(conversationId, query.afterSequence, query.limit + 1).all<Parameters<typeof mapAppConversationMessage>[0]>()
  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  return {
    items: rows.map(row => mapAppConversationMessage(row, conversation)),
    nextAfterSequence: hasMore ? rows.at(-1)?.sequence ?? null : null,
    hasMore,
  }
}

export async function auditAdminAppConversationAccess(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  requestId: string,
  now = new Date(),
): Promise<void> {
  await requireAdminConversationAssignment(db, adminId, conversationIdValue, now)
  const conversationId = normalizeConversationId(conversationIdValue)
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  await db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, 'app_conversation.body_access', 'app_conversation', ?, NULL, ?, ?)
  `).bind(
    `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
    adminId,
    conversationId,
    JSON.stringify({
      accessReason: ACCESS_REASON,
      requestId,
      lastSequence: conversation.last_sequence,
    }),
    now.toISOString(),
  ).run()
}

export async function markAdminAppConversationRead(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  sequenceValue: unknown,
  now = new Date(),
): Promise<{ conversationId: string; readSequence: number }> {
  await requireAdminConversationAssignment(db, adminId, conversationIdValue, now)
  const conversationId = normalizeConversationId(conversationIdValue)
  const sequence = Number(sequenceValue)
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new AppMessagingError(400, 'INVALID_SEQUENCE', '已读 sequence 必须为非负整数')
  }
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  if (sequence > conversation.last_sequence) {
    throw new AppMessagingError(400, 'INVALID_SEQUENCE', '已读 sequence 超出当前会话范围')
  }
  const readSequence = Math.max(conversation.operator_read_sequence, sequence)
  const nowIso = now.toISOString()
  await db.batch([
    db.prepare(`
      UPDATE app_conversations
      SET operator_read_sequence = ?
      WHERE id = ? AND operator_read_sequence < ?
    `).bind(readSequence, conversationId, readSequence),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) VALUES (?, ?, 'app_conversation.mark_read', 'app_conversation', ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
      adminId,
      conversationId,
      JSON.stringify({ readSequence: conversation.operator_read_sequence }),
      JSON.stringify({ readSequence }),
      nowIso,
    ),
  ])
  return { conversationId, readSequence }
}

export async function sendAdminAppConversationMessage(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  body: AdminSendAppMessageInput,
  now = new Date(),
): Promise<{ message: AppConversationMessage; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const clientMessageId = normalizeClientMessageId(body.clientMessageId)
  if (body.contentType !== 'text') {
    throw new AppMessagingError(400, 'MESSAGE_TYPE_NOT_SUPPORTED', 'Message-1 仅支持文本与表情消息')
  }
  const text = normalizeMessageText(body.text)
  assertOperatorLanguage(text)
  const bodyHash = await sha256Hex(text)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = operatorScope(adminId)
  const requestHash = await hashCanonical({ conversationId, clientMessageId, contentType: 'text', text })
  const replay = await findMessagingIdempotency(
    db,
    actorScope,
    'operator_message_send',
    idempotencyKey,
  )
  if (replay) {
    assertMessagingIdempotencyHash(replay, requestHash)
    return resolveExistingOperatorMessage(db, adminId, conversationId, replay.message_id)
  }

  const duplicate = await findMessageByClientId(db, conversationId, clientMessageId)
  if (duplicate) {
    if (
      duplicate.sender_type !== 'platform_operator'
      || duplicate.actor_admin_id !== adminId
      || duplicate.body_sha256 !== bodyHash
    ) {
      throw new AppMessagingError(409, 'CLIENT_MESSAGE_ID_CONFLICT', 'clientMessageId 已用于另一条消息')
    }
    const conversation = await findConversationForAdmin(db, conversationId)
    if (!conversation) throw conversationNotFound()
    return { message: mapAppConversationMessage(duplicate, conversation), replayed: true }
  }

  await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const runtimeControl = await getAppMessagingRuntimeControl(db)
  if (runtimeControl.operatorSendsPaused) {
    throw new AppMessagingError(503, 'MESSAGING_PAUSED', runtimeControl.userVisibleMessage, true)
  }

  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  assertAdminConversationWritable(conversation)
  const nowIso = now.toISOString()
  const recentBoundary = new Date(now.getTime() - 60_000).toISOString()
  const messageId = prefixedId('msg')
  const auditId = `audit_${crypto.randomUUID().replace(/-/gu, '')}`

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_messages (
          id, conversation_id, sequence, sender_type, client_message_id,
          content_type, body_text, body_sha256, status,
          actor_account_id, actor_admin_id, created_at, recalled_at
        )
        SELECT ?, conversation.id, conversation.last_sequence + 1,
               'platform_operator', ?, 'text', ?, ?, 'accepted', NULL, ?, ?, NULL
        FROM app_conversations conversation
        JOIN app_account_security security ON security.account_id = conversation.account_id
        JOIN profile_public_projections projection ON projection.profile_id = conversation.profile_id
        JOIN galleries gallery ON gallery.id = projection.source_gallery_id
        JOIN app_conversation_assignment_state assignment
          ON assignment.conversation_id = conversation.id
        JOIN app_messaging_runtime_controls runtime_control
          ON runtime_control.scope = 'global'
        WHERE conversation.id = ?
          AND conversation.status = 'active'
          AND assignment.status = 'active'
          AND assignment.assigned_admin_id = ?
          AND datetime(assignment.lease_expires_at) > datetime(?)
          AND runtime_control.operator_sends_paused = 0
          AND security.status = 'active'
          AND projection.operation_mode = 'platform_managed'
          AND projection.verification_status = 'verified'
          AND projection.publication_status = 'published'
          AND projection.authorization_status = 'active'
          AND projection.visibility_status = 'visible'
          AND (projection.authorization_valid_from IS NULL OR datetime(projection.authorization_valid_from) <= datetime(?))
          AND (projection.authorization_valid_until IS NULL OR datetime(projection.authorization_valid_until) > datetime(?))
          AND (projection.verification_valid_until IS NULL OR datetime(projection.verification_valid_until) > datetime(?))
          AND gallery.status = 'published'
          AND (
            SELECT COUNT(*) FROM app_conversation_messages recent
            WHERE recent.conversation_id = conversation.id
              AND recent.sender_type = 'platform_operator'
              AND recent.created_at >= ?
          ) < ?
        LIMIT 1
      `).bind(
        messageId,
        clientMessageId,
        text,
        bodyHash,
        adminId,
        nowIso,
        conversationId,
        adminId,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        recentBoundary,
        OPERATOR_MESSAGES_PER_MINUTE,
      ),
      db.prepare(`
        UPDATE app_conversations
        SET last_sequence = (SELECT sequence FROM app_conversation_messages WHERE id = ?),
            operator_read_sequence = (SELECT sequence FROM app_conversation_messages WHERE id = ?),
            last_message_at = ?,
            queue_status = 'awaiting_viewer',
            updated_at = ?
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM app_conversation_messages WHERE id = ?)
      `).bind(messageId, messageId, nowIso, nowIso, conversationId, messageId),
      db.prepare(`
        INSERT INTO app_messaging_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          conversation_id, message_id, created_at
        )
        SELECT ?, 'operator_message_send', ?, ?, conversation_id, id, ?
        FROM app_conversation_messages
        WHERE id = ?
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, messageId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation.operator_reply', 'app_conversation', ?, NULL, ?, ?
        FROM app_conversation_messages
        WHERE id = ?
      `).bind(
        auditId,
        adminId,
        conversationId,
        JSON.stringify({
          messageId,
          senderType: 'platform_operator',
          bodySha256: bodyHash,
          bodyLength: text.length,
        }),
        nowIso,
        messageId,
      ),
    ])
  }
  catch {
    const raced = await findMessageByClientId(db, conversationId, clientMessageId)
    if (
      raced
      && raced.sender_type === 'platform_operator'
      && raced.actor_admin_id === adminId
      && raced.body_sha256 === bodyHash
    ) {
      const latest = await findConversationForAdmin(db, conversationId)
      if (!latest) throw conversationNotFound()
      return { message: mapAppConversationMessage(raced, latest), replayed: true }
    }
    throw new AppMessagingError(503, 'MESSAGE_WRITE_FAILED', '运营回复暂时无法发送，请稍后重试', true)
  }

  const message = await findMessageById(db, conversationId, messageId)
  const latest = await findConversationForAdmin(db, conversationId)
  if (!message || !latest) {
    await diagnoseOperatorSendFailure(db, adminId, conversationId, now)
  }
  return { message: mapAppConversationMessage(message!, latest!), replayed: false }
}

export async function claimAdminAppConversation(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ assignment: AdminConversationAssignment; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = operatorScope(adminId)
  const requestHash = await hashCanonical({ conversationId })
  const replay = await findSafetyIdempotency(db, actorScope, 'assignment_claim', idempotencyKey)
  if (replay) {
    assertSafetyIdempotencyHash(replay, requestHash)
    return {
      assignment: await readOwnAssignment(db, adminId, conversationId, now, false),
      replayed: true,
    }
  }

  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  if (conversation.status === 'closed') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '已关闭话题不能领取')
  }
  const control = await getAppMessagingRuntimeControl(db)
  const existing = await findConversationAssignment(db, conversationId)
  const active = isAssignmentActive(existing, now)
  if (active && existing!.assigned_admin_id !== adminId) {
    throw new AppMessagingError(409, 'ASSIGNMENT_TAKEN', '该话题已被其他运营人员领取')
  }
  let routingAccess: ConversationRoutingClaimAccess | null = null
  if (!active) {
    routingAccess = await resolveClaimAccess(db, adminId, conversationId, now)
    assertRoutingClaimAllowed(routingAccess)
  }
  await requireAssignmentCapacity(db, adminId, conversationId, control.maxActiveAssignmentsPerOperator, now)

  const nextVersion = (existing?.version ?? 0) + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + control.assignmentLeaseMinutes * 60_000).toISOString()
  const eventType = active && existing?.assigned_admin_id === adminId ? 'renewed' : 'claimed'
  const reasonCode = eventType === 'renewed'
    ? 'operator_renewed'
    : existing?.status === 'active' ? 'expired_reclaimed' : 'operator_claimed'
  const routingGate = routingClaimWriteGate(routingAccess, adminId, conversationId, now)
  const stateStatement = existing
    ? db.prepare(`
        UPDATE app_conversation_assignment_state
        SET assigned_admin_id = ?, status = 'active', version = ?,
            lease_expires_at = ?, mutation_token = ?, assigned_at = ?,
            released_at = NULL, updated_at = ?
        WHERE conversation_id = ? AND version = ?
          AND (
            status <> 'active'
            OR datetime(lease_expires_at) <= datetime(?)
            OR assigned_admin_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM app_conversations conversation
            WHERE conversation.id = ? AND conversation.status <> 'closed'
          )
          AND (
            SELECT COUNT(*) FROM app_conversation_assignment_state active_assignment
            WHERE active_assignment.status = 'active'
              AND active_assignment.assigned_admin_id = ?
              AND active_assignment.conversation_id <> ?
              AND datetime(active_assignment.lease_expires_at) > datetime(?)
          ) < (
            SELECT max_active_assignments_per_operator
            FROM app_messaging_runtime_controls WHERE scope = 'global'
          )
          AND (${routingGate.sql})
      `).bind(
        adminId,
        nextVersion,
        leaseExpiresAt,
        mutationToken,
        eventType === 'renewed' ? existing.assigned_at : nowIso,
        nowIso,
        conversationId,
        existing.version,
        nowIso,
        adminId,
        conversationId,
        adminId,
        conversationId,
        nowIso,
        ...routingGate.bindings,
      )
    : db.prepare(`
        INSERT INTO app_conversation_assignment_state (
          conversation_id, assigned_admin_id, status, version,
          lease_expires_at, mutation_token, assigned_at, released_at, updated_at
        )
        SELECT conversation.id, ?, 'active', 1, ?, ?, ?, NULL, ?
        FROM app_conversations conversation
        JOIN app_messaging_runtime_controls runtime_control
          ON runtime_control.scope = 'global'
        WHERE conversation.id = ? AND conversation.status <> 'closed'
          AND (
            SELECT COUNT(*) FROM app_conversation_assignment_state active_assignment
            WHERE active_assignment.status = 'active'
              AND active_assignment.assigned_admin_id = ?
              AND datetime(active_assignment.lease_expires_at) > datetime(?)
          ) < runtime_control.max_active_assignments_per_operator
          AND (${routingGate.sql})
      `).bind(
        adminId,
        leaseExpiresAt,
        mutationToken,
        nowIso,
        nowIso,
        conversationId,
        adminId,
        nowIso,
        ...routingGate.bindings,
      )

  const routingAssignmentStatements = eventType === 'claimed'
    && routingAccess?.status === 'eligible'
    && routingAccess.groupId
    && routingAccess.ruleId
    && routingAccess.policyVersion !== null
      ? [db.prepare(`
          INSERT INTO app_conversation_routing_assignment_events (
            id, conversation_id, assignment_version, group_id, admin_id,
            policy_version, routing_rule_id, trigger_code, service_day,
            is_new_first_response, operator_active_before, operator_capacity,
            group_active_before, group_capacity, created_at
          )
          SELECT ?, assignment.conversation_id, assignment.version,
                 operation_group.id, assignment.assigned_admin_id,
                 ?, ?, 'manual_claim', ?,
                 CASE WHEN EXISTS (
                   SELECT 1 FROM app_conversation_messages response
                   WHERE response.conversation_id = assignment.conversation_id
                     AND response.sender_type = 'platform_operator'
                 ) THEN 0 ELSE 1 END,
                 (
                   SELECT COUNT(*) FROM app_conversation_assignment_state operator_assignment
                   WHERE operator_assignment.assigned_admin_id = assignment.assigned_admin_id
                     AND operator_assignment.conversation_id <> assignment.conversation_id
                     AND operator_assignment.status = 'active'
                     AND datetime(operator_assignment.lease_expires_at) > datetime(?)
                 ),
                 MIN(member.max_active_assignments, runtime.max_active_assignments_per_operator),
                 (
                   SELECT COUNT(DISTINCT group_assignment.conversation_id)
                   FROM app_conversation_assignment_state group_assignment
                   JOIN app_conversation_group_members group_member
                     ON group_member.group_id = operation_group.id
                    AND group_member.admin_id = group_assignment.assigned_admin_id
                   WHERE group_member.status = 'active'
                     AND group_assignment.conversation_id <> assignment.conversation_id
                     AND group_assignment.status = 'active'
                     AND datetime(group_assignment.lease_expires_at) > datetime(?)
                 ),
                 operation_group.max_active_assignments, ?
          FROM app_conversation_assignment_state assignment
          JOIN app_conversation_groups operation_group ON operation_group.id = ?
          JOIN app_conversation_group_members member
            ON member.group_id = operation_group.id AND member.admin_id = assignment.assigned_admin_id
          JOIN app_messaging_runtime_controls runtime ON runtime.scope = 'global'
          WHERE assignment.conversation_id = ? AND assignment.version = ?
            AND assignment.mutation_token = ? AND assignment.status = 'active'
            AND assignment.assigned_admin_id = ?
        `).bind(
          `cra_${crypto.randomUUID().replace(/-/gu, '')}`,
          routingAccess.policyVersion,
          routingAccess.ruleId,
          shanghaiClock(now).serviceDay,
          nowIso,
          nowIso,
          nowIso,
          routingAccess.groupId,
          conversationId,
          nextVersion,
          mutationToken,
          adminId,
        )]
      : []

  try {
    await db.batch([
      stateStatement,
      db.prepare(`
        INSERT INTO app_conversation_assignment_events (
          id, conversation_id, version, event_type, subject_admin_id,
          actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
        )
        SELECT ?, conversation_id, version, ?, ?, 'admin', ?, ?, lease_expires_at, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ?
          AND status = 'active' AND assigned_admin_id = ?
      `).bind(
        `cae_${crypto.randomUUID().replace(/-/gu, '')}`,
        eventType,
        adminId,
        adminId,
        reasonCode,
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
        adminId,
      ),
      ...routingAssignmentStatements,
      db.prepare(`
        INSERT INTO app_safety_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'assignment_claim', ?, ?, 'assignment', conversation_id, version, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ?
          AND status = 'active' AND assigned_admin_id = ?
      `).bind(
        actorScope,
        idempotencyKey,
        requestHash,
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
        adminId,
      ),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, ?, 'app_conversation', conversation_id, ?, ?, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ?
          AND status = 'active' AND assigned_admin_id = ?
      `).bind(
        `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        eventType === 'renewed' ? 'app_conversation.assignment_renew' : 'app_conversation.assignment_claim',
        JSON.stringify(existing ? assignmentAuditValue(existing) : null),
        JSON.stringify({
          version: nextVersion,
          leaseExpiresAt,
          routingGroupId: routingAccess?.groupId ?? null,
        }),
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
        adminId,
      ),
    ])
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'assignment_claim', idempotencyKey)
    if (concurrent) {
      assertSafetyIdempotencyHash(concurrent, requestHash)
      return {
        assignment: await readOwnAssignment(db, adminId, conversationId, now, false),
        replayed: true,
      }
    }
    await diagnoseAssignmentClaimFailure(db, adminId, conversationId, now)
  }

  const stored = await findSafetyIdempotency(db, actorScope, 'assignment_claim', idempotencyKey)
  if (!stored) await diagnoseAssignmentClaimFailure(db, adminId, conversationId, now)
  return {
    assignment: await readOwnAssignment(db, adminId, conversationId, now),
    replayed: false,
  }
}

export async function releaseAdminAppConversation(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ assignment: AdminConversationAssignment; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = operatorScope(adminId)
  const requestHash = await hashCanonical({ conversationId })
  const replay = await findSafetyIdempotency(db, actorScope, 'assignment_release', idempotencyKey)
  if (replay) {
    assertSafetyIdempotencyHash(replay, requestHash)
    return {
      assignment: await readOwnAssignment(db, adminId, conversationId, now, false),
      replayed: true,
    }
  }
  const existing = await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const nextVersion = existing.version + 1
  const mutationToken = crypto.randomUUID()
  const nowIso = now.toISOString()
  try {
    await db.batch([
      db.prepare(`
        UPDATE app_conversation_assignment_state
        SET assigned_admin_id = NULL, status = 'released', version = ?,
            lease_expires_at = NULL, mutation_token = ?, released_at = ?, updated_at = ?
        WHERE conversation_id = ? AND version = ? AND status = 'active'
          AND assigned_admin_id = ? AND datetime(lease_expires_at) > datetime(?)
      `).bind(nextVersion, mutationToken, nowIso, nowIso, conversationId, existing.version, adminId, nowIso),
      db.prepare(`
        INSERT INTO app_conversation_assignment_events (
          id, conversation_id, version, event_type, subject_admin_id,
          actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
        )
        SELECT ?, conversation_id, version, 'released', ?, 'admin', ?,
               'operator_released', NULL, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
      `).bind(
        `cae_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        adminId,
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO app_safety_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'assignment_release', ?, ?, 'assignment', conversation_id, version, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, conversationId, nextVersion, mutationToken),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation.assignment_release', 'app_conversation',
               conversation_id, ?, ?, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
      `).bind(
        `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        JSON.stringify(assignmentAuditValue(existing)),
        JSON.stringify({ version: nextVersion, status: 'released' }),
        nowIso,
        conversationId,
        nextVersion,
        mutationToken,
      ),
    ])
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'assignment_release', idempotencyKey)
    if (concurrent) {
      assertSafetyIdempotencyHash(concurrent, requestHash)
      return {
        assignment: await readOwnAssignment(db, adminId, conversationId, now, false),
        replayed: true,
      }
    }
    throw new AppMessagingError(409, 'ASSIGNMENT_CONFLICT', '话题分配状态已变化，请刷新后重试', true)
  }
  const stored = await findSafetyIdempotency(db, actorScope, 'assignment_release', idempotencyKey)
  if (!stored) {
    throw new AppMessagingError(409, 'ASSIGNMENT_CONFLICT', '话题分配状态已变化，请刷新后重试', true)
  }
  return {
    assignment: { status: 'unassigned', version: nextVersion, leaseExpiresAt: null },
    replayed: false,
  }
}

export async function closeAdminAppConversation(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ conversationId: string; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = operatorScope(adminId)
  const requestHash = await hashCanonical({ conversationId, reasonCode: 'operator_closed' })
  const replay = await findSafetyIdempotency(db, actorScope, 'conversation_admin_close', idempotencyKey)
  if (replay) {
    assertSafetyIdempotencyHash(replay, requestHash)
    return { conversationId: replay.result_id, replayed: true }
  }
  const assignment = await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  assertAdminConversationWritable(conversation)
  const nowIso = now.toISOString()
  const nextSequence = Number(conversation.last_sequence) + 1
  const messageId = prefixedId('msg')
  const messageText = '平台运营已关闭本话题。历史消息仍可查看。'
  const messageHash = await sha256Hex(messageText)
  const assignmentVersion = assignment.version + 1
  const mutationToken = crypto.randomUUID()
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_messages (
          id, conversation_id, sequence, sender_type, client_message_id,
          content_type, body_text, body_sha256, status,
          actor_account_id, actor_admin_id, created_at, recalled_at
        )
        SELECT ?, id, ?, 'system', ?, 'system', ?, ?, 'accepted', NULL, NULL, ?, NULL
        FROM app_conversations
        WHERE id = ? AND status = 'active' AND last_sequence = ?
          AND EXISTS (
            SELECT 1 FROM app_conversation_assignment_state assignment
            WHERE assignment.conversation_id = app_conversations.id
              AND assignment.status = 'active'
              AND assignment.assigned_admin_id = ?
              AND assignment.version = ?
              AND datetime(assignment.lease_expires_at) > datetime(?)
          )
      `).bind(
        messageId,
        nextSequence,
        `system.operator_close.${nextSequence}`,
        messageText,
        messageHash,
        nowIso,
        conversationId,
        conversation.last_sequence,
        adminId,
        assignment.version,
        nowIso,
      ),
      db.prepare(`
        UPDATE app_conversations
        SET status = 'closed', queue_status = 'closed', last_sequence = ?,
            last_message_at = ?, updated_at = ?, closed_at = ?,
            closed_reason_code = 'operator_closed', closed_by_type = 'admin'
        WHERE id = ? AND EXISTS (SELECT 1 FROM app_conversation_messages WHERE id = ?)
      `).bind(nextSequence, nowIso, nowIso, nowIso, conversationId, messageId),
      db.prepare(`
        UPDATE app_conversation_assignment_state
        SET assigned_admin_id = NULL, status = 'released', version = ?,
            lease_expires_at = NULL, mutation_token = ?, released_at = ?, updated_at = ?
        WHERE conversation_id = ? AND version = ? AND assigned_admin_id = ?
          AND EXISTS (SELECT 1 FROM app_conversations WHERE id = ? AND status = 'closed')
          AND EXISTS (
            SELECT 1 FROM app_conversation_messages
            WHERE id = ? AND conversation_id = ?
          )
      `).bind(
        assignmentVersion,
        mutationToken,
        nowIso,
        nowIso,
        conversationId,
        assignment.version,
        adminId,
        conversationId,
        messageId,
        conversationId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_assignment_events (
          id, conversation_id, version, event_type, subject_admin_id,
          actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
        )
        SELECT ?, conversation_id, version, 'released', ?, 'admin', ?,
               'operator_closed', NULL, ?
        FROM app_conversation_assignment_state
        WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
      `).bind(
        `cae_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        adminId,
        nowIso,
        conversationId,
        assignmentVersion,
        mutationToken,
      ),
      db.prepare(`
        INSERT INTO app_safety_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          result_type, result_id, result_version, created_at
        )
        SELECT ?, 'conversation_admin_close', ?, ?, 'conversation',
               conversation_id, sequence, ?
        FROM app_conversation_messages WHERE id = ?
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, messageId),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        )
        SELECT ?, ?, 'app_conversation.close', 'app_conversation', ?, ?, ?, ?
        FROM app_conversation_messages WHERE id = ?
      `).bind(
        `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
        adminId,
        conversationId,
        JSON.stringify({ status: conversation.status, lastSequence: conversation.last_sequence }),
        JSON.stringify({ status: 'closed', lastSequence: nextSequence, reasonCode: 'operator_closed' }),
        nowIso,
        messageId,
      ),
    ])
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'conversation_admin_close', idempotencyKey)
    if (concurrent) {
      assertSafetyIdempotencyHash(concurrent, requestHash)
      return { conversationId: concurrent.result_id, replayed: true }
    }
    throw new AppMessagingError(409, 'CONVERSATION_CLOSE_CONFLICT', '话题状态已变化，请刷新后重试', true)
  }
  const stored = await findSafetyIdempotency(db, actorScope, 'conversation_admin_close', idempotencyKey)
  if (!stored) {
    throw new AppMessagingError(409, 'CONVERSATION_CLOSE_CONFLICT', '话题状态已变化，请刷新后重试', true)
  }
  return { conversationId, replayed: false }
}

export async function requireAdminConversationAssignment(
  db: D1Database,
  adminId: number,
  conversationIdValue: string,
  now = new Date(),
): Promise<ConversationAssignmentRow> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const assignment = await findConversationAssignment(db, conversationId)
  if (
    !assignment
    || assignment.status !== 'active'
    || assignment.assigned_admin_id !== adminId
    || !assignment.lease_expires_at
    || new Date(assignment.lease_expires_at).getTime() <= now.getTime()
  ) {
    await db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) VALUES (?, ?, 'app_conversation.assignment_denied', 'app_conversation', ?, NULL, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID().replace(/-/gu, '')}`,
      adminId,
      conversationId,
      JSON.stringify({ reasonCode: 'ASSIGNMENT_REQUIRED' }),
      now.toISOString(),
    ).run()
    throw new AppMessagingError(403, 'ASSIGNMENT_REQUIRED', '请先领取该话题，再查看正文或执行运营操作')
  }
  return assignment
}

async function findConversationAssignment(
  db: D1Database,
  conversationId: string,
): Promise<ConversationAssignmentRow | null> {
  return db.prepare(`
    SELECT assigned_admin_id, status, version, lease_expires_at, assigned_at
    FROM app_conversation_assignment_state
    WHERE conversation_id = ?
    LIMIT 1
  `).bind(conversationId).first<ConversationAssignmentRow>()
}

async function readOwnAssignment(
  db: D1Database,
  adminId: number,
  conversationId: string,
  now: Date,
  required = true,
): Promise<AdminConversationAssignment> {
  const assignment = await findConversationAssignment(db, conversationId)
  if (isAssignmentActive(assignment, now) && assignment!.assigned_admin_id === adminId) {
    return {
      status: 'mine',
      version: Number(assignment!.version),
      leaseExpiresAt: assignment!.lease_expires_at,
    }
  }
  if (required) {
    throw new AppMessagingError(409, 'ASSIGNMENT_CONFLICT', '话题分配状态已变化，请刷新后重试', true)
  }
  return {
    status: 'unassigned',
    version: Number(assignment?.version ?? 0),
    leaseExpiresAt: null,
  }
}

function isAssignmentActive(assignment: ConversationAssignmentRow | null, now: Date): boolean {
  return Boolean(
    assignment
    && assignment.status === 'active'
    && assignment.assigned_admin_id
    && assignment.lease_expires_at
    && new Date(assignment.lease_expires_at).getTime() > now.getTime(),
  )
}

async function resolveClaimAccess(
  db: D1Database,
  adminId: number,
  conversationId: string,
  now: Date,
): Promise<ConversationRoutingClaimAccess> {
  const subject = await db.prepare(`
    SELECT conversation.id, conversation.profile_id, profile.region_code
    FROM app_conversations conversation
    JOIN person_profiles profile ON profile.id = conversation.profile_id
    WHERE conversation.id = ?
  `).bind(conversationId).first<{
    id: string
    profile_id: string
    region_code: string | null
  }>()
  if (!subject) throw conversationNotFound()
  const accesses = await resolveConversationRoutingClaimAccesses(db, adminId, [{
    conversationId: subject.id,
    profileId: subject.profile_id,
    regionCode: subject.region_code,
  }], now)
  return accesses.get(conversationId) ?? {
    status: 'no_matching_rule',
    canClaim: false,
    policyVersion: null,
    ruleId: null,
    ruleVersion: null,
    groupId: null,
    groupName: null,
    memberVersion: null,
  }
}

function assertRoutingClaimAllowed(access: ConversationRoutingClaimAccess) {
  if (access.canClaim) return
  if (access.status === 'no_matching_rule') {
    throw new AppMessagingError(409, 'ROUTING_RULE_REQUIRED', '该话题尚未命中生效分配规则，请由运营组长处理配置')
  }
  if (access.status === 'not_group_member') {
    throw new AppMessagingError(403, 'CONVERSATION_GROUP_REQUIRED', '该话题属于其他运营组，当前账号不能领取')
  }
  if (access.status === 'no_active_shift') {
    throw new AppMessagingError(409, 'ACTIVE_SHIFT_REQUIRED', '目标运营组当前无生效班次，话题保持未分配')
  }
  throw new AppMessagingError(403, 'CONVERSATION_ROUTING_FORBIDDEN', '当前账号不能领取该话题')
}

function routingClaimWriteGate(
  access: ConversationRoutingClaimAccess | null,
  adminId: number,
  conversationId: string,
  now: Date,
): { sql: string; bindings: unknown[] } {
  if (access === null) return { sql: '1 = 1', bindings: [] }
  if (access.status === 'legacy_unscoped') {
    return {
      sql: `NOT EXISTS (
        SELECT 1 FROM app_conversation_assignment_policies WHERE scope = 'global'
      )`,
      bindings: [],
    }
  }
  if (
    !access.canClaim
    || access.policyVersion === null
    || access.ruleId === null
    || access.ruleVersion === null
    || access.groupId === null
    || access.memberVersion === null
  ) {
    return { sql: '0 = 1', bindings: [] }
  }
  const local = shanghaiClock(now)
  const nowIso = now.toISOString()
  return {
    sql: `EXISTS (
      SELECT 1
      FROM app_conversation_assignment_policies policy
      JOIN app_conversation_routing_rules rule ON rule.id = ?
      JOIN app_conversation_groups operation_group ON operation_group.id = rule.group_id
      JOIN app_conversation_group_members member
        ON member.group_id = operation_group.id AND member.admin_id = ?
      JOIN users admin ON admin.id = member.admin_id
      JOIN app_conversations routed_conversation ON routed_conversation.id = ?
      JOIN person_profiles profile ON profile.id = routed_conversation.profile_id
      JOIN app_messaging_runtime_controls runtime ON runtime.scope = 'global'
      WHERE policy.scope = 'global' AND policy.version = ?
        AND rule.version = ? AND rule.status = 'active'
        AND operation_group.id = ? AND operation_group.status = 'active'
        AND member.version = ? AND member.status = 'active'
        AND member.accepts_new_assignments = 1
        AND member.member_role IN ('operator', 'lead')
        AND admin.status = 'active' AND admin.role IN ('admin', 'owner')
        AND (
          (rule.match_type = 'profile' AND rule.match_value = routed_conversation.profile_id)
          OR (rule.match_type = 'region' AND rule.match_value = profile.region_code)
          OR (rule.match_type = 'default' AND rule.match_value = '*')
        )
        AND rule.id = (
          SELECT candidate_rule.id
          FROM app_conversation_routing_rules candidate_rule
          JOIN app_conversation_groups candidate_group
            ON candidate_group.id = candidate_rule.group_id
          WHERE candidate_rule.status = 'active' AND candidate_group.status = 'active'
            AND (
              (candidate_rule.match_type = 'profile' AND candidate_rule.match_value = routed_conversation.profile_id)
              OR (candidate_rule.match_type = 'region' AND candidate_rule.match_value = profile.region_code)
              OR (candidate_rule.match_type = 'default' AND candidate_rule.match_value = '*')
            )
          ORDER BY
            CASE candidate_rule.match_type WHEN 'profile' THEN 0 WHEN 'region' THEN 1 ELSE 2 END,
            candidate_rule.priority ASC,
            candidate_rule.id ASC
          LIMIT 1
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
        AND (
          SELECT COUNT(*) FROM app_conversation_assignment_state operator_assignment
          WHERE operator_assignment.assigned_admin_id = member.admin_id
            AND operator_assignment.conversation_id <> routed_conversation.id
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
            AND group_assignment.conversation_id <> routed_conversation.id
            AND group_assignment.status = 'active'
            AND datetime(group_assignment.lease_expires_at) > datetime(?)
        ) < operation_group.max_active_assignments
        AND (
          EXISTS (
            SELECT 1 FROM app_conversation_messages response
            WHERE response.conversation_id = routed_conversation.id
              AND response.sender_type = 'platform_operator'
          )
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
    )`,
    bindings: [
      access.ruleId,
      adminId,
      conversationId,
      access.policyVersion,
      access.ruleVersion,
      access.groupId,
      access.memberVersion,
      local.weekday,
      local.minute,
      local.minute,
      local.weekday,
      local.minute,
      local.previousWeekday,
      local.minute,
      nowIso,
      nowIso,
      local.serviceDay,
      local.serviceDay,
    ],
  }
}

async function requireAssignmentCapacity(
  db: D1Database,
  adminId: number,
  conversationId: string,
  limit: number,
  now: Date,
) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversation_assignment_state
    WHERE status = 'active' AND assigned_admin_id = ? AND conversation_id <> ?
      AND datetime(lease_expires_at) > datetime(?)
  `).bind(adminId, conversationId, now.toISOString()).first<{ count: number }>()
  if (Number(row?.count ?? 0) >= limit) {
    throw new AppMessagingError(429, 'ASSIGNMENT_CAPACITY_REACHED', `当前最多同时处理 ${limit} 个话题，请先释放或关闭已有话题`)
  }
}

async function diagnoseAssignmentClaimFailure(
  db: D1Database,
  adminId: number,
  conversationId: string,
  now: Date,
): Promise<never> {
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  if (conversation.status === 'closed') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '已关闭话题不能领取')
  }
  const assignment = await findConversationAssignment(db, conversationId)
  if (isAssignmentActive(assignment, now) && assignment!.assigned_admin_id !== adminId) {
    throw new AppMessagingError(409, 'ASSIGNMENT_TAKEN', '该话题已被其他运营人员领取')
  }
  if (!isAssignmentActive(assignment, now)) {
    assertRoutingClaimAllowed(await resolveClaimAccess(db, adminId, conversationId, now))
  }
  const control = await getAppMessagingRuntimeControl(db)
  await requireAssignmentCapacity(
    db,
    adminId,
    conversationId,
    control.maxActiveAssignmentsPerOperator,
    now,
  )
  throw new AppMessagingError(409, 'ASSIGNMENT_CONFLICT', '话题分配状态已变化，请刷新后重试', true)
}

async function findSafetyIdempotency(
  db: D1Database,
  actorScope: string,
  operation: 'assignment_claim' | 'assignment_release' | 'conversation_admin_close',
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
    throw new AppMessagingError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key 已用于另一项操作')
  }
}

function assignmentAuditValue(row: ConversationAssignmentRow) {
  return {
    status: row.status,
    version: Number(row.version),
    assigned: row.assigned_admin_id != null,
    leaseExpiresAt: row.lease_expires_at,
  }
}

function normalizeQueueStatus(value: string | undefined): AppConversationQueueStatus | null {
  if (!value) return null
  if (value === 'awaiting_operator' || value === 'awaiting_viewer' || value === 'closed') return value
  throw new AppMessagingError(400, 'QUEUE_STATUS_INVALID', 'queueStatus 无效')
}

async function getAdminConversationRow(
  db: D1Database,
  conversationIdValue: string,
): Promise<AdminConversationRow> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const row = await db.prepare(`
    SELECT conversation.id, conversation.account_id, security.account_public_id,
           account.nickname, conversation.profile_id, profile.display_name, profile.region_code,
           conversation.operation_mode, conversation.receiver_label,
           conversation.disclosure_version, conversation.status,
           conversation.queue_status, conversation.last_sequence,
           conversation.viewer_read_sequence, conversation.operator_read_sequence,
           conversation.last_message_at, conversation.created_at,
           conversation.updated_at,
           assignment.assigned_admin_id,
           assignment.status AS assignment_status,
           assignment.version AS assignment_version,
           assignment.lease_expires_at,
           (
             SELECT COUNT(*) FROM app_conversation_messages message
             WHERE message.conversation_id = conversation.id
               AND message.sender_type = 'viewer'
               AND message.sequence > conversation.operator_read_sequence
           ) AS unread_count
    FROM app_conversations conversation
    JOIN users account ON account.id = conversation.account_id
    JOIN app_account_security security ON security.account_id = conversation.account_id
    JOIN person_profiles profile ON profile.id = conversation.profile_id
    LEFT JOIN app_conversation_assignment_state assignment
      ON assignment.conversation_id = conversation.id
    WHERE conversation.id = ?
    LIMIT 1
  `).bind(conversationId).first<AdminConversationRow>()
  if (!row) throw conversationNotFound()
  return row
}

function mapAdminConversationSummary(
  row: AdminConversationRow,
  adminId: number,
  now: Date,
  routingAccess?: ConversationRoutingClaimAccess,
): AdminAppConversationSummary {
  const assignmentActive = row.assignment_status === 'active'
    && Boolean(row.lease_expires_at)
    && new Date(row.lease_expires_at!).getTime() > now.getTime()
  const assignmentStatus = assignmentActive
    ? row.assigned_admin_id === adminId ? 'mine' : 'other'
    : 'unassigned'
  return {
    conversationId: row.id,
    status: normalizeConversationStatus(row.status),
    queueStatus: normalizeConversationQueueStatus(row.queue_status),
    account: {
      accountId: row.account_public_id,
      nickname: row.nickname,
    },
    profile: {
      profileId: row.profile_id,
      displayName: row.display_name,
    },
    operationMode: 'platform_managed',
    receiverLabel: row.receiver_label,
    assignment: {
      status: assignmentStatus,
      version: Number(row.assignment_version ?? 0),
      leaseExpiresAt: assignmentActive ? row.lease_expires_at : null,
      canClaim: row.status !== 'closed'
        && assignmentStatus !== 'other'
        && (assignmentStatus === 'mine' || routingAccess?.canClaim !== false),
    },
    routing: {
      groupId: routingAccess?.groupId ?? null,
      groupName: routingAccess?.groupName ?? null,
      claimAccess: routingAccess?.status ?? 'legacy_unscoped',
    },
    unreadViewerCount: Math.max(0, Number(row.unread_count)),
    lastSequence: Number(row.last_sequence),
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeConversationStatus(value: string): AppConversationStatus {
  return value === 'closed' ? 'closed' : value === 'restricted' ? 'restricted' : 'active'
}

function normalizeConversationQueueStatus(value: string): AppConversationQueueStatus {
  return value === 'closed' ? 'closed' : value === 'awaiting_operator' ? 'awaiting_operator' : 'awaiting_viewer'
}

function assertOperatorLanguage(text: string) {
  const phrase = PROHIBITED_OPERATOR_PHRASES.find(candidate => text.includes(candidate))
  if (phrase) {
    throw new AppMessagingError(
      400,
      'OPERATOR_LANGUAGE_NOT_ALLOWED',
      `运营回复不能使用可能冒充真人或作出结果承诺的表达：${phrase}`,
    )
  }
}

function assertAdminConversationWritable(conversation: AppConversationInternalRow) {
  if (conversation.status !== 'active') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '当前话题已受限或关闭，只能查看历史')
  }
}

async function resolveExistingOperatorMessage(
  db: D1Database,
  adminId: number,
  conversationId: string,
  messageId: string | null,
): Promise<{ message: AppConversationMessage; replayed: true }> {
  const message = await findMessageById(db, conversationId, messageId)
  const conversation = await findConversationForAdmin(db, conversationId)
  if (
    !message
    || !conversation
    || message.sender_type !== 'platform_operator'
    || message.actor_admin_id !== adminId
  ) {
    throw conversationNotFound()
  }
  return { message: mapAppConversationMessage(message, conversation), replayed: true }
}

async function diagnoseOperatorSendFailure(
  db: D1Database,
  adminId: number,
  conversationId: string,
  now: Date,
): Promise<never> {
  await requireAdminConversationAssignment(db, adminId, conversationId, now)
  const control = await getAppMessagingRuntimeControl(db)
  if (control.operatorSendsPaused) {
    throw new AppMessagingError(503, 'MESSAGING_PAUSED', control.userVisibleMessage, true)
  }
  const conversation = await findConversationForAdmin(db, conversationId)
  if (!conversation) throw conversationNotFound()
  assertAdminConversationWritable(conversation)
  const eligible = await db.prepare(`
    SELECT 1 AS eligible
    FROM app_conversations conversation
    JOIN app_account_security security ON security.account_id = conversation.account_id
    JOIN profile_public_projections projection ON projection.profile_id = conversation.profile_id
    JOIN galleries gallery ON gallery.id = projection.source_gallery_id
    WHERE conversation.id = ?
      AND security.status = 'active'
      AND projection.operation_mode = 'platform_managed'
      AND projection.verification_status = 'verified'
      AND projection.publication_status = 'published'
      AND projection.authorization_status = 'active'
      AND projection.visibility_status = 'visible'
      AND (projection.authorization_valid_from IS NULL OR datetime(projection.authorization_valid_from) <= datetime(?))
      AND (projection.authorization_valid_until IS NULL OR datetime(projection.authorization_valid_until) > datetime(?))
      AND (projection.verification_valid_until IS NULL OR datetime(projection.verification_valid_until) > datetime(?))
      AND gallery.status = 'published'
    LIMIT 1
  `).bind(conversationId, now.toISOString(), now.toISOString(), now.toISOString()).first<{ eligible: number }>()
  if (!eligible) {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '账号或人物资料当前不可用，会话只能查看历史')
  }
  const recentBoundary = new Date(now.getTime() - 60_000).toISOString()
  const recent = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversation_messages
    WHERE conversation_id = ? AND sender_type = 'platform_operator' AND created_at >= ?
  `).bind(conversationId, recentBoundary).first<{ count: number }>()
  if (Number(recent?.count ?? 0) >= OPERATOR_MESSAGES_PER_MINUTE) {
    throw new AppMessagingError(429, 'RATE_LIMITED', '运营回复过于频繁，请稍后再试', true)
  }
  throw new AppMessagingError(409, 'CONVERSATION_WRITE_CONFLICT', '话题状态已变化，请刷新后重试', true)
}

function operatorScope(adminId: number) {
  return `operator:${adminId}`
}

function conversationNotFound() {
  return new AppMessagingError(404, 'CONVERSATION_NOT_FOUND', '平台话题不存在')
}
