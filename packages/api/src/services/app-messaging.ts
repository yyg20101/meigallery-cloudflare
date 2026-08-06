import type {
  AppConversationCreateResult,
  AppConversationMessage,
  AppConversationMessagesPage,
  AppConversationQuota,
  AppConversationSummary,
  AppMembershipResolvedEntitlement,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { getPublicPersonProfile, getPublicPersonProfilesByIds } from './app-discovery'
import {
  AppMembershipError,
  getAppMembershipRuntimeConfig,
  resolveAppMembershipSnapshot,
} from './app-membership'
import {
  AppSafetyError,
  getAppMessagingRuntimeControl,
  isAppProfileBlocked,
  type AppMessagingRuntimeControl,
} from './app-safety'

export const APP_MESSAGE_1_CATALOG_ID = 'amc_app_1_0_message_1_dev_1'
export const APP_MESSAGING_DISCLOSURE_VERSION = 'managed_message_1'
export const APP_MESSAGING_RECEIVER_LABEL = '平台运营接收'
export const APP_MESSAGING_DISCLOSURE_TEXT =
  '话题由平台运营接收与处理，不代表真人本人已入驻或回复；平台不保证固定回复时间、线下见面或关系结果。'
export const APP_MESSAGING_MAX_TEXT_LENGTH = 1000

const CREATE_ENTITLEMENT = 'direct_message.create'
const SEND_ENTITLEMENT = 'direct_message.send'
const DAILY_THREAD_ENTITLEMENT = 'direct_message.new_threads_per_day'
const MAX_MESSAGE_PAGE_SIZE = 100
const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MAX_CONVERSATION_PAGE_SIZE = 40
const DEFAULT_CONVERSATION_PAGE_SIZE = 20
const VIEWER_MESSAGES_PER_MINUTE = 20
const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/u
const CONVERSATION_ID_PATTERN = /^cv_[A-Za-z0-9_-]{1,77}$/u
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u

export interface AppMessagingRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  catalogVersionId: string | null
  disclosureVersion: string
  requireProductionReady: boolean
}

export interface AppConversationListQuery {
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    updatedAt: string
    conversationId: string
  }
}

export interface AppMessageListQuery {
  afterSequence: number
  limit: number
}

export interface CreateAppConversationInput {
  profileId?: unknown
  disclosureVersion?: unknown
}

export interface SendAppMessageInput {
  clientMessageId?: unknown
  contentType?: unknown
  text?: unknown
}

export class AppMessagingError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppMessagingError'
  }
}

type ConversationRow = {
  id: string
  account_id: number
  profile_id: string
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
  blocked: number
}

export type AppConversationInternalRow = ConversationRow

export type AppConversationMessageRow = {
  id: string
  conversation_id: string
  sequence: number
  sender_type: string
  client_message_id: string
  content_type: string
  body_text: string
  body_sha256: string
  status: string
  actor_account_id: number | null
  actor_admin_id: number | null
  created_at: string
}

type IdempotencyRow = {
  request_hash: string
  conversation_id: string
  message_id: string | null
}

export type MessagingEntitlementState = {
  grantId: string
  tierId: string
  catalogVersionId: string
  canCreate: boolean
  canSend: boolean
  dailyThreadLimit: number
  periodKey: string
  resetsAt: string
}

export function getAppMessagingRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_MEMBERSHIP_ENABLED'
  | 'APP_MEMBERSHIP_ADMIN_ENABLED'
  | 'APP_MEMBERSHIP_CATALOG_VERSION'
  | 'APP_MEMBERSHIP_PRODUCTION_READY'
  | 'APP_MESSAGING_ENABLED'
  | 'APP_MESSAGING_ADMIN_ENABLED'
  | 'APP_MESSAGING_DISCLOSURE_VERSION'
  | 'APP_MESSAGING_PRODUCTION_READY'
  | 'APP_SAFETY_ENABLED'
  | 'APP_SAFETY_ADMIN_ENABLED'
  | 'APP_SAFETY_REASON_CATALOG_VERSION'
  | 'APP_SAFETY_PRODUCTION_READY'
>): AppMessagingRuntimeConfig {
  const membership = getAppMembershipRuntimeConfig(env)
  const disclosureVersion = normalizeDisclosureVersion(env.APP_MESSAGING_DISCLOSURE_VERSION)
  const requireProductionReady = env.APP_ENV === 'production'
  const productionGateSatisfied = !requireProductionReady || env.APP_MESSAGING_PRODUCTION_READY === 'true'

  return {
    enabled: env.APP_MESSAGING_ENABLED === 'true'
      && env.APP_SAFETY_ENABLED === 'true'
      && membership.enabled
      && Boolean(disclosureVersion)
      && productionGateSatisfied,
    adminEnabled: env.APP_MESSAGING_ADMIN_ENABLED === 'true'
      && env.APP_SAFETY_ADMIN_ENABLED === 'true'
      && membership.adminEnabled
      && Boolean(disclosureVersion)
      && productionGateSatisfied,
    catalogVersionId: membership.catalogVersionId,
    disclosureVersion: disclosureVersion ?? APP_MESSAGING_DISCLOSURE_VERSION,
    requireProductionReady,
  }
}

export function requireAppMessagingEnabled(
  config: AppMessagingRuntimeConfig,
): asserts config is AppMessagingRuntimeConfig & { catalogVersionId: string } {
  if (!config.enabled || !config.catalogVersionId) {
    throw new AppMessagingError(403, 'FEATURE_DISABLED', '平台话题能力尚未开放')
  }
}

export function requireAppMessagingAdminEnabled(
  config: AppMessagingRuntimeConfig,
): asserts config is AppMessagingRuntimeConfig & { catalogVersionId: string } {
  if (!config.adminEnabled || !config.catalogVersionId) {
    throw new AppMessagingError(403, 'FEATURE_DISABLED', '平台话题工作台尚未开放')
  }
}

export function parseAppConversationListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppConversationListQuery {
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_CONVERSATION_PAGE_SIZE)
    : DEFAULT_CONVERSATION_PAGE_SIZE
  if (!input.cursor) return { limit, cursor: null }
  let decoded: unknown
  try {
    decoded = JSON.parse(decodeBase64Url(input.cursor))
  }
  catch {
    throw new AppMessagingError(400, 'INVALID_CURSOR', '会话分页游标无效')
  }
  if (!isConversationCursor(decoded) || decoded.accountScope !== input.accountScope) {
    throw new AppMessagingError(400, 'INVALID_CURSOR', '会话分页游标与当前账号不匹配')
  }
  return { limit, cursor: decoded }
}

export function parseAppMessageListQuery(input: {
  afterSequence?: string
  limit?: string
}): AppMessageListQuery {
  const rawAfter = input.afterSequence?.trim() || '0'
  const afterSequence = Number(rawAfter)
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new AppMessagingError(400, 'INVALID_SEQUENCE', 'afterSequence 必须为非负整数')
  }
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_MESSAGE_PAGE_SIZE)
    : DEFAULT_MESSAGE_PAGE_SIZE
  return { afterSequence, limit }
}

export async function createAppConversation(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  catalogVersionId: string,
  disclosureVersion: string,
  idempotencyKeyValue: string | null,
  input: CreateAppConversationInput,
  apiUrl: string,
  now = new Date(),
  requireProductionReady = false,
): Promise<AppConversationCreateResult> {
  const profileId = normalizeProfileId(input.profileId)
  const acceptedDisclosureVersion = normalizeDisclosureVersion(input.disclosureVersion)
  if (acceptedDisclosureVersion !== disclosureVersion) {
    throw new AppMessagingError(
      409,
      'DISCLOSURE_VERSION_CONFLICT',
      '平台接收说明已更新，请重新确认后再发起话题',
    )
  }
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const requestHash = await hashCanonical({ profileId, disclosureVersion })
  const actorScope = viewerScope(accountId)
  const replay = await findIdempotency(db, actorScope, 'conversation_create', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    const conversation = await getAppConversation(
      db,
      accountId,
      accountPublicId,
      replay.conversation_id,
      catalogVersionId,
      apiUrl,
      now,
      requireProductionReady,
    )
    return {
      conversation,
      quota: await resolveQuotaIfAvailable(db, accountId, catalogVersionId, now, requireProductionReady),
      created: false,
      replayed: true,
    }
  }

  if (await isAppProfileBlocked(db, accountId, profileId)) {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '你已拉黑该人物资料，无法发起平台话题')
  }

  const existing = await findConversationByProfile(db, accountId, profileId)
  if (existing) {
    await bindExistingConversationIdempotency(
      db,
      actorScope,
      idempotencyKey,
      requestHash,
      existing.id,
      now,
    )
    return {
      conversation: await mapSingleConversation(
        db,
        existing,
        accountId,
        accountPublicId,
        catalogVersionId,
        apiUrl,
        now,
        requireProductionReady,
      ),
      quota: await resolveQuotaIfAvailable(db, accountId, catalogVersionId, now, requireProductionReady),
      created: false,
      replayed: false,
    }
  }

  const runtimeControl = await requireMessagingRuntimeControl(db, requireProductionReady)
  await assertNewConversationCapacity(db, runtimeControl)

  const entitlement = await requireCreateEntitlement(
    db,
    accountId,
    catalogVersionId,
    now,
    requireProductionReady,
  )
  const nowIso = now.toISOString()
  const conversationId = prefixedId('cv')
  const systemMessageId = prefixedId('msg')
  const systemClientMessageId = `system.${disclosureVersion}`
  const systemBodyHash = await sha256Hex(APP_MESSAGING_DISCLOSURE_TEXT)

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversations (
          id, account_id, profile_id, operation_mode, receiver_label,
          disclosure_version, status, queue_status, last_sequence,
          viewer_read_sequence, operator_read_sequence, last_message_at,
          created_at, updated_at, closed_at
        )
        SELECT ?, ?, p.profile_id, 'platform_managed', ?, ?, 'active',
               'awaiting_viewer', 1, 1, 0, ?, ?, ?, NULL
        FROM profile_public_projections p
        JOIN galleries gallery ON gallery.id = p.source_gallery_id
        JOIN app_messaging_runtime_controls runtime_control
          ON runtime_control.scope = 'global'
        JOIN app_membership_grants grant_row ON grant_row.id = ?
        JOIN app_membership_tier_entitlements create_entitlement
          ON create_entitlement.catalog_version_id = grant_row.catalog_version_id
         AND create_entitlement.tier_id = grant_row.tier_id
         AND create_entitlement.entitlement_key = '${CREATE_ENTITLEMENT}'
        JOIN app_membership_tier_entitlements quota_entitlement
          ON quota_entitlement.catalog_version_id = grant_row.catalog_version_id
         AND quota_entitlement.tier_id = grant_row.tier_id
         AND quota_entitlement.entitlement_key = '${DAILY_THREAD_ENTITLEMENT}'
        WHERE p.profile_id = ?
          AND p.operation_mode = 'platform_managed'
          AND p.verification_status = 'verified'
          AND p.publication_status = 'published'
          AND p.authorization_status = 'active'
          AND p.visibility_status = 'visible'
          AND (p.authorization_valid_from IS NULL OR datetime(p.authorization_valid_from) <= datetime(?))
          AND (p.authorization_valid_until IS NULL OR datetime(p.authorization_valid_until) > datetime(?))
          AND (p.verification_valid_until IS NULL OR datetime(p.verification_valid_until) > datetime(?))
          AND datetime(p.published_at) IS NOT NULL
          AND gallery.status = 'published'
          AND runtime_control.new_conversations_paused = 0
          AND NOT EXISTS (
            SELECT 1 FROM app_profile_blocks block
            WHERE block.account_id = ?
              AND block.profile_id = p.profile_id
              AND block.state = 'blocked'
          )
          AND (
            SELECT COUNT(*) FROM app_conversations open_conversation
            WHERE open_conversation.status = 'active'
          ) < runtime_control.max_open_conversations
          AND grant_row.user_id = ?
          AND grant_row.catalog_version_id = ?
          AND grant_row.starts_at <= ?
          AND grant_row.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM app_membership_grant_revocations revoked
            WHERE revoked.grant_id = grant_row.id
          )
          AND create_entitlement.availability = 'available'
          AND json_extract(create_entitlement.value_json, '$') = 1
          AND quota_entitlement.availability = 'available'
          AND CAST(json_extract(quota_entitlement.value_json, '$') AS INTEGER) = ?
          AND (
            SELECT COALESCE(SUM(consumption.amount), 0)
            FROM app_conversation_quota_consumptions consumption
            WHERE consumption.account_id = ?
              AND consumption.entitlement_key = '${DAILY_THREAD_ENTITLEMENT}'
              AND consumption.period_key = ?
          ) < ?
        LIMIT 1
      `).bind(
        conversationId,
        accountId,
        APP_MESSAGING_RECEIVER_LABEL,
        disclosureVersion,
        nowIso,
        nowIso,
        nowIso,
        entitlement.grantId,
        profileId,
        nowIso,
        nowIso,
        nowIso,
        accountId,
        accountId,
        catalogVersionId,
        nowIso,
        nowIso,
        entitlement.dailyThreadLimit,
        accountId,
        entitlement.periodKey,
        entitlement.dailyThreadLimit,
      ),
      db.prepare(`
        INSERT INTO app_conversation_quota_consumptions (
          conversation_id, account_id, membership_grant_id, catalog_version_id,
          tier_id, entitlement_key, period_key, amount, consumed_at
        )
        SELECT id, account_id, ?, ?, ?, '${DAILY_THREAD_ENTITLEMENT}', ?, 1, ?
        FROM app_conversations
        WHERE id = ?
      `).bind(
        entitlement.grantId,
        catalogVersionId,
        entitlement.tierId,
        entitlement.periodKey,
        nowIso,
        conversationId,
      ),
      db.prepare(`
        INSERT INTO app_conversation_messages (
          id, conversation_id, sequence, sender_type, client_message_id,
          content_type, body_text, body_sha256, status,
          actor_account_id, actor_admin_id, created_at, recalled_at
        )
        SELECT ?, id, 1, 'system', ?, 'system', ?, ?, 'accepted', NULL, NULL, ?, NULL
        FROM app_conversations
        WHERE id = ?
      `).bind(
        systemMessageId,
        systemClientMessageId,
        APP_MESSAGING_DISCLOSURE_TEXT,
        systemBodyHash,
        nowIso,
        conversationId,
      ),
      db.prepare(`
        INSERT INTO app_messaging_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          conversation_id, message_id, created_at
        )
        SELECT ?, 'conversation_create', ?, ?, id, NULL, ?
        FROM app_conversations
        WHERE id = ?
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, conversationId),
    ])
  }
  catch {
    const concurrentReplay = await findIdempotency(db, actorScope, 'conversation_create', idempotencyKey)
    if (concurrentReplay) {
      assertIdempotencyHash(concurrentReplay, requestHash)
      return {
        conversation: await getAppConversation(
          db,
          accountId,
          accountPublicId,
          concurrentReplay.conversation_id,
          catalogVersionId,
          apiUrl,
          now,
          requireProductionReady,
        ),
        quota: await resolveQuotaIfAvailable(db, accountId, catalogVersionId, now, requireProductionReady),
        created: false,
        replayed: true,
      }
    }
    const concurrentConversation = await findConversationByProfile(db, accountId, profileId)
    if (concurrentConversation && concurrentConversation.blocked !== 1) {
      return {
        conversation: await mapSingleConversation(
          db,
          concurrentConversation,
          accountId,
          accountPublicId,
          catalogVersionId,
          apiUrl,
          now,
          requireProductionReady,
        ),
        quota: await resolveQuotaIfAvailable(db, accountId, catalogVersionId, now, requireProductionReady),
        created: false,
        replayed: false,
      }
    }
    throw new AppMessagingError(503, 'MESSAGING_WRITE_FAILED', '平台话题暂时无法创建，请稍后重试', true)
  }

  const created = await findConversationById(db, accountId, conversationId)
  if (!created) {
    await diagnoseCreateFailure(
      db,
      accountId,
      catalogVersionId,
      profileId,
      now,
      requireProductionReady,
    )
    throw new AppMessagingError(503, 'MESSAGING_WRITE_FAILED', '平台话题暂时无法创建，请稍后重试', true)
  }

  return {
    conversation: await mapSingleConversation(
      db,
      created,
      accountId,
      accountPublicId,
      catalogVersionId,
      apiUrl,
      now,
      requireProductionReady,
    ),
    quota: await quotaForEntitlement(db, accountId, entitlement),
    created: true,
    replayed: false,
  }
}

export async function listAppConversations(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  catalogVersionId: string,
  apiUrl: string,
  query: AppConversationListQuery,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ data: AppConversationSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = ['account_id = ?']
  const params: unknown[] = [accountId]
  if (query.cursor) {
    conditions.push('(updated_at < ? OR (updated_at = ? AND id > ?))')
    params.push(query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.conversationId)
  }
  const result = await db.prepare(`
    SELECT c.*,
      (
        SELECT COUNT(*)
        FROM app_conversation_messages message
        WHERE message.conversation_id = c.id
          AND message.sender_type = 'platform_operator'
          AND message.sequence > c.viewer_read_sequence
      ) AS unread_count,
      EXISTS (
        SELECT 1 FROM app_profile_blocks block
        WHERE block.account_id = c.account_id
          AND block.profile_id = c.profile_id
          AND block.state = 'blocked'
      ) AS blocked
    FROM app_conversations c
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<ConversationRow>()

  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  const profiles = await getPublicPersonProfilesByIds(db, rows.map(row => row.profile_id), apiUrl, now)
  const sendState = await resolveSendState(db, accountId, catalogVersionId, now, requireProductionReady)
  const data = rows.map(row => mapConversation(row, profiles.get(row.profile_id) ?? null, sendState))
  const last = rows.at(-1)
  return {
    data,
    nextCursor: hasMore && last
      ? encodeBase64Url(JSON.stringify({
          v: 1,
          accountScope: accountPublicId,
          updatedAt: last.updated_at,
          conversationId: last.id,
        }))
      : null,
    hasMore,
  }
}

export async function getAppConversation(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  conversationIdValue: string,
  catalogVersionId: string,
  apiUrl: string,
  now = new Date(),
  requireProductionReady = false,
): Promise<AppConversationSummary> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const row = await findConversationById(db, accountId, conversationId)
  if (!row) throw conversationNotFound()
  return mapSingleConversation(
    db,
    row,
    accountId,
    accountPublicId,
    catalogVersionId,
    apiUrl,
    now,
    requireProductionReady,
  )
}

export async function listAppConversationMessages(
  db: D1Database,
  accountId: number,
  conversationIdValue: string,
  query: AppMessageListQuery,
): Promise<AppConversationMessagesPage> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const conversation = await findConversationById(db, accountId, conversationId)
  if (!conversation) throw conversationNotFound()
  const result = await db.prepare(`
    SELECT id, conversation_id, sequence, sender_type, client_message_id,
           content_type, body_text, body_sha256, status,
           actor_account_id, actor_admin_id, created_at
    FROM app_conversation_messages
    WHERE conversation_id = ? AND sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `).bind(conversationId, query.afterSequence, query.limit + 1).all<AppConversationMessageRow>()
  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  return {
    items: rows.map(row => mapConversationMessage(row, conversation)),
    nextAfterSequence: hasMore ? rows.at(-1)?.sequence ?? null : null,
    hasMore,
  }
}

export async function sendAppViewerMessage(
  db: D1Database,
  accountId: number,
  conversationIdValue: string,
  catalogVersionId: string,
  idempotencyKeyValue: string | null,
  input: SendAppMessageInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<{ message: AppConversationMessage; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const clientMessageId = normalizeClientMessageId(input.clientMessageId)
  if (input.contentType !== 'text') {
    throw new AppMessagingError(400, 'MESSAGE_TYPE_NOT_SUPPORTED', 'App 1.0 仅支持文本与表情消息')
  }
  const text = normalizeMessageText(input.text)
  const bodyHash = await sha256Hex(text)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = viewerScope(accountId)
  const requestHash = await hashCanonical({ conversationId, clientMessageId, contentType: 'text', text })

  const replay = await findIdempotency(db, actorScope, 'viewer_message_send', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    const message = await findMessageById(db, conversationId, replay.message_id)
    const conversation = await findConversationById(db, accountId, conversationId)
    if (!message || !conversation) throw conversationNotFound()
    return { message: mapConversationMessage(message, conversation), replayed: true }
  }

  const duplicate = await findMessageByClientId(db, conversationId, clientMessageId)
  if (duplicate) {
    if (duplicate.sender_type !== 'viewer' || duplicate.body_sha256 !== bodyHash) {
      throw new AppMessagingError(409, 'CLIENT_MESSAGE_ID_CONFLICT', 'clientMessageId 已用于另一条消息')
    }
    const conversation = await findConversationById(db, accountId, conversationId)
    if (!conversation) throw conversationNotFound()
    return { message: mapConversationMessage(duplicate, conversation), replayed: true }
  }

  const entitlement = await requireSendEntitlement(
    db,
    accountId,
    catalogVersionId,
    now,
    requireProductionReady,
  )
  const conversation = await findConversationById(db, accountId, conversationId)
  if (!conversation) throw conversationNotFound()
  assertConversationWritable(conversation)
  const runtimeControl = await requireMessagingRuntimeControl(db, requireProductionReady)
  if (runtimeControl.viewerSendsPaused) {
    throw new AppMessagingError(503, 'MESSAGING_PAUSED', runtimeControl.userVisibleMessage, true)
  }
  const nowIso = now.toISOString()
  const recentBoundary = new Date(now.getTime() - 60_000).toISOString()
  const messageId = prefixedId('msg')

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_conversation_messages (
          id, conversation_id, sequence, sender_type, client_message_id,
          content_type, body_text, body_sha256, status,
          actor_account_id, actor_admin_id, created_at, recalled_at
        )
        SELECT ?, conversation.id, conversation.last_sequence + 1, 'viewer', ?,
               'text', ?, ?, 'accepted', ?, NULL, ?, NULL
        FROM app_conversations conversation
        JOIN profile_public_projections profile ON profile.profile_id = conversation.profile_id
        JOIN galleries gallery ON gallery.id = profile.source_gallery_id
        JOIN app_messaging_runtime_controls runtime_control
          ON runtime_control.scope = 'global'
        JOIN app_membership_grants grant_row ON grant_row.id = ?
        JOIN app_membership_tier_entitlements send_entitlement
          ON send_entitlement.catalog_version_id = grant_row.catalog_version_id
         AND send_entitlement.tier_id = grant_row.tier_id
         AND send_entitlement.entitlement_key = '${SEND_ENTITLEMENT}'
        WHERE conversation.id = ?
          AND conversation.account_id = ?
          AND conversation.status = 'active'
          AND runtime_control.viewer_sends_paused = 0
          AND NOT EXISTS (
            SELECT 1 FROM app_profile_blocks block
            WHERE block.account_id = conversation.account_id
              AND block.profile_id = conversation.profile_id
              AND block.state = 'blocked'
          )
          AND profile.operation_mode = 'platform_managed'
          AND profile.verification_status = 'verified'
          AND profile.publication_status = 'published'
          AND profile.authorization_status = 'active'
          AND profile.visibility_status = 'visible'
          AND (profile.authorization_valid_from IS NULL OR datetime(profile.authorization_valid_from) <= datetime(?))
          AND (profile.authorization_valid_until IS NULL OR datetime(profile.authorization_valid_until) > datetime(?))
          AND (profile.verification_valid_until IS NULL OR datetime(profile.verification_valid_until) > datetime(?))
          AND gallery.status = 'published'
          AND grant_row.user_id = ?
          AND grant_row.catalog_version_id = ?
          AND grant_row.starts_at <= ?
          AND grant_row.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM app_membership_grant_revocations revoked
            WHERE revoked.grant_id = grant_row.id
          )
          AND send_entitlement.availability = 'available'
          AND json_extract(send_entitlement.value_json, '$') = 1
          AND (
            SELECT COUNT(*) FROM app_conversation_messages recent
            WHERE recent.conversation_id = conversation.id
              AND recent.sender_type = 'viewer'
              AND recent.created_at >= ?
          ) < ?
        LIMIT 1
      `).bind(
        messageId,
        clientMessageId,
        text,
        bodyHash,
        accountId,
        nowIso,
        entitlement.grantId,
        conversationId,
        accountId,
        nowIso,
        nowIso,
        nowIso,
        accountId,
        catalogVersionId,
        nowIso,
        nowIso,
        recentBoundary,
        VIEWER_MESSAGES_PER_MINUTE,
      ),
      db.prepare(`
        UPDATE app_conversations
        SET last_sequence = (
              SELECT sequence FROM app_conversation_messages WHERE id = ?
            ),
            last_message_at = ?,
            queue_status = 'awaiting_operator',
            updated_at = ?
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM app_conversation_messages WHERE id = ?)
      `).bind(messageId, nowIso, nowIso, conversationId, messageId),
      db.prepare(`
        INSERT INTO app_messaging_idempotency (
          actor_scope, operation, idempotency_key, request_hash,
          conversation_id, message_id, created_at
        )
        SELECT ?, 'viewer_message_send', ?, ?, conversation_id, id, ?
        FROM app_conversation_messages
        WHERE id = ?
      `).bind(actorScope, idempotencyKey, requestHash, nowIso, messageId),
    ])
  }
  catch {
    const concurrent = await findMessageByClientId(db, conversationId, clientMessageId)
    if (concurrent && concurrent.sender_type === 'viewer' && concurrent.body_sha256 === bodyHash) {
      const latestConversation = await findConversationById(db, accountId, conversationId)
      if (!latestConversation) throw conversationNotFound()
      return { message: mapConversationMessage(concurrent, latestConversation), replayed: true }
    }
    throw new AppMessagingError(503, 'MESSAGE_WRITE_FAILED', '消息暂时无法发送，请稍后重试', true)
  }

  const message = await findMessageById(db, conversationId, messageId)
  const latestConversation = await findConversationById(db, accountId, conversationId)
  if (!message || !latestConversation) {
    await diagnoseViewerSendFailure(
      db,
      accountId,
      catalogVersionId,
      conversation,
      now,
      requireProductionReady,
    )
    throw new AppMessagingError(503, 'MESSAGE_WRITE_FAILED', '消息暂时无法发送，请稍后重试', true)
  }
  return { message: mapConversationMessage(message, latestConversation), replayed: false }
}

export async function markAppConversationRead(
  db: D1Database,
  accountId: number,
  conversationIdValue: string,
  sequenceValue: unknown,
): Promise<{ conversationId: string; readSequence: number }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const sequence = Number(sequenceValue)
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new AppMessagingError(400, 'INVALID_SEQUENCE', '已读 sequence 必须为非负整数')
  }
  const conversation = await findConversationById(db, accountId, conversationId)
  if (!conversation) throw conversationNotFound()
  if (sequence > conversation.last_sequence) {
    throw new AppMessagingError(400, 'INVALID_SEQUENCE', '已读 sequence 超出当前会话范围')
  }
  const readSequence = Math.max(conversation.viewer_read_sequence, sequence)
  await db.prepare(`
    UPDATE app_conversations
    SET viewer_read_sequence = ?, updated_at = updated_at
    WHERE id = ? AND account_id = ? AND viewer_read_sequence < ?
  `).bind(readSequence, conversationId, accountId, readSequence).run()
  return { conversationId, readSequence }
}

export async function resolveMessagingEntitlements(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  now = new Date(),
  requireProductionReady = false,
): Promise<MessagingEntitlementState> {
  let snapshot
  try {
    snapshot = await resolveAppMembershipSnapshot(
      db,
      accountId,
      catalogVersionId,
      now,
      { requireProductionReady },
    )
  }
  catch (error) {
    if (error instanceof AppMembershipError) {
      throw new AppMessagingError(error.status, error.code, error.message, error.retryable)
    }
    throw error
  }
  if (!snapshot.grant || !snapshot.tier) {
    throw new AppMessagingError(403, 'ENTITLEMENT_REQUIRED', '有效会员才可使用平台话题')
  }
  const create = findEntitlement(snapshot.entitlements, CREATE_ENTITLEMENT)
  const send = findEntitlement(snapshot.entitlements, SEND_ENTITLEMENT)
  const daily = findEntitlement(snapshot.entitlements, DAILY_THREAD_ENTITLEMENT)
  if (
    !create || create.valueType !== 'boolean' || typeof create.value !== 'boolean'
    || !send || send.valueType !== 'boolean' || typeof send.value !== 'boolean'
    || !daily || daily.valueType !== 'integer' || typeof daily.value !== 'number'
    || !Number.isInteger(daily.value) || daily.value < 0
  ) {
    throw new AppMessagingError(503, 'MESSAGING_ENTITLEMENT_INVALID', '平台话题权益配置异常')
  }
  if (!create.executable || !send.executable || !daily.executable) {
    throw new AppMessagingError(503, 'MESSAGING_ENTITLEMENT_NOT_READY', '平台话题权益尚未进入可执行状态')
  }
  if (daily.periodRule !== 'daily:Asia/Shanghai') {
    throw new AppMessagingError(503, 'MESSAGING_PERIOD_RULE_INVALID', '平台话题额度周期配置异常')
  }
  const period = shanghaiDailyPeriod(now)
  return {
    grantId: snapshot.grant.grantId,
    tierId: snapshot.tier.tierId,
    catalogVersionId,
    canCreate: create.value,
    canSend: send.value,
    dailyThreadLimit: daily.value,
    periodKey: period.periodKey,
    resetsAt: period.resetsAt,
  }
}

export function normalizeMessageText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppMessagingError(400, 'MESSAGE_TEXT_INVALID', '消息正文必须为文本')
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (
    normalized.length === 0
    || normalized.length > APP_MESSAGING_MAX_TEXT_LENGTH
    || containsDisallowedControlCharacter(normalized)
  ) {
    throw new AppMessagingError(
      400,
      'MESSAGE_TEXT_INVALID',
      `消息正文必须为 1 至 ${APP_MESSAGING_MAX_TEXT_LENGTH} 个字符，且不能包含控制字符`,
    )
  }
  return normalized
}

function containsDisallowedControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
  })
}

export function normalizeClientMessageId(value: unknown): string {
  if (typeof value !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(value)) {
    throw new AppMessagingError(400, 'CLIENT_MESSAGE_ID_INVALID', 'clientMessageId 格式不正确')
  }
  return value
}

export function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppMessagingError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value))
}

export function prefixedId(prefix: 'cv' | 'msg'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

export async function findConversationForAdmin(
  db: D1Database,
  conversationIdValue: string,
): Promise<AppConversationInternalRow | null> {
  const conversationId = normalizeConversationId(conversationIdValue)
  return db.prepare(`
    SELECT c.*,
      (
        SELECT COUNT(*) FROM app_conversation_messages message
        WHERE message.conversation_id = c.id
          AND message.sender_type = 'viewer'
          AND message.sequence > c.operator_read_sequence
      ) AS unread_count,
      EXISTS (
        SELECT 1 FROM app_profile_blocks block
        WHERE block.account_id = c.account_id
          AND block.profile_id = c.profile_id
          AND block.state = 'blocked'
      ) AS blocked
    FROM app_conversations c
    WHERE c.id = ?
    LIMIT 1
  `).bind(conversationId).first<ConversationRow>()
}

export async function findMessageById(
  db: D1Database,
  conversationId: string,
  messageId: string | null,
): Promise<AppConversationMessageRow | null> {
  if (!messageId) return null
  return db.prepare(`
    SELECT id, conversation_id, sequence, sender_type, client_message_id,
           content_type, body_text, body_sha256, status,
           actor_account_id, actor_admin_id, created_at
    FROM app_conversation_messages
    WHERE conversation_id = ? AND id = ?
    LIMIT 1
  `).bind(conversationId, messageId).first<AppConversationMessageRow>()
}

export async function findMessageByClientId(
  db: D1Database,
  conversationId: string,
  clientMessageId: string,
): Promise<AppConversationMessageRow | null> {
  return db.prepare(`
    SELECT id, conversation_id, sequence, sender_type, client_message_id,
           content_type, body_text, body_sha256, status,
           actor_account_id, actor_admin_id, created_at
    FROM app_conversation_messages
    WHERE conversation_id = ? AND client_message_id = ?
    LIMIT 1
  `).bind(conversationId, clientMessageId).first<AppConversationMessageRow>()
}

export async function findMessagingIdempotency(
  db: D1Database,
  actorScope: string,
  operation: 'conversation_create' | 'viewer_message_send' | 'operator_message_send',
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  return findIdempotency(db, actorScope, operation, idempotencyKey)
}

export function assertMessagingIdempotencyHash(row: IdempotencyRow, requestHash: string) {
  assertIdempotencyHash(row, requestHash)
}

export function mapAppConversationMessage(
  row: AppConversationMessageRow,
  conversation: AppConversationInternalRow,
): AppConversationMessage {
  return mapConversationMessage(row, conversation)
}

export function normalizeConversationId(value: string): string {
  if (!CONVERSATION_ID_PATTERN.test(value)) throw conversationNotFound()
  return value
}

function normalizeProfileId(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new AppMessagingError(400, 'PROFILE_ID_INVALID', '人物资料标识无效')
  }
  return value
}

function normalizeDisclosureVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return /^[A-Za-z0-9._-]{1,80}$/u.test(normalized) ? normalized : null
}

function findEntitlement(
  entitlements: AppMembershipResolvedEntitlement[],
  key: string,
): AppMembershipResolvedEntitlement | null {
  return entitlements.find(entitlement => entitlement.key === key) ?? null
}

async function requireCreateEntitlement(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<MessagingEntitlementState> {
  const entitlement = await resolveMessagingEntitlements(
    db,
    accountId,
    catalogVersionId,
    now,
    requireProductionReady,
  )
  if (!entitlement.canCreate) {
    throw new AppMessagingError(403, 'ENTITLEMENT_REQUIRED', '当前会员等级不能发起平台话题')
  }
  if (entitlement.dailyThreadLimit <= 0) {
    throw new AppMessagingError(429, 'ENTITLEMENT_QUOTA_EXCEEDED', '今日新话题额度已用完')
  }
  return entitlement
}

async function requireSendEntitlement(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<MessagingEntitlementState> {
  const entitlement = await resolveMessagingEntitlements(
    db,
    accountId,
    catalogVersionId,
    now,
    requireProductionReady,
  )
  if (!entitlement.canSend) {
    throw new AppMessagingError(403, 'ENTITLEMENT_REQUIRED', '当前会员等级不能发送平台话题消息')
  }
  return entitlement
}

async function resolveSendState(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<{ allowed: boolean; reason: string | null }> {
  try {
    const runtimeControl = await requireMessagingRuntimeControl(db, requireProductionReady)
    if (runtimeControl.viewerSendsPaused) {
      return { allowed: false, reason: runtimeControl.userVisibleMessage }
    }
    const entitlement = await requireSendEntitlement(
      db,
      accountId,
      catalogVersionId,
      now,
      requireProductionReady,
    )
    return { allowed: entitlement.canSend, reason: entitlement.canSend ? null : '会员权益不允许发送消息' }
  }
  catch (error) {
    if (error instanceof AppMessagingError) return { allowed: false, reason: error.message }
    throw error
  }
}

async function resolveQuotaIfAvailable(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<AppConversationQuota | null> {
  try {
    const entitlement = await resolveMessagingEntitlements(
      db,
      accountId,
      catalogVersionId,
      now,
      requireProductionReady,
    )
    return quotaForEntitlement(db, accountId, entitlement)
  }
  catch (error) {
    if (error instanceof AppMessagingError) return null
    throw error
  }
}

async function quotaForEntitlement(
  db: D1Database,
  accountId: number,
  entitlement: MessagingEntitlementState,
): Promise<AppConversationQuota> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS used
    FROM app_conversation_quota_consumptions
    WHERE account_id = ?
      AND entitlement_key = '${DAILY_THREAD_ENTITLEMENT}'
      AND period_key = ?
  `).bind(accountId, entitlement.periodKey).first<{ used: number }>()
  const used = Math.max(0, Number(row?.used ?? 0))
  return {
    limit: entitlement.dailyThreadLimit,
    used,
    remaining: Math.max(0, entitlement.dailyThreadLimit - used),
    resetsAt: entitlement.resetsAt,
    periodKey: entitlement.periodKey,
  }
}

async function requireMessagingRuntimeControl(
  db: D1Database,
  requireProductionReady: boolean,
): Promise<AppMessagingRuntimeControl> {
  try {
    const control = await getAppMessagingRuntimeControl(db)
    if (
      requireProductionReady
      && (
        control.retentionDecisionStatus !== 'approved'
        || !control.retentionProductionReady
      )
    ) {
      throw new AppMessagingError(
        503,
        'SAFETY_POLICY_NOT_READY',
        '平台话题安全与保留策略尚未完成生产发布',
      )
    }
    return control
  }
  catch (error) {
    if (error instanceof AppMessagingError) throw error
    if (error instanceof AppSafetyError) {
      throw new AppMessagingError(error.status, error.code, error.message, error.retryable)
    }
    throw error
  }
}

async function assertNewConversationCapacity(
  db: D1Database,
  control: AppMessagingRuntimeControl,
): Promise<void> {
  if (control.newConversationsPaused) {
    throw new AppMessagingError(503, 'MESSAGING_PAUSED', control.userVisibleMessage, true)
  }
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversations
    WHERE status = 'active'
  `).first<{ count: number }>()
  if (Number(row?.count ?? 0) >= control.maxOpenConversations) {
    throw new AppMessagingError(503, 'MESSAGING_CAPACITY_REACHED', '当前话题服务繁忙，请稍后再试', true)
  }
}

async function diagnoseCreateFailure(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  profileId: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<never> {
  if (await isAppProfileBlocked(db, accountId, profileId)) {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '你已拉黑该人物资料，无法发起平台话题')
  }
  await assertNewConversationCapacity(
    db,
    await requireMessagingRuntimeControl(db, requireProductionReady),
  )
  const profile = await getPublicPersonProfile(db, profileId, 'https://local.invalid', now)
  if (!profile || profile.operation.mode !== 'platform_managed') {
    throw new AppMessagingError(404, 'PROFILE_NOT_AVAILABLE', '人物资料不存在或当前无法发起话题')
  }
  const entitlement = await requireCreateEntitlement(
    db,
    accountId,
    catalogVersionId,
    now,
    requireProductionReady,
  )
  const quota = await quotaForEntitlement(db, accountId, entitlement)
  if (quota.remaining <= 0) {
    throw new AppMessagingError(429, 'ENTITLEMENT_QUOTA_EXCEEDED', '今日新话题额度已用完')
  }
  throw new AppMessagingError(409, 'CONVERSATION_CREATE_CONFLICT', '话题状态已变化，请刷新后重试', true)
}

async function diagnoseViewerSendFailure(
  db: D1Database,
  accountId: number,
  catalogVersionId: string,
  conversation: ConversationRow,
  now: Date,
  requireProductionReady: boolean,
): Promise<never> {
  const latest = await findConversationById(db, accountId, conversation.id)
  if (!latest) throw conversationNotFound()
  assertConversationWritable(latest)
  const profile = await getPublicPersonProfile(db, latest.profile_id, 'https://local.invalid', now)
  if (!profile || profile.operation.mode !== 'platform_managed') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '人物资料当前不可用，会话已转为只读')
  }
  const runtimeControl = await requireMessagingRuntimeControl(db, requireProductionReady)
  if (runtimeControl.viewerSendsPaused) {
    throw new AppMessagingError(503, 'MESSAGING_PAUSED', runtimeControl.userVisibleMessage, true)
  }
  await requireSendEntitlement(db, accountId, catalogVersionId, now, requireProductionReady)
  const recentBoundary = new Date(now.getTime() - 60_000).toISOString()
  const recent = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_conversation_messages
    WHERE conversation_id = ? AND sender_type = 'viewer' AND created_at >= ?
  `).bind(latest.id, recentBoundary).first<{ count: number }>()
  if (Number(recent?.count ?? 0) >= VIEWER_MESSAGES_PER_MINUTE) {
    throw new AppMessagingError(429, 'RATE_LIMITED', '发送过于频繁，请稍后再试', true)
  }
  throw new AppMessagingError(409, 'CONVERSATION_WRITE_CONFLICT', '会话状态已变化，请刷新后重试', true)
}

function assertConversationWritable(conversation: ConversationRow) {
  if (conversation.status !== 'active') {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '当前话题已受限或关闭，只能查看历史')
  }
  if (conversation.blocked === 1) {
    throw new AppMessagingError(403, 'CONVERSATION_FORBIDDEN', '你已拉黑该人物资料，本话题只能查看历史')
  }
}

async function mapSingleConversation(
  db: D1Database,
  row: ConversationRow,
  accountId: number,
  _accountPublicId: string,
  catalogVersionId: string,
  apiUrl: string,
  now: Date,
  requireProductionReady: boolean,
): Promise<AppConversationSummary> {
  const profiles = await getPublicPersonProfilesByIds(db, [row.profile_id], apiUrl, now)
  const sendState = await resolveSendState(db, accountId, catalogVersionId, now, requireProductionReady)
  return mapConversation(row, profiles.get(row.profile_id) ?? null, sendState)
}

function mapConversation(
  row: ConversationRow,
  profile: Awaited<ReturnType<typeof getPublicPersonProfile>>,
  sendState: { allowed: boolean; reason: string | null },
): AppConversationSummary {
  const status = row.status === 'closed' ? 'closed' : row.status === 'restricted' ? 'restricted' : 'active'
  const queueStatus = row.queue_status === 'closed'
    ? 'closed'
    : row.queue_status === 'awaiting_operator'
      ? 'awaiting_operator'
      : 'awaiting_viewer'
  const profileAvailable = Boolean(profile && profile.operation.mode === 'platform_managed')
  const statusReason = status === 'closed'
    ? '话题已关闭，只能查看历史'
    : status === 'restricted'
      ? '话题当前受限，只能查看历史'
      : row.blocked === 1
        ? '你已拉黑该人物资料，本话题只能查看历史'
      : !profileAvailable
        ? '人物资料当前不可用，会话已转为只读'
        : sendState.reason
  return {
    conversationId: row.id,
    profile: {
      profileId: row.profile_id,
      available: profileAvailable,
      displayName: profileAvailable ? profile!.displayName : null,
      coverUrl: profileAvailable ? profile!.coverUrl : null,
    },
    operationMode: 'platform_managed',
    receiverLabel: APP_MESSAGING_RECEIVER_LABEL,
    disclosureVersion: row.disclosure_version,
    disclosureText: APP_MESSAGING_DISCLOSURE_TEXT,
    status,
    queueStatus,
    lastSequence: Number(row.last_sequence),
    unreadCount: Math.max(0, Number(row.unread_count)),
    canSend: status === 'active' && row.blocked !== 1 && profileAvailable && sendState.allowed,
    sendUnavailableReason: statusReason,
    canClose: status !== 'closed',
    closeUnavailableReason: status === 'closed' ? '话题已关闭' : null,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapConversationMessage(
  row: AppConversationMessageRow,
  conversation: ConversationRow,
): AppConversationMessage {
  const senderType = row.sender_type === 'platform_operator'
    ? 'platform_operator'
    : row.sender_type === 'system'
      ? 'system'
      : 'viewer'
  const status = row.status === 'review_pending'
    ? 'review_pending'
    : row.status === 'rejected'
      ? 'rejected'
      : row.status === 'recalled'
        ? 'recalled'
        : 'accepted'
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    senderType,
    senderLabel: senderType === 'viewer' ? '我' : senderType === 'platform_operator' ? '平台运营' : '服务说明',
    clientMessageId: row.client_message_id,
    contentType: row.content_type === 'system' ? 'system' : 'text',
    text: status === 'recalled' ? '该消息已撤回' : row.body_text,
    status,
    readByReceiver: senderType === 'viewer'
      ? row.sequence <= conversation.operator_read_sequence
      : row.sequence <= conversation.viewer_read_sequence,
    createdAt: row.created_at,
  }
}

async function findConversationByProfile(
  db: D1Database,
  accountId: number,
  profileId: string,
): Promise<ConversationRow | null> {
  return db.prepare(`
    SELECT c.*,
      (
        SELECT COUNT(*) FROM app_conversation_messages message
        WHERE message.conversation_id = c.id
          AND message.sender_type = 'platform_operator'
          AND message.sequence > c.viewer_read_sequence
      ) AS unread_count,
      EXISTS (
        SELECT 1 FROM app_profile_blocks block
        WHERE block.account_id = c.account_id
          AND block.profile_id = c.profile_id
          AND block.state = 'blocked'
      ) AS blocked
    FROM app_conversations c
    WHERE c.account_id = ? AND c.profile_id = ?
    LIMIT 1
  `).bind(accountId, profileId).first<ConversationRow>()
}

async function findConversationById(
  db: D1Database,
  accountId: number,
  conversationId: string,
): Promise<ConversationRow | null> {
  return db.prepare(`
    SELECT c.*,
      (
        SELECT COUNT(*) FROM app_conversation_messages message
        WHERE message.conversation_id = c.id
          AND message.sender_type = 'platform_operator'
          AND message.sequence > c.viewer_read_sequence
      ) AS unread_count,
      EXISTS (
        SELECT 1 FROM app_profile_blocks block
        WHERE block.account_id = c.account_id
          AND block.profile_id = c.profile_id
          AND block.state = 'blocked'
      ) AS blocked
    FROM app_conversations c
    WHERE c.account_id = ? AND c.id = ?
    LIMIT 1
  `).bind(accountId, conversationId).first<ConversationRow>()
}

async function findIdempotency(
  db: D1Database,
  actorScope: string,
  operation: 'conversation_create' | 'viewer_message_send' | 'operator_message_send',
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  return db.prepare(`
    SELECT request_hash, conversation_id, message_id
    FROM app_messaging_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<IdempotencyRow>()
}

async function bindExistingConversationIdempotency(
  db: D1Database,
  actorScope: string,
  idempotencyKey: string,
  requestHash: string,
  conversationId: string,
  now: Date,
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO app_messaging_idempotency (
        actor_scope, operation, idempotency_key, request_hash,
        conversation_id, message_id, created_at
      ) VALUES (?, 'conversation_create', ?, ?, ?, NULL, ?)
    `).bind(
      actorScope,
      idempotencyKey,
      requestHash,
      conversationId,
      now.toISOString(),
    ).run()
  }
  catch {
    const replay = await findIdempotency(
      db,
      actorScope,
      'conversation_create',
      idempotencyKey,
    )
    if (!replay) {
      throw new AppMessagingError(
        503,
        'MESSAGING_WRITE_FAILED',
        '平台话题幂等状态暂时无法保存，请稍后重试',
        true,
      )
    }
    assertIdempotencyHash(replay, requestHash)
    if (replay.conversation_id !== conversationId) {
      throw new AppMessagingError(
        409,
        'IDEMPOTENCY_CONFLICT',
        '同一 Idempotency-Key 不能用于不同话题',
      )
    }
  }
}

function assertIdempotencyHash(row: IdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppMessagingError(409, 'IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 不能用于不同请求')
  }
}

function shanghaiDailyPeriod(now: Date): { periodKey: string; resetsAt: string } {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth()
  const day = shifted.getUTCDate()
  const periodKey = `${year.toString().padStart(4, '0')}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
  const nextShanghaiMidnightUtc = Date.UTC(year, month, day + 1) - 8 * 60 * 60 * 1000
  return { periodKey, resetsAt: new Date(nextShanghaiMidnightUtc).toISOString() }
}

function viewerScope(accountId: number) {
  return `viewer:${accountId}`
}

function isConversationCursor(value: unknown): value is NonNullable<AppConversationListQuery['cursor']> {
  if (!value || typeof value !== 'object') return false
  const cursor = value as Record<string, unknown>
  return cursor.v === 1
    && typeof cursor.accountScope === 'string'
    && typeof cursor.updatedAt === 'string'
    && !Number.isNaN(Date.parse(cursor.updatedAt))
    && typeof cursor.conversationId === 'string'
    && CONVERSATION_ID_PATTERN.test(cursor.conversationId)
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw new Error('invalid cursor')
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

function conversationNotFound() {
  return new AppMessagingError(404, 'CONVERSATION_NOT_FOUND', '平台话题不存在或不属于当前账号')
}
