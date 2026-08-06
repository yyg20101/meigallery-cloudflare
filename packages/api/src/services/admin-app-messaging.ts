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

type AdminConversationRow = {
  id: string
  account_id: number
  account_public_id: string
  nickname: string | null
  profile_id: string
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
  query: AdminAppConversationListQuery,
): Promise<AdminAppConversationSummary[]> {
  const condition = query.queueStatus ? 'AND conversation.queue_status = ?' : ''
  const params: unknown[] = query.queueStatus ? [query.queueStatus] : []
  const result = await db.prepare(`
    SELECT conversation.id, conversation.account_id, security.account_public_id,
           account.nickname, conversation.profile_id, profile.display_name,
           conversation.operation_mode, conversation.receiver_label,
           conversation.disclosure_version, conversation.status,
           conversation.queue_status, conversation.last_sequence,
           conversation.viewer_read_sequence, conversation.operator_read_sequence,
           conversation.last_message_at, conversation.created_at,
           conversation.updated_at,
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
    WHERE 1 = 1 ${condition}
    ORDER BY
      CASE conversation.queue_status WHEN 'awaiting_operator' THEN 0 WHEN 'awaiting_viewer' THEN 1 ELSE 2 END,
      conversation.updated_at ASC,
      conversation.id ASC
    LIMIT ?
  `).bind(...params, query.limit).all<AdminConversationRow>()
  return result.results.map(mapAdminConversationSummary)
}

export async function getAdminAppConversation(
  db: D1Database,
  conversationIdValue: string,
): Promise<AdminAppConversationDetail> {
  const row = await getAdminConversationRow(db, conversationIdValue)
  return {
    ...mapAdminConversationSummary(row),
    disclosureVersion: row.disclosure_version,
    accessReason: ACCESS_REASON,
    operatorReadSequence: Number(row.operator_read_sequence),
    viewerReadSequence: Number(row.viewer_read_sequence),
  }
}

export async function listAdminAppConversationMessages(
  db: D1Database,
  conversationIdValue: string,
  query: AdminAppConversationMessageQuery,
): Promise<{ items: AppConversationMessage[]; nextAfterSequence: number | null; hasMore: boolean }> {
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
        WHERE conversation.id = ?
          AND conversation.status = 'active'
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
    await diagnoseOperatorSendFailure(db, conversationId, now)
  }
  return { message: mapAppConversationMessage(message!, latest!), replayed: false }
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
           account.nickname, conversation.profile_id, profile.display_name,
           conversation.operation_mode, conversation.receiver_label,
           conversation.disclosure_version, conversation.status,
           conversation.queue_status, conversation.last_sequence,
           conversation.viewer_read_sequence, conversation.operator_read_sequence,
           conversation.last_message_at, conversation.created_at,
           conversation.updated_at,
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
    WHERE conversation.id = ?
    LIMIT 1
  `).bind(conversationId).first<AdminConversationRow>()
  if (!row) throw conversationNotFound()
  return row
}

function mapAdminConversationSummary(row: AdminConversationRow): AdminAppConversationSummary {
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
  conversationId: string,
  now: Date,
): Promise<never> {
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
