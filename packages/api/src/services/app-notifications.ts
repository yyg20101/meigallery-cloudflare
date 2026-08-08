import type {
  AppNotificationAction,
  AppNotificationCategory,
  AppNotificationDetail,
  AppNotificationPreferences,
  AppNotificationReadAllResult,
  AppNotificationReadResult,
  AppNotificationState,
  AppNotificationSummary,
  AppNotificationTarget,
  AppNotificationTargetType,
  AppNotificationUnreadCounts,
} from '@meigallery/shared'
import type { Bindings } from '../index'

export const APP_NOTIFICATION_POLICY_ID = 'ntp_app_1_0_message_3_dev_1'
export const APP_NOTIFICATION_MAX_PAGE_SIZE = 40
export const APP_NOTIFICATION_CATEGORIES: Array<{
  code: AppNotificationCategory
  label: string
  preference: 'optional' | 'required'
}> = [
  { code: 'message', label: '消息', preference: 'optional' },
  { code: 'interaction', label: '互动', preference: 'optional' },
  { code: 'membership_coin', label: '会员与金币', preference: 'required' },
  { code: 'system_security', label: '系统与安全', preference: 'required' },
  { code: 'marketing', label: '活动', preference: 'optional' },
]

const NOTIFICATION_CATEGORIES = new Set<AppNotificationCategory>(
  APP_NOTIFICATION_CATEGORIES.map(item => item.code),
)
const DEFAULT_PAGE_SIZE = 20
const MAX_DELIVERY_ATTEMPTS = 5
const PROCESSING_LEASE_MILLISECONDS = 5 * 60 * 1000

export interface AppNotificationRuntimeConfig {
  enabled: boolean
  adminEnabled: boolean
  policyId: string
  requireProductionReady: boolean
}

export interface AppNotificationTargetCapabilities {
  messaging: boolean
  profiles: boolean
  membership: boolean
  membershipApplications: boolean
  safetyReports: boolean
  safetyAppeals: boolean
  accountSecurity: boolean
  wallet: boolean
}

export interface AppNotificationListQuery {
  category: AppNotificationCategory | null
  limit: number
  cursor: null | {
    v: 1
    accountScope: string
    category: AppNotificationCategory | null
    createdAt: string
    notificationId: string
  }
}

export interface UpdateAppNotificationPreferencesInput {
  expectedVersion?: unknown
  message?: unknown
  interaction?: unknown
  marketing?: unknown
}

export class AppNotificationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'AppNotificationError'
  }
}

type PolicyRow = {
  id: string
  state: string
  production_ready: number
  generation_enabled: number
  decision_status: string
  retention_days: number | null
  effective_at: string | null
}

type OutboxDeliveryRow = {
  outbox_id: string
  created_at: string
  account_id: number
  event_type: string
  target_type: string
  target_id: string
  attempts: number
  category: string
  necessity: string
  preference_key: string | null
  action: string
  minimum_client_version: string
  template_id: string
  template_version_code: string
  title_text: string
  summary_text: string
  body_text: string
}

type NotificationRow = {
  id: string
  category: string
  event_type: string
  template_version_code: string
  title_text: string
  summary_text: string
  body_text: string
  target_type: string
  target_id: string
  action: string
  minimum_client_version: string
  status: string
  created_at: string
  expires_at: string | null
  read_at: string | null
}

type PreferenceRow = {
  policy_id: string
  message_enabled: number
  interaction_enabled: number
  marketing_enabled: number
  version: number
  updated_at: string
}

export function getAppNotificationRuntimeConfig(env: Pick<Bindings,
  | 'APP_ENV'
  | 'APP_NOTIFICATIONS_ENABLED'
  | 'APP_NOTIFICATIONS_ADMIN_ENABLED'
  | 'APP_NOTIFICATIONS_POLICY_VERSION'
  | 'APP_NOTIFICATIONS_PRODUCTION_READY'
>): AppNotificationRuntimeConfig {
  const requireProductionReady = env.APP_ENV === 'production'
  const policyId = normalizePolicyId(env.APP_NOTIFICATIONS_POLICY_VERSION)
    ?? APP_NOTIFICATION_POLICY_ID
  const configuredPolicy = normalizePolicyId(env.APP_NOTIFICATIONS_POLICY_VERSION)
  const productionGateSatisfied = !requireProductionReady
    || env.APP_NOTIFICATIONS_PRODUCTION_READY === 'true'

  return {
    enabled: env.APP_NOTIFICATIONS_ENABLED === 'true'
      && Boolean(configuredPolicy)
      && productionGateSatisfied,
    adminEnabled: env.APP_NOTIFICATIONS_ADMIN_ENABLED === 'true'
      && Boolean(configuredPolicy)
      && productionGateSatisfied,
    policyId,
    requireProductionReady,
  }
}

export function requireAppNotificationsEnabled(
  config: AppNotificationRuntimeConfig,
): void {
  if (!config.enabled) {
    throw new AppNotificationError(403, 'FEATURE_DISABLED', '站内通知尚未开放')
  }
}

export function requireAppNotificationsAdminEnabled(
  config: AppNotificationRuntimeConfig,
): void {
  if (!config.adminEnabled) {
    throw new AppNotificationError(403, 'FEATURE_DISABLED', 'App 通知管理能力尚未开放')
  }
}

export function parseAppNotificationListQuery(input: {
  category?: string
  limit?: string
  cursor?: string
  accountScope: string
}): AppNotificationListQuery {
  const category = normalizeCategory(input.category)
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, APP_NOTIFICATION_MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
  const cursor = input.cursor
    ? decodeCursor(input.cursor, input.accountScope, category)
    : null
  return { category, limit, cursor }
}

export async function listAppNotifications(
  db: D1Database,
  accountId: number,
  accountScope: string,
  config: AppNotificationRuntimeConfig,
  capabilities: AppNotificationTargetCapabilities,
  query: AppNotificationListQuery,
  now = new Date(),
): Promise<{ data: AppNotificationSummary[]; nextCursor: string | null; hasMore: boolean }> {
  await prepareViewerNotifications(db, accountId, config, now)
  const conditions = ['account_id = ?']
  const bindings: unknown[] = [accountId]
  if (query.category) {
    conditions.push('category = ?')
    bindings.push(query.category)
  }
  if (query.cursor) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))')
    bindings.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.notificationId)
  }

  const result = await db.prepare(`
    SELECT id, category, event_type, template_version_code, title_text, summary_text,
           body_text, target_type, target_id, action, minimum_client_version,
           status, created_at, expires_at, read_at
    FROM app_notifications
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(...bindings, query.limit + 1).all<NotificationRow>()

  const hasMore = result.results.length > query.limit
  const rows = result.results.slice(0, query.limit)
  const data = await Promise.all(rows.map(row => toNotificationSummary(
    db,
    accountId,
    row,
    capabilities,
    now,
  )))
  const last = rows.at(-1)
  return {
    data,
    hasMore,
    nextCursor: hasMore && last
      ? encodeCursor({
          v: 1,
          accountScope,
          category: query.category,
          createdAt: last.created_at,
          notificationId: last.id,
        })
      : null,
  }
}

export async function getAppNotification(
  db: D1Database,
  accountId: number,
  notificationId: string,
  config: AppNotificationRuntimeConfig,
  capabilities: AppNotificationTargetCapabilities,
  now = new Date(),
): Promise<AppNotificationDetail> {
  validateNotificationId(notificationId)
  await prepareViewerNotifications(db, accountId, config, now)
  const row = await findNotification(db, accountId, notificationId)
  if (!row) throw notificationNotFound()
  return {
    ...await toNotificationSummary(db, accountId, row, capabilities, now),
    body: row.body_text,
    templateVersion: row.template_version_code,
    minimumClientVersion: row.minimum_client_version,
  }
}

export async function getAppNotificationUnreadCounts(
  db: D1Database,
  accountId: number,
  config: AppNotificationRuntimeConfig,
  now = new Date(),
): Promise<AppNotificationUnreadCounts> {
  await prepareViewerNotifications(db, accountId, config, now)
  const result = await db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM app_notifications
    WHERE account_id = ?
      AND status = 'available'
      AND read_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    GROUP BY category
  `).bind(accountId, now.toISOString()).all<{ category: string; count: number }>()
  const categories: Record<AppNotificationCategory, number> = {
    message: 0,
    interaction: 0,
    membership_coin: 0,
    system_security: 0,
    marketing: 0,
  }
  for (const row of result.results) {
    if (isNotificationCategory(row.category)) categories[row.category] = Number(row.count)
  }
  return {
    total: Object.values(categories).reduce((sum, count) => sum + count, 0),
    categories,
    generatedAt: now.toISOString(),
  }
}

export async function markAppNotificationRead(
  db: D1Database,
  accountId: number,
  notificationId: string,
  config: AppNotificationRuntimeConfig,
  audit: { deviceId: string; requestId: string },
  now = new Date(),
): Promise<AppNotificationReadResult> {
  validateNotificationId(notificationId)
  await prepareViewerNotifications(db, accountId, config, now)
  const current = await findNotification(db, accountId, notificationId)
  if (!current) throw notificationNotFound()
  const requestedReadAt = now.toISOString()
  const readEventId = randomId('nre')
  await db.batch([
    db.prepare(`
      INSERT INTO app_notification_read_events (
        id, account_id, operation, notification_id, category, device_id,
        request_id, marked_count, created_at
      )
      SELECT ?, ?, 'single', id, NULL, ?, ?,
             CASE WHEN read_at IS NULL THEN 1 ELSE 0 END, ?
      FROM app_notifications
      WHERE id = ? AND account_id = ?
    `).bind(
      readEventId,
      accountId,
      audit.deviceId,
      audit.requestId,
      requestedReadAt,
      notificationId,
      accountId,
    ),
    db.prepare(`
      UPDATE app_notifications
      SET read_at = COALESCE(read_at, ?)
      WHERE id = ? AND account_id = ?
    `).bind(requestedReadAt, notificationId, accountId),
  ])
  const [updated, event] = await Promise.all([
    findNotification(db, accountId, notificationId),
    db.prepare(`
      SELECT marked_count FROM app_notification_read_events WHERE id = ?
    `).bind(readEventId).first<{ marked_count: number }>(),
  ])
  if (!updated || !updated.read_at || !event) {
    throw new AppNotificationError(503, 'NOTIFICATION_READ_UNAVAILABLE', '通知已读状态暂不可用', true)
  }
  return {
    notificationId,
    state: deriveNotificationState(updated, now),
    readAt: updated.read_at,
    replayed: Number(event.marked_count) === 0,
  }
}

export async function markAppNotificationsReadAll(
  db: D1Database,
  accountId: number,
  categoryValue: unknown,
  config: AppNotificationRuntimeConfig,
  audit: { deviceId: string; requestId: string },
  now = new Date(),
): Promise<AppNotificationReadAllResult> {
  const category = requireCategory(categoryValue)
  await prepareViewerNotifications(db, accountId, config, now)
  const readAt = now.toISOString()
  const readEventId = randomId('nre')
  await db.batch([
    db.prepare(`
      INSERT INTO app_notification_read_events (
        id, account_id, operation, notification_id, category, device_id,
        request_id, marked_count, created_at
      ) VALUES (
        ?, ?, 'category_all', NULL, ?, ?, ?,
        (
          SELECT COUNT(*)
          FROM app_notifications
          WHERE account_id = ?
            AND category = ?
            AND status = 'available'
            AND read_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
        ),
        ?
      )
    `).bind(
      readEventId,
      accountId,
      category,
      audit.deviceId,
      audit.requestId,
      accountId,
      category,
      readAt,
      readAt,
    ),
    db.prepare(`
      UPDATE app_notifications
      SET read_at = ?
      WHERE account_id = ?
        AND category = ?
        AND status = 'available'
        AND read_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `).bind(readAt, accountId, category, readAt),
  ])
  const event = await db.prepare(`
    SELECT marked_count FROM app_notification_read_events WHERE id = ?
  `).bind(readEventId).first<{ marked_count: number }>()
  if (!event) {
    throw new AppNotificationError(503, 'NOTIFICATION_READ_UNAVAILABLE', '通知已读状态暂不可用', true)
  }
  const markedCount = Number(event.marked_count)
  return { category, markedCount, readAt }
}

export async function getAppNotificationPreferences(
  db: D1Database,
  accountId: number,
  config: AppNotificationRuntimeConfig,
  now = new Date(),
): Promise<AppNotificationPreferences> {
  requireAppNotificationsEnabled(config)
  await requireNotificationPolicy(db, config)
  await ensurePreferenceRow(db, accountId, config.policyId, now)
  const row = await readPreferenceRow(db, accountId)
  if (!row) throw new AppNotificationError(503, 'NOTIFICATION_PREFERENCES_UNAVAILABLE', '通知偏好暂不可用', true)
  return toPreferences(row)
}

export async function updateAppNotificationPreferences(
  db: D1Database,
  accountId: number,
  input: UpdateAppNotificationPreferencesInput,
  config: AppNotificationRuntimeConfig,
  audit: { deviceId: string; requestId: string },
  now = new Date(),
): Promise<AppNotificationPreferences> {
  const expectedVersion = requirePositiveInteger(input.expectedVersion, 'expectedVersion')
  const message = requireBoolean(input.message, 'message')
  const interaction = requireBoolean(input.interaction, 'interaction')
  const marketing = requireBoolean(input.marketing, 'marketing')
  requireAppNotificationsEnabled(config)
  await requireNotificationPolicy(db, config)
  await ensurePreferenceRow(db, accountId, config.policyId, now)
  const current = await readPreferenceRow(db, accountId)
  if (!current) throw new AppNotificationError(503, 'NOTIFICATION_PREFERENCES_UNAVAILABLE', '通知偏好暂不可用', true)
  if (current.version !== expectedVersion) {
    throw new AppNotificationError(409, 'VERSION_CONFLICT', '通知偏好已在其他设备更新，请刷新后重试')
  }

  const nextVersion = expectedVersion + 1
  const updatedAt = now.toISOString()
  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE app_notification_preferences
        SET message_enabled = ?, interaction_enabled = ?, marketing_enabled = ?,
            version = ?, updated_at = ?
        WHERE account_id = ? AND policy_id = ? AND version = ?
      `).bind(
        message ? 1 : 0,
        interaction ? 1 : 0,
        marketing ? 1 : 0,
        nextVersion,
        updatedAt,
        accountId,
        config.policyId,
        expectedVersion,
      ),
      db.prepare(`
        INSERT INTO app_notification_preference_events (
          id, account_id, policy_id, version, message_enabled, interaction_enabled,
          marketing_enabled, device_id, request_id, created_at
        )
        SELECT ?, account_id, policy_id, version, message_enabled, interaction_enabled,
               marketing_enabled, ?, ?, ?
        FROM app_notification_preferences
        WHERE account_id = ? AND policy_id = ? AND version = ?
      `).bind(
        randomId('npe'),
        audit.deviceId,
        audit.requestId,
        updatedAt,
        accountId,
        config.policyId,
        nextVersion,
      ),
    ])
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      throw new AppNotificationError(409, 'VERSION_CONFLICT', '通知偏好已在其他设备更新，请刷新后重试')
    }
  }
  catch (error) {
    if (error instanceof AppNotificationError) throw error
    throw new AppNotificationError(409, 'VERSION_CONFLICT', '通知偏好已在其他设备更新，请刷新后重试')
  }

  const updated = await readPreferenceRow(db, accountId)
  if (!updated || updated.version !== nextVersion) {
    throw new AppNotificationError(409, 'VERSION_CONFLICT', '通知偏好已在其他设备更新，请刷新后重试')
  }
  return toPreferences(updated)
}

export async function recoverAppNotifications(
  env: Pick<Bindings,
    | 'DB'
    | 'APP_ENV'
    | 'APP_NOTIFICATIONS_ENABLED'
    | 'APP_NOTIFICATIONS_ADMIN_ENABLED'
    | 'APP_NOTIFICATIONS_POLICY_VERSION'
    | 'APP_NOTIFICATIONS_PRODUCTION_READY'
  >,
  now = new Date(),
  limit = 100,
): Promise<{ skipped: boolean; expiredEnqueued: number; delivered: number; suppressed: number; failed: number }> {
  const config = getAppNotificationRuntimeConfig(env)
  if (!config.enabled) {
    return { skipped: true, expiredEnqueued: 0, delivered: 0, suppressed: 0, failed: 0 }
  }
  const policy = await requireNotificationPolicy(env.DB, config)
  const expiredEnqueued = await enqueueExpiredMembershipNotifications(
    env.DB,
    config.policyId,
    policy.effective_at!,
    now,
  )
  const delivery = await drainAppNotificationOutbox(env.DB, config, now, { limit })
  return { skipped: false, expiredEnqueued, ...delivery }
}

export async function drainAppNotificationOutbox(
  db: D1Database,
  config: AppNotificationRuntimeConfig,
  now = new Date(),
  options: { accountId?: number; limit?: number } = {},
): Promise<{ delivered: number; suppressed: number; failed: number }> {
  await requireNotificationPolicy(db, config)
  const nowIso = now.toISOString()
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MILLISECONDS).toISOString()
  await db.prepare(`
    UPDATE app_notification_outbox
    SET status = 'failed', next_attempt_at = ?, last_error_code = 'PROCESSING_LEASE_EXPIRED', processed_at = NULL
    WHERE policy_id = ? AND status = 'processing' AND processed_at < ?
  `).bind(nowIso, config.policyId, staleBefore).run()

  const conditions = [
    'policy_id = ?',
    "status IN ('pending', 'failed')",
    'next_attempt_at <= ?',
  ]
  const bindings: unknown[] = [config.policyId, nowIso]
  if (options.accountId !== undefined) {
    conditions.push('account_id = ?')
    bindings.push(options.accountId)
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200))
  const pending = await db.prepare(`
    SELECT id
    FROM app_notification_outbox
    WHERE ${conditions.join(' AND ')}
    ORDER BY next_attempt_at ASC, created_at ASC, id ASC
    LIMIT ?
  `).bind(...bindings, limit).all<{ id: string }>()

  let delivered = 0
  let suppressed = 0
  let failed = 0
  for (const pendingRow of pending.results) {
    const claimed = await db.prepare(`
      UPDATE app_notification_outbox
      SET status = 'processing', attempts = attempts + 1, processed_at = ?, last_error_code = NULL
      WHERE id = ? AND policy_id = ?
        AND status IN ('pending', 'failed') AND next_attempt_at <= ?
    `).bind(nowIso, pendingRow.id, config.policyId, nowIso).run()
    if (Number(claimed.meta?.changes ?? 0) !== 1) continue

    try {
      const row = await readOutboxDelivery(db, pendingRow.id, config.requireProductionReady)
      if (!row) throw new Error('NOTIFICATION_DEFINITION_UNAVAILABLE')
      if (row.necessity === 'optional' && row.preference_key) {
        const enabled = await isOptionalCategoryEnabled(
          db,
          row.account_id,
          config.policyId,
          row.preference_key,
          now,
        )
        if (!enabled) {
          await db.prepare(`
            UPDATE app_notification_outbox
            SET status = 'suppressed', processed_at = ?, last_error_code = NULL
            WHERE id = ? AND status = 'processing'
          `).bind(nowIso, row.outbox_id).run()
          suppressed += 1
          continue
        }
      }

      const notificationId = await stableNotificationId(row.outbox_id)
      const copy = await notificationCopyForDelivery(db, row)
      await db.batch([
        db.prepare(`
          INSERT OR IGNORE INTO app_notifications (
            id, outbox_id, account_id, category, event_type, template_version_id,
            template_version_code, title_text, summary_text, body_text, target_type,
            target_id, action, minimum_client_version, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)
        `).bind(
          notificationId,
          row.outbox_id,
          row.account_id,
          row.category,
          row.event_type,
          row.template_id,
          row.template_version_code,
          copy.title,
          copy.summary,
          copy.body,
          row.target_type,
          row.target_id,
          row.action,
          row.minimum_client_version,
          row.created_at,
        ),
        db.prepare(`
          UPDATE app_notification_outbox
          SET status = 'delivered', notification_id = ?, processed_at = ?, last_error_code = NULL
          WHERE id = ? AND status = 'processing'
        `).bind(notificationId, nowIso, row.outbox_id),
      ])
      delivered += 1
    }
    catch {
      failed += 1
      const attemptRow = await db.prepare(`
        SELECT attempts FROM app_notification_outbox WHERE id = ?
      `).bind(pendingRow.id).first<{ attempts: number }>()
      const attempts = Number(attemptRow?.attempts ?? 1)
      const terminal = attempts >= MAX_DELIVERY_ATTEMPTS
      const backoffMinutes = Math.min(2 ** Math.max(0, attempts - 1), 60)
      const nextAttemptAt = new Date(now.getTime() + backoffMinutes * 60 * 1000).toISOString()
      await db.prepare(`
        UPDATE app_notification_outbox
        SET status = ?, next_attempt_at = ?, last_error_code = 'DELIVERY_FAILED', processed_at = ?
        WHERE id = ? AND status = 'processing'
      `).bind(
        terminal ? 'dead_letter' : 'failed',
        nextAttemptAt,
        nowIso,
        pendingRow.id,
      ).run()
    }
  }
  return { delivered, suppressed, failed }
}

async function prepareViewerNotifications(
  db: D1Database,
  accountId: number,
  config: AppNotificationRuntimeConfig,
  now: Date,
) {
  requireAppNotificationsEnabled(config)
  await requireNotificationPolicy(db, config)
  await drainAppNotificationOutbox(db, config, now, { accountId, limit: APP_NOTIFICATION_MAX_PAGE_SIZE })
}

async function requireNotificationPolicy(
  db: D1Database,
  config: AppNotificationRuntimeConfig,
): Promise<PolicyRow> {
  const row = await db.prepare(`
    SELECT id, state, production_ready, generation_enabled, decision_status,
           retention_days, effective_at
    FROM app_notification_policies
    WHERE id = ?
    LIMIT 1
  `).bind(config.policyId).first<PolicyRow>()
  if (!row || row.generation_enabled !== 1 || !row.effective_at) {
    throw new AppNotificationError(503, 'NOTIFICATION_POLICY_NOT_READY', '通知策略尚未准备完成')
  }
  if (
    config.requireProductionReady
    && (
      row.state !== 'published'
      || row.production_ready !== 1
      || row.decision_status !== 'approved'
      || row.retention_days === null
    )
  ) {
    throw new AppNotificationError(503, 'NOTIFICATION_POLICY_NOT_READY', '通知策略尚未通过生产门禁')
  }
  return row
}

async function enqueueExpiredMembershipNotifications(
  db: D1Database,
  policyId: string,
  effectiveAt: string,
  now: Date,
) {
  const nowIso = now.toISOString()
  const result = await db.prepare(`
    INSERT OR IGNORE INTO app_notification_outbox (
      id, policy_id, event_definition_id, account_id, event_type, event_ref,
      target_type, target_id, status, attempts, next_attempt_at, created_at
    )
    SELECT
      'nto_exp_' || grant_row.id,
      policy.id,
      definition.id,
      grant_row.user_id,
      definition.event_type,
      grant_row.id || '.expired',
      definition.target_type,
      grant_row.id,
      'pending',
      0,
      ?,
      grant_row.expires_at
    FROM app_membership_grants grant_row
    JOIN app_notification_policies policy
      ON policy.id = ? AND policy.generation_enabled = 1
    JOIN app_notification_event_definitions definition
      ON definition.policy_id = policy.id
     AND definition.event_type = 'membership.expired'
     AND definition.active = 1
    LEFT JOIN app_membership_grant_revocations revocation
      ON revocation.grant_id = grant_row.id
    WHERE revocation.grant_id IS NULL
      AND grant_row.expires_at >= ?
      AND grant_row.expires_at <= ?
      AND NOT EXISTS (
        SELECT 1
        FROM app_membership_grants active_grant
        LEFT JOIN app_membership_grant_revocations active_revocation
          ON active_revocation.grant_id = active_grant.id
        WHERE active_grant.user_id = grant_row.user_id
          AND active_grant.starts_at <= ?
          AND active_grant.expires_at > ?
          AND active_revocation.grant_id IS NULL
      )
  `).bind(nowIso, policyId, effectiveAt, nowIso, nowIso, nowIso).run()
  return Number(result.meta?.changes ?? 0)
}

async function readOutboxDelivery(
  db: D1Database,
  outboxId: string,
  requireProductionReady: boolean,
) {
  return db.prepare(`
    SELECT outbox.id AS outbox_id, outbox.created_at, outbox.account_id, outbox.event_type,
           outbox.target_type, outbox.target_id, outbox.attempts,
           definition.category, definition.necessity, definition.preference_key,
           definition.action, definition.minimum_client_version,
           template.id AS template_id, template.version_code AS template_version_code,
           template.title_text, template.summary_text, template.body_text
    FROM app_notification_outbox outbox
    JOIN app_notification_event_definitions definition
      ON definition.id = outbox.event_definition_id
     AND definition.policy_id = outbox.policy_id
     AND definition.event_type = outbox.event_type
     AND definition.active = 1
    JOIN app_notification_template_versions template
      ON template.event_definition_id = definition.id
     AND template.locale = 'zh-CN'
     AND template.region_scope = 'all'
     AND template.state IN ('development', 'published')
     AND (? = 0 OR template.state = 'published')
    WHERE outbox.id = ? AND outbox.status = 'processing'
    LIMIT 1
  `).bind(requireProductionReady ? 1 : 0, outboxId).first<OutboxDeliveryRow>()
}

async function isOptionalCategoryEnabled(
  db: D1Database,
  accountId: number,
  policyId: string,
  preferenceKey: string,
  now: Date,
) {
  await ensurePreferenceRow(db, accountId, policyId, now)
  const row = await readPreferenceRow(db, accountId)
  if (!row) return false
  if (preferenceKey === 'message') return row.message_enabled === 1
  if (preferenceKey === 'interaction') return row.interaction_enabled === 1
  if (preferenceKey === 'marketing') return row.marketing_enabled === 1
  return false
}

async function ensurePreferenceRow(
  db: D1Database,
  accountId: number,
  policyId: string,
  now: Date,
) {
  const nowIso = now.toISOString()
  await db.prepare(`
    INSERT OR IGNORE INTO app_notification_preferences (
      account_id, policy_id, message_enabled, interaction_enabled, marketing_enabled,
      version, created_at, updated_at
    ) VALUES (?, ?, 1, 1, 0, 1, ?, ?)
  `).bind(accountId, policyId, nowIso, nowIso).run()
}

function readPreferenceRow(db: D1Database, accountId: number) {
  return db.prepare(`
    SELECT policy_id, message_enabled, interaction_enabled, marketing_enabled,
           version, updated_at
    FROM app_notification_preferences
    WHERE account_id = ?
    LIMIT 1
  `).bind(accountId).first<PreferenceRow>()
}

function toPreferences(row: PreferenceRow): AppNotificationPreferences {
  return {
    policyId: row.policy_id,
    version: Number(row.version),
    optional: {
      message: row.message_enabled === 1,
      interaction: row.interaction_enabled === 1,
      marketing: row.marketing_enabled === 1,
    },
    required: {
      membershipCoin: true,
      systemSecurity: true,
    },
    updatedAt: row.updated_at,
  }
}

function findNotification(db: D1Database, accountId: number, notificationId: string) {
  return db.prepare(`
    SELECT id, category, event_type, template_version_code, title_text, summary_text,
           body_text, target_type, target_id, action, minimum_client_version,
           status, created_at, expires_at, read_at
    FROM app_notifications
    WHERE id = ? AND account_id = ?
    LIMIT 1
  `).bind(notificationId, accountId).first<NotificationRow>()
}

async function toNotificationSummary(
  db: D1Database,
  accountId: number,
  row: NotificationRow,
  capabilities: AppNotificationTargetCapabilities,
  now: Date,
): Promise<AppNotificationSummary> {
  const category = requireStoredCategory(row.category)
  return {
    notificationId: row.id,
    category,
    eventType: row.event_type,
    title: row.title_text,
    summary: row.summary_text,
    state: deriveNotificationState(row, now),
    target: await resolveTarget(db, accountId, row, capabilities),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    readAt: row.read_at,
  }
}

async function resolveTarget(
  db: D1Database,
  accountId: number,
  row: Pick<NotificationRow, 'target_type' | 'target_id' | 'action'>,
  capabilities: AppNotificationTargetCapabilities,
): Promise<AppNotificationTarget> {
  const type = requireStoredTargetType(row.target_type)
  const action = requireStoredAction(row.action)
  if (type === 'none' || action === 'none') {
    return { type: 'none', id: null, action: 'none', available: false, unavailableReason: null }
  }
  const capabilityEnabled = targetCapabilityEnabled(type, capabilities)
  if (!capabilityEnabled) {
    return { type, id: row.target_id, action, available: false, unavailableReason: 'FEATURE_DISABLED' }
  }
  const available = await targetBelongsToAccount(db, accountId, type, row.target_id)
  return {
    type,
    id: row.target_id,
    action,
    available,
    unavailableReason: available ? null : 'TARGET_NOT_AVAILABLE',
  }
}

function targetCapabilityEnabled(
  type: AppNotificationTargetType,
  capabilities: AppNotificationTargetCapabilities,
) {
  if (type === 'conversation') return capabilities.messaging
  if (type === 'person_profile') return capabilities.profiles
  if (type === 'membership') return capabilities.membership
  if (type === 'membership_application') return capabilities.membershipApplications
  if (type === 'safety_report') return capabilities.safetyReports
  if (type === 'safety_appeal') return capabilities.safetyAppeals
  if (type === 'account_security') return capabilities.accountSecurity
  if (type === 'wallet_entry') return capabilities.wallet
  return false
}

async function targetBelongsToAccount(
  db: D1Database,
  accountId: number,
  type: AppNotificationTargetType,
  targetId: string,
) {
  let query: string | null = null
  if (type === 'conversation') query = 'SELECT 1 AS found FROM app_conversations WHERE id = ? AND account_id = ?'
  if (type === 'membership') query = 'SELECT 1 AS found FROM app_membership_grants WHERE id = ? AND user_id = ?'
  if (type === 'membership_application') query = 'SELECT 1 AS found FROM app_membership_applications WHERE id = ? AND user_id = ?'
  if (type === 'safety_report') query = 'SELECT 1 AS found FROM app_safety_reports WHERE id = ? AND account_id = ?'
  if (type === 'safety_appeal') query = 'SELECT 1 AS found FROM app_safety_appeals WHERE id = ? AND account_id = ?'
  if (type === 'account_security') query = 'SELECT 1 AS found FROM app_account_security_events WHERE id = ? AND account_id = ?'
  if (type === 'wallet_entry') query = 'SELECT 1 AS found FROM app_wallet_entries WHERE id = ? AND account_id = ? AND status = \'posted\''
  if (type === 'person_profile') {
    query = `
      SELECT 1 AS found
      FROM profile_public_projections
      WHERE profile_id = ? AND publication_status = 'published' AND visibility_status = 'visible'
      LIMIT 1
    `
    return Boolean(await db.prepare(query).bind(targetId).first<{ found: number }>())
  }
  if (!query) return false
  return Boolean(await db.prepare(`${query} LIMIT 1`).bind(targetId, accountId).first<{ found: number }>())
}

async function notificationCopyForDelivery(
  db: D1Database,
  row: OutboxDeliveryRow,
): Promise<{ title: string; summary: string; body: string }> {
  if (row.event_type !== 'wallet.entry_posted') {
    return { title: row.title_text, summary: row.summary_text, body: row.body_text }
  }
  const entry = await db.prepare(`
    SELECT direction, amount, reason_code
    FROM app_wallet_entries
    WHERE id = ? AND account_id = ? AND status = 'posted'
    LIMIT 1
  `).bind(row.target_id, row.account_id).first<{
    direction: string
    amount: number
    reason_code: string
  }>()
  if (!entry || !Number.isSafeInteger(entry.amount) || entry.amount < 1) {
    throw new Error('WALLET_NOTIFICATION_ENTRY_UNAVAILABLE')
  }
  const direction = entry.direction === 'credit'
    ? '增加'
    : entry.direction === 'debit'
      ? '扣减'
      : null
  if (!direction) throw new Error('WALLET_NOTIFICATION_ENTRY_INVALID')
  const reason = walletNotificationReasonLabel(entry.reason_code)
  const summary = `金币已${direction} ${entry.amount} · ${reason}`
  return {
    title: `金币已${direction}`,
    summary,
    body: `${summary}。打开金币明细可核对权威余额、业务编号与冲正关系。金币当前不可购买、消费、转赠、兑换或提现。`,
  }
}

function walletNotificationReasonLabel(value: string) {
  if (value === 'manual_adjustment') return '管理员调整'
  if (value === 'service_compensation') return '平台服务补偿'
  if (value === 'correction') return '账务纠正'
  if (value === 'reversal') return '原分录冲正'
  throw new Error('WALLET_NOTIFICATION_REASON_INVALID')
}

function deriveNotificationState(
  row: Pick<NotificationRow, 'status' | 'expires_at' | 'read_at'>,
  now: Date,
): AppNotificationState {
  if (row.status === 'withdrawn') return 'withdrawn'
  if (row.expires_at && row.expires_at <= now.toISOString()) return 'expired'
  if (row.read_at) return 'read'
  return 'available'
}

function normalizePolicyId(value: string | undefined) {
  const normalized = value?.trim()
  return normalized && /^ntp_[A-Za-z0-9_-]{1,76}$/u.test(normalized) ? normalized : null
}

function normalizeCategory(value: string | undefined): AppNotificationCategory | null {
  if (value === undefined || value.trim() === '') return null
  const category = value.trim()
  if (!isNotificationCategory(category)) {
    throw new AppNotificationError(400, 'INVALID_NOTIFICATION_CATEGORY', '通知分类无效')
  }
  return category
}

function requireCategory(value: unknown): AppNotificationCategory {
  if (typeof value !== 'string' || !isNotificationCategory(value)) {
    throw new AppNotificationError(400, 'INVALID_NOTIFICATION_CATEGORY', '通知分类无效')
  }
  return value
}

function isNotificationCategory(value: string): value is AppNotificationCategory {
  return NOTIFICATION_CATEGORIES.has(value as AppNotificationCategory)
}

function requireStoredCategory(value: string): AppNotificationCategory {
  if (isNotificationCategory(value)) return value
  throw new AppNotificationError(503, 'NOTIFICATION_DATA_INVALID', '通知数据暂不可用')
}

function requireStoredTargetType(value: string): AppNotificationTargetType {
  const allowed: AppNotificationTargetType[] = [
    'conversation',
    'person_profile',
    'membership',
    'membership_application',
    'wallet_entry',
    'safety_report',
    'safety_appeal',
    'account_security',
    'data_task',
    'none',
  ]
  if (allowed.some(item => item === value)) return value as AppNotificationTargetType
  throw new AppNotificationError(503, 'NOTIFICATION_DATA_INVALID', '通知数据暂不可用')
}

function requireStoredAction(value: string): AppNotificationAction {
  const allowed: AppNotificationAction[] = [
    'open_conversation',
    'open_person_profile',
    'open_membership',
    'open_membership_application',
    'open_wallet_entry',
    'open_safety_report',
    'open_safety_appeal',
    'open_account_security',
    'open_data_task',
    'none',
  ]
  if (allowed.some(item => item === value)) return value as AppNotificationAction
  throw new AppNotificationError(503, 'NOTIFICATION_DATA_INVALID', '通知数据暂不可用')
}

function requirePositiveInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AppNotificationError(400, 'INVALID_REQUEST', `${field} 必须是正整数`)
  }
  return Number(value)
}

function requireBoolean(value: unknown, field: string) {
  if (typeof value !== 'boolean') {
    throw new AppNotificationError(400, 'INVALID_REQUEST', `${field} 必须是布尔值`)
  }
  return value
}

function validateNotificationId(value: string) {
  if (!/^ntf_[A-Za-z0-9_-]{1,92}$/u.test(value)) {
    throw notificationNotFound()
  }
}

function notificationNotFound() {
  return new AppNotificationError(404, 'NOTIFICATION_NOT_FOUND', '通知不存在或不属于当前账号')
}

function randomId(prefix: 'nre' | 'npe') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function stableNotificationId(outboxId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(outboxId))
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `ntf_${hex.slice(0, 48)}`
}

function encodeCursor(value: NonNullable<AppNotificationListQuery['cursor']>) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeCursor(
  value: string,
  accountScope: string,
  category: AppNotificationCategory | null,
): NonNullable<AppNotificationListQuery['cursor']> {
  try {
    const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    if (
      parsed.v !== 1
      || parsed.accountScope !== accountScope
      || parsed.category !== category
      || typeof parsed.createdAt !== 'string'
      || Number.isNaN(Date.parse(parsed.createdAt))
      || typeof parsed.notificationId !== 'string'
      || !/^ntf_[A-Za-z0-9_-]{1,92}$/u.test(parsed.notificationId)
    ) throw new Error('invalid cursor')
    return parsed as unknown as NonNullable<AppNotificationListQuery['cursor']>
  }
  catch {
    throw new AppNotificationError(400, 'INVALID_CURSOR', '分页游标无效')
  }
}
