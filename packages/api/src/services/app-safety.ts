import type {
  AppPersonProfile,
  AppProfileBlockListItem,
  AppProfileBlockState,
  AppSafetyReason,
  AppSafetyReportCreateResult,
  AppSafetyReportDetail,
  AppSafetyReportStatus,
  AppSafetyReportSummary,
  AppSafetyReportTarget,
  AppSafetyReportTargetType,
} from '@meigallery/shared'
import type { Bindings } from '../index'
import { getPublicPersonProfilesByIds } from './app-discovery'

export const APP_MESSAGE_2_CATALOG_ID = 'amc_app_1_0_message_2_dev_1'
export const APP_SAFETY_REASON_CATALOG_ID = 'src_app_1_0_message_2_dev_1'
export const APP_SAFETY_MAX_DESCRIPTION_LENGTH = 500
export const APP_SAFETY_REPORT_TARGETS: AppSafetyReportTargetType[] = [
  'person_profile',
  'media',
  'conversation',
  'message',
]
export const APP_SAFETY_REASONS: AppSafetyReason[] = [
  { code: 'authorization_impersonation', label: '授权或冒名问题' },
  { code: 'prohibited_content', label: '违规或不适内容' },
  { code: 'privacy_exposure', label: '隐私泄露' },
  { code: 'harassment', label: '骚扰或不当沟通' },
  { code: 'fraud_inducement', label: '诈骗或诱导' },
  { code: 'minor_coercion', label: '疑似未成年人或胁迫' },
  { code: 'imminent_danger', label: '现实人身安全风险' },
  { code: 'other', label: '其他问题' },
]

const PROFILE_ID_PATTERN = /^pp_[A-Za-z0-9_-]{1,77}$/u
const CONVERSATION_ID_PATTERN = /^cv_[A-Za-z0-9_-]{1,77}$/u
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{1,76}$/u
const MEDIA_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,79}$/u
const REASON_CODE_PATTERN = /^[a-z0-9_]{3,64}$/u
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/u
const DEFAULT_LIST_SIZE = 20
const MAX_LIST_SIZE = 40
const REPORTS_PER_DAY = 20

export interface AppSafetyRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  reasonCatalogId: string
  requireProductionReady: boolean
}

export interface AppMessagingRuntimeControl {
  newConversationsPaused: boolean
  viewerSendsPaused: boolean
  operatorSendsPaused: boolean
  emergencyReasonCode: string | null
  userVisibleMessage: string
  maxOpenConversations: number
  maxActiveAssignmentsPerOperator: number
  assignmentLeaseMinutes: number
  retentionPolicyId: string
  retentionDecisionStatus: 'unresolved' | 'approved'
  retentionProductionReady: boolean
  purgeEnabled: boolean
  version: number
  updatedAt: string
}

export interface AppBlockListQuery {
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    updatedAt: string
    profileId: string
  }
}

export interface AppReportListQuery {
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    submittedAt: string
    reportId: string
  }
}

export interface CreateAppSafetyReportInput {
  targetType?: unknown
  profileId?: unknown
  mediaId?: unknown
  conversationId?: unknown
  messageId?: unknown
  reasonCode?: unknown
  description?: unknown
}

export class AppSafetyError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppSafetyError'
  }
}

type BlockRow = {
  profile_id: string
  state: string
  version: number
  mutation_token: string
  blocked_at: string
  updated_at: string
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
  description_text: string
  user_visible_status: string
  user_visible_message: string
  submitted_at: string
  updated_at: string
}

type ReportEventRow = {
  sequence: number
  user_visible_status: string
  user_visible_message: string
  created_at: string
}

type SafetyIdempotencyRow = {
  request_hash: string
  result_type: string
  result_id: string
  result_version: number
}

type ReportTargetContext = {
  target: AppSafetyReportTarget
  profileContentVersion: number | null
  profileProjectionVersion: number | null
  messageSequence: number | null
  messageSenderType: string | null
  messageBodySha256: string | null
  contextBeforeMessageId: string | null
  contextAfterMessageId: string | null
}

export function getAppSafetyRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_SAFETY_ENABLED'
  | 'APP_SAFETY_ADMIN_ENABLED'
  | 'APP_SAFETY_REASON_CATALOG_VERSION'
  | 'APP_SAFETY_PRODUCTION_READY'
>): AppSafetyRuntimeConfig {
  const requireProductionReady = env.APP_ENV === 'production'
  const reasonCatalogId = normalizePolicyVersion(env.APP_SAFETY_REASON_CATALOG_VERSION)
    ?? APP_SAFETY_REASON_CATALOG_ID
  const productionGateSatisfied = !requireProductionReady || env.APP_SAFETY_PRODUCTION_READY === 'true'
  return {
    enabled: env.APP_SAFETY_ENABLED === 'true'
      && Boolean(normalizePolicyVersion(env.APP_SAFETY_REASON_CATALOG_VERSION))
      && productionGateSatisfied,
    adminEnabled: env.APP_SAFETY_ADMIN_ENABLED === 'true'
      && Boolean(normalizePolicyVersion(env.APP_SAFETY_REASON_CATALOG_VERSION))
      && productionGateSatisfied,
    reasonCatalogId,
    requireProductionReady,
  }
}

export function requireAppSafetyEnabled(config: AppSafetyRuntimeConfig) {
  if (!config.enabled) {
    throw new AppSafetyError(403, 'FEATURE_DISABLED', '举报与拉黑能力尚未开放')
  }
}

export function requireAppSafetyAdminEnabled(config: AppSafetyRuntimeConfig) {
  if (!config.adminEnabled) {
    throw new AppSafetyError(403, 'FEATURE_DISABLED', '安全运营工作台尚未开放')
  }
}

export function parseAppBlockListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppBlockListQuery {
  const limit = listLimit(input.limit)
  if (!input.cursor) return { limit, cursor: null }
  const cursor = decodeCursor(input.cursor)
  if (!isBlockCursor(cursor) || cursor.accountScope !== input.accountScope) {
    throw new AppSafetyError(400, 'INVALID_CURSOR', '拉黑列表游标与当前账号不匹配')
  }
  return { limit, cursor }
}

export function parseAppReportListQuery(input: {
  limit?: string
  cursor?: string
  accountScope: string
}): AppReportListQuery {
  const limit = listLimit(input.limit)
  if (!input.cursor) return { limit, cursor: null }
  const cursor = decodeCursor(input.cursor)
  if (!isReportCursor(cursor) || cursor.accountScope !== input.accountScope) {
    throw new AppSafetyError(400, 'INVALID_CURSOR', '举报列表游标与当前账号不匹配')
  }
  return { limit, cursor }
}

export async function getAppProfileBlockState(
  db: D1Database,
  accountId: number,
  profileIdValue: string,
): Promise<AppProfileBlockState> {
  const profileId = normalizeProfileId(profileIdValue)
  await requireExistingProfile(db, profileId)
  return mapBlockState(profileId, await findBlock(db, accountId, profileId))
}

export async function setAppProfileBlock(
  db: D1Database,
  accountId: number,
  profileIdValue: string,
  blocked: boolean,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ state: AppProfileBlockState; replayed: boolean }> {
  const profileId = normalizeProfileId(profileIdValue)
  await requireExistingProfile(db, profileId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const operation = blocked ? 'profile_block' : 'profile_unblock'
  const actorScope = viewerScope(accountId)
  const requestHash = await hashCanonical({ profileId, blocked })
  const replay = await findSafetyIdempotency(db, actorScope, operation, idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { state: mapBlockState(profileId, await findBlock(db, accountId, profileId)), replayed: true }
  }

  const existing = await findBlock(db, accountId, profileId)
  const currentlyBlocked = existing?.state === 'blocked'
  if (currentlyBlocked === blocked) {
    await bindSafetyIdempotency(
      db,
      actorScope,
      operation,
      idempotencyKey,
      requestHash,
      'profile_block',
      profileId,
      existing?.version ?? 0,
      now,
    )
    return { state: mapBlockState(profileId, existing), replayed: false }
  }

  const nowIso = now.toISOString()
  const nextVersion = (existing?.version ?? 0) + 1
  const mutationToken = crypto.randomUUID()
  const eventId = prefixedId('ble')
  const statements: D1PreparedStatement[] = []
  if (existing) {
    statements.push(db.prepare(`
      UPDATE app_profile_blocks
      SET state = ?, version = ?, mutation_token = ?, blocked_at = ?, unblocked_at = ?, updated_at = ?
      WHERE account_id = ? AND profile_id = ? AND version = ?
    `).bind(
      blocked ? 'blocked' : 'unblocked',
      nextVersion,
      mutationToken,
      blocked ? nowIso : existing.blocked_at,
      blocked ? null : nowIso,
      nowIso,
      accountId,
      profileId,
      existing.version,
    ))
  }
  else if (blocked) {
    statements.push(db.prepare(`
      INSERT INTO app_profile_blocks (
        account_id, profile_id, state, version, mutation_token,
        blocked_at, unblocked_at, updated_at
      ) VALUES (?, ?, 'blocked', 1, ?, ?, NULL, ?)
    `).bind(accountId, profileId, mutationToken, nowIso, nowIso))
  }
  else {
    throw new AppSafetyError(409, 'BLOCK_STATE_CONFLICT', '拉黑状态已变化，请刷新后重试', true)
  }
  statements.push(db.prepare(`
    INSERT INTO app_profile_block_events (
      id, account_id, profile_id, version, event_type, occurred_at
    )
    SELECT ?, account_id, profile_id, version, ?, ?
    FROM app_profile_blocks
    WHERE account_id = ? AND profile_id = ? AND version = ? AND mutation_token = ?
  `).bind(
    eventId,
    blocked ? 'blocked' : 'unblocked',
    nowIso,
    accountId,
    profileId,
    nextVersion,
    mutationToken,
  ))

  if (blocked) {
    statements.push(db.prepare(`
      DELETE FROM app_viewer_interactions
      WHERE account_id = ? AND profile_id = ?
        AND EXISTS (
          SELECT 1 FROM app_profile_blocks block
          WHERE block.account_id = ? AND block.profile_id = ?
            AND block.state = 'blocked' AND block.version = ?
            AND block.mutation_token = ?
        )
    `).bind(accountId, profileId, accountId, profileId, nextVersion, mutationToken))
    const conversation = await db.prepare(`
      SELECT id, last_sequence
      FROM app_conversations
      WHERE account_id = ? AND profile_id = ? AND status <> 'closed'
      LIMIT 1
    `).bind(accountId, profileId).first<{ id: string; last_sequence: number }>()
    if (conversation) {
      const messageId = prefixedId('msg')
      const messageText = '你已拉黑该人物资料，本话题已关闭；解除拉黑不会自动恢复旧话题。'
      const messageHash = await sha256Hex(messageText)
      const nextSequence = Number(conversation.last_sequence) + 1
      statements.push(db.prepare(`
        INSERT INTO app_conversation_messages (
          id, conversation_id, sequence, sender_type, client_message_id,
          content_type, body_text, body_sha256, status,
          actor_account_id, actor_admin_id, created_at, recalled_at
        )
        SELECT ?, id, ?, 'system', ?, 'system', ?, ?, 'accepted', NULL, NULL, ?, NULL
        FROM app_conversations
        WHERE id = ? AND account_id = ? AND status <> 'closed' AND last_sequence = ?
          AND EXISTS (
            SELECT 1 FROM app_profile_blocks block
            WHERE block.account_id = ? AND block.profile_id = ?
              AND block.state = 'blocked' AND block.version = ?
              AND block.mutation_token = ?
          )
      `).bind(
        messageId,
        nextSequence,
        `system.viewer_block.${nextVersion}`,
        messageText,
        messageHash,
        nowIso,
        conversation.id,
        accountId,
        conversation.last_sequence,
        accountId,
        profileId,
        nextVersion,
        mutationToken,
      ))
      statements.push(db.prepare(`
        UPDATE app_conversations
        SET status = 'closed', queue_status = 'closed', last_sequence = ?,
            last_message_at = ?, updated_at = ?, closed_at = ?,
            restriction_reason_code = 'viewer_blocked_profile',
            restriction_source = 'viewer_block',
            closed_reason_code = 'viewer_blocked_profile',
            closed_by_type = 'viewer'
        WHERE id = ? AND account_id = ?
          AND EXISTS (SELECT 1 FROM app_conversation_messages WHERE id = ?)
      `).bind(nextSequence, nowIso, nowIso, nowIso, conversation.id, accountId, messageId))
      await appendSystemAssignmentRelease(
        db,
        statements,
        conversation.id,
        'viewer_blocked_profile',
        now,
        messageId,
      )
    }
  }

  statements.push(db.prepare(`
    INSERT INTO app_safety_idempotency (
      actor_scope, operation, idempotency_key, request_hash,
      result_type, result_id, result_version, created_at
    )
    SELECT ?, ?, ?, ?, 'profile_block', profile_id, version, ?
    FROM app_profile_blocks
    WHERE account_id = ? AND profile_id = ? AND mutation_token = ?
  `).bind(
    actorScope,
    operation,
    idempotencyKey,
    requestHash,
    nowIso,
    accountId,
    profileId,
    mutationToken,
  ))

  try {
    await db.batch(statements)
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, operation, idempotencyKey)
    if (concurrent) {
      assertIdempotencyHash(concurrent, requestHash)
      return { state: mapBlockState(profileId, await findBlock(db, accountId, profileId)), replayed: true }
    }
    throw new AppSafetyError(409, 'BLOCK_STATE_CONFLICT', '拉黑状态已变化，请刷新后重试', true)
  }
  const state = await findBlock(db, accountId, profileId)
  if (
    !state
    || state.version !== nextVersion
    || state.mutation_token !== mutationToken
    || (state.state === 'blocked') !== blocked
  ) {
    throw new AppSafetyError(409, 'BLOCK_STATE_CONFLICT', '拉黑状态已变化，请刷新后重试', true)
  }
  return { state: mapBlockState(profileId, state), replayed: false }
}

export async function listAppProfileBlocks(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  apiUrl: string,
  query: AppBlockListQuery,
  now = new Date(),
): Promise<{ data: AppProfileBlockListItem[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = ["account_id = ?", "state = 'blocked'"]
  const params: unknown[] = [accountId]
  if (query.cursor) {
    conditions.push('(updated_at < ? OR (updated_at = ? AND profile_id > ?))')
    params.push(query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.profileId)
  }
  const rows = await db.prepare(`
    SELECT profile_id, state, version, mutation_token, blocked_at, updated_at
    FROM app_profile_blocks
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, profile_id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<BlockRow>()
  const hasMore = rows.results.length > query.limit
  const page = rows.results.slice(0, query.limit)
  const profiles = await getPublicPersonProfilesByIds(db, page.map(row => row.profile_id), apiUrl, now)
  const data = page.map(row => ({
    ...mapBlockState(row.profile_id, row),
    profile: profiles.get(row.profile_id) ?? null,
    unavailableReason: profiles.has(row.profile_id) ? null : 'PROFILE_NOT_AVAILABLE' as const,
  }))
  const last = page.at(-1)
  return {
    data,
    nextCursor: hasMore && last
      ? encodeCursor({
          v: 1,
          accountScope: accountPublicId,
          updatedAt: last.updated_at,
          profileId: last.profile_id,
        })
      : null,
    hasMore,
  }
}

export async function createAppSafetyReport(
  db: D1Database,
  accountId: number,
  reasonCatalogId: string,
  idempotencyKeyValue: string | null,
  input: CreateAppSafetyReportInput,
  now = new Date(),
  requireProductionReady = false,
): Promise<AppSafetyReportCreateResult> {
  const target = normalizeReportTargetInput(input)
  const reasonCode = normalizeReasonCode(input.reasonCode)
  const description = normalizeDescription(input.description)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = viewerScope(accountId)
  const requestHash = await hashCanonical({ target, reasonCode, description })
  const replay = await findSafetyIdempotency(db, actorScope, 'report_create', idempotencyKey)
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { report: await getAppSafetyReport(db, accountId, replay.result_id), replayed: true }
  }

  const catalog = await requireReasonCatalog(
    db,
    reasonCatalogId,
    reasonCode,
    requireProductionReady,
  )
  const context = await resolveReportTarget(db, accountId, target)
  await requireReportCapacity(db, accountId, now)
  const reportId = prefixedId('rpt')
  const eventId = prefixedId('rpe')
  const nowIso = now.toISOString()
  const descriptionHash = await sha256Hex(description)
  const evidenceDigest = await hashCanonical(context)
  const userVisibleMessage = '举报已收到，平台将按安全流程处理。你可以在举报记录中查看必要状态。'
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_safety_reports (
          id, account_id, target_type, profile_id, media_id, conversation_id,
          message_id, reason_catalog_id, reason_code, description_text,
          description_sha256, priority, status, user_visible_status,
          user_visible_message, assigned_admin_id, version, retention_policy_id,
          submitted_at, updated_at, resolved_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'submitted',
          ?, NULL, 1, ?, ?, ?, NULL
        )
      `).bind(
        reportId,
        accountId,
        context.target.type,
        context.target.profileId,
        context.target.mediaId,
        context.target.conversationId,
        context.target.messageId,
        reasonCatalogId,
        reasonCode,
        description,
        descriptionHash,
        catalog.priority,
        userVisibleMessage,
        catalog.retentionPolicyId,
        nowIso,
        nowIso,
      ),
      db.prepare(`
        INSERT INTO app_safety_report_evidence (
          report_id, profile_content_version, profile_projection_version,
          media_id, conversation_id, message_id, message_sequence,
          message_sender_type, message_body_sha256, context_before_message_id,
          context_after_message_id, evidence_digest, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        reportId,
        context.profileContentVersion,
        context.profileProjectionVersion,
        context.target.mediaId,
        context.target.conversationId,
        context.target.messageId,
        context.messageSequence,
        context.messageSenderType,
        context.messageBodySha256,
        context.contextBeforeMessageId,
        context.contextAfterMessageId,
        evidenceDigest,
        nowIso,
      ),
      db.prepare(`
        INSERT INTO app_safety_report_events (
          id, report_id, sequence, actor_type, actor_account_id, actor_admin_id,
          event_type, status_from, status_to, reason_code,
          user_visible_status, user_visible_message, created_at
        ) VALUES (?, ?, 1, 'viewer', ?, NULL, 'submitted', NULL, 'submitted',
          ?, 'submitted', ?, ?)
      `).bind(eventId, reportId, accountId, reasonCode, userVisibleMessage, nowIso),
      safetyIdempotencyStatement(
        db,
        actorScope,
        'report_create',
        idempotencyKey,
        requestHash,
        'report',
        reportId,
        1,
        nowIso,
      ),
    ])
  }
  catch {
    const concurrent = await findSafetyIdempotency(db, actorScope, 'report_create', idempotencyKey)
    if (concurrent) {
      assertIdempotencyHash(concurrent, requestHash)
      return { report: await getAppSafetyReport(db, accountId, concurrent.result_id), replayed: true }
    }
    throw new AppSafetyError(503, 'REPORT_WRITE_FAILED', '举报暂时无法提交，请稍后重试', true)
  }
  return { report: await getAppSafetyReport(db, accountId, reportId), replayed: false }
}

export async function listAppSafetyReports(
  db: D1Database,
  accountId: number,
  accountPublicId: string,
  query: AppReportListQuery,
): Promise<{ data: AppSafetyReportSummary[]; nextCursor: string | null; hasMore: boolean }> {
  const conditions = ['report.account_id = ?']
  const params: unknown[] = [accountId]
  if (query.cursor) {
    conditions.push('(report.submitted_at < ? OR (report.submitted_at = ? AND report.id > ?))')
    params.push(query.cursor.submittedAt, query.cursor.submittedAt, query.cursor.reportId)
  }
  const rows = await db.prepare(`${REPORT_SELECT}
    WHERE ${conditions.join(' AND ')}
    ORDER BY report.submitted_at DESC, report.id ASC
    LIMIT ?
  `).bind(...params, query.limit + 1).all<ReportRow>()
  const hasMore = rows.results.length > query.limit
  const page = rows.results.slice(0, query.limit)
  const last = page.at(-1)
  return {
    data: page.map(mapReportSummary),
    nextCursor: hasMore && last
      ? encodeCursor({
          v: 1,
          accountScope: accountPublicId,
          submittedAt: last.submitted_at,
          reportId: last.id,
        })
      : null,
    hasMore,
  }
}

export async function getAppSafetyReport(
  db: D1Database,
  accountId: number,
  reportIdValue: string,
): Promise<AppSafetyReportDetail> {
  const reportId = normalizeReportId(reportIdValue)
  const report = await db.prepare(`${REPORT_SELECT}
    WHERE report.id = ? AND report.account_id = ?
    LIMIT 1
  `).bind(reportId, accountId).first<ReportRow>()
  if (!report) throw reportNotFound()
  const events = await db.prepare(`
    SELECT sequence, user_visible_status, user_visible_message, created_at
    FROM app_safety_report_events
    WHERE report_id = ?
    ORDER BY sequence ASC
  `).bind(reportId).all<ReportEventRow>()
  return {
    ...mapReportSummary(report),
    description: report.description_text,
    timeline: events.results.map(event => ({
      sequence: Number(event.sequence),
      status: normalizeVisibleReportStatus(event.user_visible_status),
      message: event.user_visible_message,
      createdAt: event.created_at,
    })),
  }
}

export async function closeAppConversationForViewer(
  db: D1Database,
  accountId: number,
  conversationIdValue: string,
  idempotencyKeyValue: string | null,
  now = new Date(),
): Promise<{ conversationId: string; replayed: boolean }> {
  const conversationId = normalizeConversationId(conversationIdValue)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyValue)
  const actorScope = viewerScope(accountId)
  const requestHash = await hashCanonical({ conversationId, reasonCode: 'viewer_closed' })
  const replay = await findSafetyIdempotency(
    db,
    actorScope,
    'conversation_viewer_close',
    idempotencyKey,
  )
  if (replay) {
    assertIdempotencyHash(replay, requestHash)
    return { conversationId: replay.result_id, replayed: true }
  }
  const conversation = await db.prepare(`
    SELECT id, last_sequence, status
    FROM app_conversations
    WHERE id = ? AND account_id = ?
    LIMIT 1
  `).bind(conversationId, accountId).first<{ id: string; last_sequence: number; status: string }>()
  if (!conversation) throw conversationNotFound()
  if (conversation.status === 'closed') {
    await bindSafetyIdempotency(
      db,
      actorScope,
      'conversation_viewer_close',
      idempotencyKey,
      requestHash,
      'conversation',
      conversationId,
      Number(conversation.last_sequence),
      now,
    )
    return { conversationId, replayed: false }
  }
  const nowIso = now.toISOString()
  const messageId = prefixedId('msg')
  const nextSequence = Number(conversation.last_sequence) + 1
  const messageText = '你已关闭本话题。历史消息仍可查看，但本话题不能重新打开。'
  const messageHash = await sha256Hex(messageText)
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_conversation_messages (
        id, conversation_id, sequence, sender_type, client_message_id,
        content_type, body_text, body_sha256, status,
        actor_account_id, actor_admin_id, created_at, recalled_at
      )
      SELECT ?, id, ?, 'system', ?, 'system', ?, ?, 'accepted', NULL, NULL, ?, NULL
      FROM app_conversations
      WHERE id = ? AND account_id = ? AND status <> 'closed' AND last_sequence = ?
    `).bind(
      messageId,
      nextSequence,
      `system.viewer_close.${nextSequence}`,
      messageText,
      messageHash,
      nowIso,
      conversationId,
      accountId,
      conversation.last_sequence,
    ),
    db.prepare(`
      UPDATE app_conversations
      SET status = 'closed', queue_status = 'closed', last_sequence = ?,
          last_message_at = ?, updated_at = ?, closed_at = ?,
          closed_reason_code = 'viewer_closed', closed_by_type = 'viewer'
      WHERE id = ? AND account_id = ?
        AND EXISTS (SELECT 1 FROM app_conversation_messages WHERE id = ?)
    `).bind(nextSequence, nowIso, nowIso, nowIso, conversationId, accountId, messageId),
  ]
  await appendSystemAssignmentRelease(db, statements, conversationId, 'viewer_closed', now, messageId)
  statements.push(db.prepare(`
    INSERT INTO app_safety_idempotency (
      actor_scope, operation, idempotency_key, request_hash,
      result_type, result_id, result_version, created_at
    )
    SELECT ?, 'conversation_viewer_close', ?, ?, 'conversation',
           conversation_id, sequence, ?
    FROM app_conversation_messages
    WHERE id = ? AND conversation_id = ?
  `).bind(
    actorScope,
    idempotencyKey,
    requestHash,
    nowIso,
    messageId,
    conversationId,
  ))
  try {
    await db.batch(statements)
  }
  catch {
    const concurrent = await findSafetyIdempotency(
      db,
      actorScope,
      'conversation_viewer_close',
      idempotencyKey,
    )
    if (concurrent) {
      assertIdempotencyHash(concurrent, requestHash)
      return { conversationId: concurrent.result_id, replayed: true }
    }
    throw new AppSafetyError(409, 'CONVERSATION_CLOSE_CONFLICT', '话题状态已变化，请刷新后重试', true)
  }
  const closed = await db.prepare(`
    SELECT status, last_sequence FROM app_conversations
    WHERE id = ? AND account_id = ?
  `).bind(conversationId, accountId).first<{ status: string; last_sequence: number }>()
  if (closed?.status !== 'closed' || Number(closed.last_sequence) !== nextSequence) {
    throw new AppSafetyError(409, 'CONVERSATION_CLOSE_CONFLICT', '话题状态已变化，请刷新后重试', true)
  }
  const stored = await findSafetyIdempotency(
    db,
    actorScope,
    'conversation_viewer_close',
    idempotencyKey,
  )
  if (!stored) {
    throw new AppSafetyError(409, 'CONVERSATION_CLOSE_CONFLICT', '话题状态已变化，请刷新后重试', true)
  }
  return { conversationId, replayed: false }
}

export async function isAppProfileBlocked(
  db: D1Database,
  accountId: number,
  profileId: string,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS blocked
    FROM app_profile_blocks
    WHERE account_id = ? AND profile_id = ? AND state = 'blocked'
    LIMIT 1
  `).bind(accountId, profileId).first<{ blocked: number }>()
  return row?.blocked === 1
}

export async function getAppMessagingRuntimeControl(
  db: D1Database,
): Promise<AppMessagingRuntimeControl> {
  const row = await db.prepare(`
    SELECT control.new_conversations_paused, control.viewer_sends_paused,
           control.operator_sends_paused, control.emergency_reason_code,
           control.user_visible_message, control.max_open_conversations,
           control.max_active_assignments_per_operator,
           control.assignment_lease_minutes, control.retention_policy_id,
           control.version, control.updated_at,
           retention.decision_status AS retention_decision_status,
           retention.production_ready AS retention_production_ready,
           retention.purge_enabled
    FROM app_messaging_runtime_controls control
    JOIN app_safety_retention_policies retention
      ON retention.id = control.retention_policy_id
    WHERE control.scope = 'global'
    LIMIT 1
  `).first<{
    new_conversations_paused: number
    viewer_sends_paused: number
    operator_sends_paused: number
    emergency_reason_code: string | null
    user_visible_message: string
    max_open_conversations: number
    max_active_assignments_per_operator: number
    assignment_lease_minutes: number
    retention_policy_id: string
    version: number
    updated_at: string
    retention_decision_status: string
    retention_production_ready: number
    purge_enabled: number
  }>()
  if (!row) {
    throw new AppSafetyError(503, 'SAFETY_CONTROL_NOT_READY', '安全运行控制尚未完成配置')
  }
  return {
    newConversationsPaused: row.new_conversations_paused === 1,
    viewerSendsPaused: row.viewer_sends_paused === 1,
    operatorSendsPaused: row.operator_sends_paused === 1,
    emergencyReasonCode: row.emergency_reason_code,
    userVisibleMessage: row.user_visible_message,
    maxOpenConversations: Number(row.max_open_conversations),
    maxActiveAssignmentsPerOperator: Number(row.max_active_assignments_per_operator),
    assignmentLeaseMinutes: Number(row.assignment_lease_minutes),
    retentionPolicyId: row.retention_policy_id,
    retentionDecisionStatus: row.retention_decision_status === 'approved' ? 'approved' : 'unresolved',
    retentionProductionReady: row.retention_production_ready === 1,
    purgeEnabled: row.purge_enabled === 1,
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}

async function appendSystemAssignmentRelease(
  db: D1Database,
  statements: D1PreparedStatement[],
  conversationId: string,
  reasonCode: string,
  now: Date,
  prerequisiteMessageId: string,
) {
  const assignment = await db.prepare(`
    SELECT assigned_admin_id, version
    FROM app_conversation_assignment_state
    WHERE conversation_id = ? AND status = 'active'
    LIMIT 1
  `).bind(conversationId).first<{ assigned_admin_id: number; version: number }>()
  if (!assignment) return
  const nextVersion = Number(assignment.version) + 1
  const nowIso = now.toISOString()
  const mutationToken = crypto.randomUUID()
  statements.push(db.prepare(`
    UPDATE app_conversation_assignment_state
    SET assigned_admin_id = NULL, status = 'released', version = ?,
        lease_expires_at = NULL, mutation_token = ?, released_at = ?, updated_at = ?
    WHERE conversation_id = ? AND status = 'active' AND version = ?
      AND EXISTS (
        SELECT 1 FROM app_conversation_messages message
        WHERE message.id = ? AND message.conversation_id = ?
      )
  `).bind(
    nextVersion,
    mutationToken,
    nowIso,
    nowIso,
    conversationId,
    assignment.version,
    prerequisiteMessageId,
    conversationId,
  ))
  statements.push(db.prepare(`
    INSERT INTO app_conversation_assignment_events (
      id, conversation_id, version, event_type, subject_admin_id,
      actor_type, actor_admin_id, reason_code, lease_expires_at, created_at
    )
    SELECT ?, conversation_id, version, 'released', ?, 'system', NULL, ?, NULL, ?
    FROM app_conversation_assignment_state
    WHERE conversation_id = ? AND version = ? AND mutation_token = ? AND status = 'released'
  `).bind(
    prefixedId('cae'),
    assignment.assigned_admin_id,
    reasonCode,
    nowIso,
    conversationId,
    nextVersion,
    mutationToken,
  ))
}

async function resolveReportTarget(
  db: D1Database,
  accountId: number,
  target: AppSafetyReportTarget,
): Promise<ReportTargetContext> {
  if (target.type === 'person_profile') {
    const profile = await profileVersionContext(db, target.profileId)
    return emptyTargetContext(target, profile)
  }
  if (target.type === 'media') {
    const row = await db.prepare(`
      SELECT profile.content_version,
             projection.projection_version
      FROM person_profiles profile
      JOIN media_assets media ON media.gallery_id = profile.source_gallery_id
      LEFT JOIN profile_public_projections projection ON projection.profile_id = profile.id
      WHERE profile.id = ? AND media.id = ?
      LIMIT 1
    `).bind(target.profileId, target.mediaId).first<{
      content_version: number
      projection_version: number | null
    }>()
    if (!row) throw new AppSafetyError(404, 'REPORT_TARGET_NOT_FOUND', '举报目标不存在或当前不可访问')
    return emptyTargetContext(target, {
      contentVersion: Number(row.content_version),
      projectionVersion: row.projection_version == null ? null : Number(row.projection_version),
    })
  }
  const conversation = await db.prepare(`
    SELECT profile.content_version, projection.projection_version
    FROM app_conversations conversation
    JOIN person_profiles profile ON profile.id = conversation.profile_id
    LEFT JOIN profile_public_projections projection ON projection.profile_id = profile.id
    WHERE conversation.id = ? AND conversation.account_id = ? AND conversation.profile_id = ?
    LIMIT 1
  `).bind(target.conversationId, accountId, target.profileId).first<{
    content_version: number
    projection_version: number | null
  }>()
  if (!conversation) throw new AppSafetyError(404, 'REPORT_TARGET_NOT_FOUND', '举报目标不存在或当前不可访问')
  const versions = {
    contentVersion: Number(conversation.content_version),
    projectionVersion: conversation.projection_version == null
      ? null
      : Number(conversation.projection_version),
  }
  if (target.type === 'conversation') return emptyTargetContext(target, versions)
  const message = await db.prepare(`
    SELECT target.sequence, target.sender_type, target.body_sha256,
      (SELECT id FROM app_conversation_messages before_message
       WHERE before_message.conversation_id = target.conversation_id
         AND before_message.sequence = target.sequence - 1
         AND before_message.status <> 'recalled'
       LIMIT 1) AS before_message_id,
      (SELECT id FROM app_conversation_messages after_message
       WHERE after_message.conversation_id = target.conversation_id
         AND after_message.sequence = target.sequence + 1
         AND after_message.status <> 'recalled'
       LIMIT 1) AS after_message_id
    FROM app_conversation_messages target
    WHERE target.id = ? AND target.conversation_id = ?
    LIMIT 1
  `).bind(target.messageId, target.conversationId).first<{
    sequence: number
    sender_type: string
    body_sha256: string
    before_message_id: string | null
    after_message_id: string | null
  }>()
  if (!message) throw new AppSafetyError(404, 'REPORT_TARGET_NOT_FOUND', '举报目标不存在或当前不可访问')
  return {
    target,
    profileContentVersion: versions.contentVersion,
    profileProjectionVersion: versions.projectionVersion,
    messageSequence: Number(message.sequence),
    messageSenderType: message.sender_type,
    messageBodySha256: message.body_sha256,
    contextBeforeMessageId: message.before_message_id,
    contextAfterMessageId: message.after_message_id,
  }
}

async function profileVersionContext(db: D1Database, profileId: string) {
  const row = await db.prepare(`
    SELECT profile.content_version, projection.projection_version
    FROM person_profiles profile
    LEFT JOIN profile_public_projections projection ON projection.profile_id = profile.id
    WHERE profile.id = ?
    LIMIT 1
  `).bind(profileId).first<{ content_version: number; projection_version: number | null }>()
  if (!row) throw new AppSafetyError(404, 'REPORT_TARGET_NOT_FOUND', '举报目标不存在或当前不可访问')
  return {
    contentVersion: Number(row.content_version),
    projectionVersion: row.projection_version == null ? null : Number(row.projection_version),
  }
}

function emptyTargetContext(
  target: AppSafetyReportTarget,
  versions: { contentVersion: number; projectionVersion: number | null },
): ReportTargetContext {
  return {
    target,
    profileContentVersion: versions.contentVersion,
    profileProjectionVersion: versions.projectionVersion,
    messageSequence: null,
    messageSenderType: null,
    messageBodySha256: null,
    contextBeforeMessageId: null,
    contextAfterMessageId: null,
  }
}

async function requireReasonCatalog(
  db: D1Database,
  catalogId: string,
  reasonCode: string,
  requireProductionReady: boolean,
) {
  const row = await db.prepare(`
    SELECT definition.default_priority, catalog.retention_policy_id,
           catalog.state, catalog.production_ready,
           retention.decision_status, retention.production_ready AS retention_ready
    FROM app_safety_reason_catalogs catalog
    JOIN app_safety_reason_definitions definition ON definition.catalog_id = catalog.id
    JOIN app_safety_retention_policies retention ON retention.id = catalog.retention_policy_id
    WHERE catalog.id = ? AND definition.reason_code = ? AND definition.user_visible = 1
    LIMIT 1
  `).bind(catalogId, reasonCode).first<{
    default_priority: string
    retention_policy_id: string
    state: string
    production_ready: number
    decision_status: string
    retention_ready: number
  }>()
  if (!row) throw new AppSafetyError(400, 'REPORT_REASON_INVALID', '举报原因不在当前目录中')
  if (
    requireProductionReady
    && (
      row.state !== 'published'
      || row.production_ready !== 1
      || row.decision_status !== 'approved'
      || row.retention_ready !== 1
    )
  ) {
    throw new AppSafetyError(503, 'SAFETY_POLICY_NOT_READY', '举报与保留策略尚未完成生产发布')
  }
  return {
    priority: normalizePriority(row.default_priority),
    retentionPolicyId: row.retention_policy_id,
  }
}

async function requireReportCapacity(db: D1Database, accountId: number, now: Date) {
  const boundary = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_safety_reports
    WHERE account_id = ? AND submitted_at >= ?
  `).bind(accountId, boundary).first<{ count: number }>()
  if (Number(row?.count ?? 0) >= REPORTS_PER_DAY) {
    throw new AppSafetyError(429, 'REPORT_RATE_LIMITED', '举报提交较为频繁，请稍后再试', true)
  }
}

async function requireExistingProfile(db: D1Database, profileId: string) {
  const row = await db.prepare('SELECT id FROM person_profiles WHERE id = ? LIMIT 1')
    .bind(profileId).first<{ id: string }>()
  if (!row) throw new AppSafetyError(404, 'PROFILE_NOT_AVAILABLE', '人物资料不存在或当前不可操作')
}

async function findBlock(db: D1Database, accountId: number, profileId: string) {
  return db.prepare(`
    SELECT profile_id, state, version, mutation_token, blocked_at, updated_at
    FROM app_profile_blocks
    WHERE account_id = ? AND profile_id = ?
    LIMIT 1
  `).bind(accountId, profileId).first<BlockRow>()
}

function mapBlockState(profileId: string, row: BlockRow | null): AppProfileBlockState {
  const blocked = row?.state === 'blocked'
  return {
    profileId,
    blocked,
    version: Number(row?.version ?? 0),
    blockedAt: blocked ? row!.blocked_at : null,
    updatedAt: row?.updated_at ?? null,
  }
}

const REPORT_SELECT = `
  SELECT report.id, report.target_type, report.profile_id, report.media_id,
         report.conversation_id, report.message_id, report.reason_code,
         reason.display_label AS reason_label, report.description_text,
         report.user_visible_status, report.user_visible_message,
         report.submitted_at, report.updated_at
  FROM app_safety_reports report
  JOIN app_safety_reason_definitions reason
    ON reason.catalog_id = report.reason_catalog_id
   AND reason.reason_code = report.reason_code
`

function mapReportSummary(row: ReportRow): AppSafetyReportSummary {
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
    status: normalizeVisibleReportStatus(row.user_visible_status),
    userVisibleMessage: row.user_visible_message,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  }
}

function normalizeReportTargetInput(input: CreateAppSafetyReportInput): AppSafetyReportTarget {
  const type = normalizeTargetType(input.targetType)
  const profileId = normalizeProfileId(input.profileId)
  const mediaId = input.mediaId == null ? null : normalizeMediaId(input.mediaId)
  const conversationId = input.conversationId == null
    ? null
    : normalizeConversationId(String(input.conversationId))
  const messageId = input.messageId == null ? null : normalizeMessageId(input.messageId)
  const valid = (type === 'person_profile' && !mediaId && !conversationId && !messageId)
    || (type === 'media' && Boolean(mediaId) && !conversationId && !messageId)
    || (type === 'conversation' && !mediaId && Boolean(conversationId) && !messageId)
    || (type === 'message' && !mediaId && Boolean(conversationId) && Boolean(messageId))
  if (!valid) {
    throw new AppSafetyError(400, 'REPORT_TARGET_INVALID', '举报目标字段与目标类型不一致')
  }
  return { type, profileId, mediaId, conversationId, messageId }
}

function normalizeTargetType(value: unknown): AppSafetyReportTargetType {
  if (typeof value !== 'string' || !APP_SAFETY_REPORT_TARGETS.includes(value as AppSafetyReportTargetType)) {
    throw new AppSafetyError(400, 'REPORT_TARGET_INVALID', '举报目标类型不受支持')
  }
  return value as AppSafetyReportTargetType
}

function normalizeVisibleReportStatus(value: string): AppSafetyReportStatus {
  if (value === 'processing' || value === 'actioned' || value === 'no_violation' || value === 'closed') {
    return value
  }
  return 'submitted'
}

function normalizePriority(value: string): 'p0' | 'p1' | 'p2' | 'p3' {
  if (value === 'p0' || value === 'p1' || value === 'p2') return value
  return 'p3'
}

function normalizeReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value)) {
    throw new AppSafetyError(400, 'REPORT_REASON_INVALID', '举报原因不在当前目录中')
  }
  return value
}

function normalizeDescription(value: unknown): string {
  if (value == null) return ''
  if (typeof value !== 'string') {
    throw new AppSafetyError(400, 'REPORT_DESCRIPTION_INVALID', '补充说明必须为文本')
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (normalized.length > APP_SAFETY_MAX_DESCRIPTION_LENGTH || hasControlCharacter(normalized)) {
    throw new AppSafetyError(
      400,
      'REPORT_DESCRIPTION_INVALID',
      `补充说明不能超过 ${APP_SAFETY_MAX_DESCRIPTION_LENGTH} 个字符且不能包含控制字符`,
    )
  }
  return normalized
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
  })
}

function normalizeProfileId(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new AppSafetyError(400, 'PROFILE_ID_INVALID', '人物资料标识无效')
  }
  return value
}

function normalizeMediaId(value: unknown): string {
  if (typeof value !== 'string' || !MEDIA_ID_PATTERN.test(value)) {
    throw new AppSafetyError(400, 'MEDIA_ID_INVALID', '媒体标识无效')
  }
  return value
}

function normalizeConversationId(value: string): string {
  if (!CONVERSATION_ID_PATTERN.test(value)) throw conversationNotFound()
  return value
}

function normalizeMessageId(value: unknown): string {
  if (typeof value !== 'string' || !MESSAGE_ID_PATTERN.test(value)) {
    throw new AppSafetyError(400, 'MESSAGE_ID_INVALID', '消息标识无效')
  }
  return value
}

function normalizeReportId(value: string): string {
  if (!/^rpt_[A-Za-z0-9_-]{1,76}$/u.test(value)) throw reportNotFound()
  return value
}

function normalizePolicyVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return POLICY_VERSION_PATTERN.test(normalized) ? normalized : null
}

function normalizeIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AppSafetyError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 必须为 16 至 128 个可见 ASCII 字符')
  }
  return normalized
}

async function findSafetyIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT request_hash, result_type, result_id, result_version
    FROM app_safety_idempotency
    WHERE actor_scope = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(actorScope, operation, idempotencyKey).first<SafetyIdempotencyRow>()
}

async function bindSafetyIdempotency(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  resultType: string,
  resultId: string,
  resultVersion: number,
  now: Date,
) {
  try {
    await safetyIdempotencyStatement(
      db,
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
    if (!existing) throw new AppSafetyError(503, 'SAFETY_WRITE_FAILED', '安全操作暂时无法完成', true)
    assertIdempotencyHash(existing, requestHash)
  }
}

function safetyIdempotencyStatement(
  db: D1Database,
  actorScope: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  resultType: string,
  resultId: string,
  resultVersion: number,
  nowIso: string,
) {
  return db.prepare(`
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
    nowIso,
  )
}

function assertIdempotencyHash(row: SafetyIdempotencyRow, requestHash: string) {
  if (row.request_hash !== requestHash) {
    throw new AppSafetyError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同安全操作')
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value))
}

function prefixedId(prefix: 'ble' | 'rpt' | 'rpe' | 'msg' | 'cae') {
  return `${prefix}_${crypto.randomUUID().replace(/-/gu, '')}`
}

function viewerScope(accountId: number) {
  return `viewer:${accountId}`
}

function listLimit(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIST_SIZE) : DEFAULT_LIST_SIZE
}

function encodeCursor(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeCursor(value: string): unknown {
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  }
  catch {
    throw new AppSafetyError(400, 'INVALID_CURSOR', '分页游标无效')
  }
}

function isBlockCursor(value: unknown): value is NonNullable<AppBlockListQuery['cursor']> {
  if (!value || typeof value !== 'object') return false
  const cursor = value as Record<string, unknown>
  return cursor.v === 1
    && typeof cursor.accountScope === 'string'
    && typeof cursor.updatedAt === 'string'
    && typeof cursor.profileId === 'string'
    && PROFILE_ID_PATTERN.test(cursor.profileId)
}

function isReportCursor(value: unknown): value is NonNullable<AppReportListQuery['cursor']> {
  if (!value || typeof value !== 'object') return false
  const cursor = value as Record<string, unknown>
  return cursor.v === 1
    && typeof cursor.accountScope === 'string'
    && typeof cursor.submittedAt === 'string'
    && typeof cursor.reportId === 'string'
    && /^rpt_[A-Za-z0-9_-]{1,76}$/u.test(cursor.reportId)
}

function reportNotFound() {
  return new AppSafetyError(404, 'REPORT_NOT_FOUND', '举报记录不存在或不属于当前账号')
}

function conversationNotFound() {
  return new AppSafetyError(404, 'CONVERSATION_NOT_FOUND', '平台话题不存在或不属于当前账号')
}
