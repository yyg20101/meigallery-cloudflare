import type { AppNotificationCategory } from '@meigallery/shared'
import { APP_NOTIFICATION_CATEGORIES, AppNotificationError } from './app-notifications'

const CATEGORIES = new Set(APP_NOTIFICATION_CATEGORIES.map(item => item.code))
const DELIVERY_STATUSES = new Set([
  'pending',
  'processing',
  'delivered',
  'suppressed',
  'failed',
  'dead_letter',
])

export async function getAdminAppNotificationOverview(
  db: D1Database,
  policyId: string,
) {
  const policy = await db.prepare(`
    SELECT id, version_code, state, production_ready, generation_enabled,
           decision_status, retention_days, purge_enabled,
           minimum_client_version, effective_at, created_at
    FROM app_notification_policies
    WHERE id = ?
    LIMIT 1
  `).bind(policyId).first<Record<string, string | number | null>>()
  if (!policy) throw policyUnavailable()

  const [outboxResult, notificationResult] = await Promise.all([
    db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM app_notification_outbox
      WHERE policy_id = ?
      GROUP BY status
    `).bind(policyId).all<{ status: string; count: number }>(),
    db.prepare(`
      SELECT category,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'available' AND read_at IS NULL
                           AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))
                      THEN 1 ELSE 0 END) AS unread
      FROM app_notifications notification
      JOIN app_notification_outbox outbox ON outbox.id = notification.outbox_id
      WHERE outbox.policy_id = ?
      GROUP BY category
    `).bind(policyId).all<{ category: string; total: number; unread: number }>(),
  ])

  return {
    policy: {
      policyId: String(policy.id),
      versionCode: String(policy.version_code),
      state: String(policy.state),
      productionReady: policy.production_ready === 1,
      generationEnabled: policy.generation_enabled === 1,
      decisionStatus: String(policy.decision_status),
      retentionDays: policy.retention_days === null ? null : Number(policy.retention_days),
      purgeEnabled: policy.purge_enabled === 1,
      minimumClientVersion: String(policy.minimum_client_version),
      effectiveAt: policy.effective_at === null ? null : String(policy.effective_at),
      createdAt: String(policy.created_at),
    },
    outbox: Object.fromEntries(outboxResult.results.map(row => [row.status, Number(row.count)])),
    notifications: notificationResult.results.map(row => ({
      category: row.category,
      total: Number(row.total),
      unread: Number(row.unread),
    })),
  }
}

export async function listAdminAppNotificationDefinitions(
  db: D1Database,
  policyId: string,
) {
  const result = await db.prepare(`
    SELECT definition.id, definition.event_type, definition.category,
           definition.necessity, definition.preference_key, definition.source_domain,
           definition.target_type, definition.action, definition.schema_version,
           definition.privacy_level, definition.minimum_client_version,
           definition.active, definition.created_at,
           template.id AS template_id, template.version_code AS template_version,
           template.state AS template_state
    FROM app_notification_event_definitions definition
    LEFT JOIN app_notification_template_versions template
      ON template.event_definition_id = definition.id
     AND template.locale = 'zh-CN'
     AND template.region_scope = 'all'
     AND template.state IN ('development', 'published')
    WHERE definition.policy_id = ?
    ORDER BY definition.active DESC, definition.category ASC, definition.event_type ASC
  `).bind(policyId).all<Record<string, string | number | null>>()
  return result.results.map(row => ({
    definitionId: String(row.id),
    eventType: String(row.event_type),
    category: String(row.category),
    necessity: String(row.necessity),
    preferenceKey: row.preference_key === null ? null : String(row.preference_key),
    sourceDomain: String(row.source_domain),
    targetType: String(row.target_type),
    action: String(row.action),
    schemaVersion: Number(row.schema_version),
    privacyLevel: String(row.privacy_level),
    minimumClientVersion: String(row.minimum_client_version),
    active: row.active === 1,
    template: row.template_id === null
      ? null
      : {
          templateId: String(row.template_id),
          version: String(row.template_version),
          state: String(row.template_state),
        },
    createdAt: String(row.created_at),
  }))
}

export async function listAdminAppNotificationTemplates(
  db: D1Database,
  policyId: string,
) {
  const result = await db.prepare(`
    SELECT template.id, definition.event_type, definition.category,
           template.version_code, template.state, template.locale,
           template.title_text, template.summary_text, template.body_text,
           template.effective_at, template.created_at
    FROM app_notification_template_versions template
    JOIN app_notification_event_definitions definition
      ON definition.id = template.event_definition_id
    WHERE definition.policy_id = ?
    ORDER BY definition.category ASC, definition.event_type ASC, template.created_at DESC
  `).bind(policyId).all<Record<string, string | null>>()
  return result.results.map(row => ({
    templateId: row.id,
    eventType: row.event_type,
    category: row.category,
    version: row.version_code,
    state: row.state,
    locale: row.locale,
    title: row.title_text,
    summary: row.summary_text,
    body: row.body_text,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  }))
}

export function parseAdminAppNotificationDeliveryQuery(input: {
  status?: string
  category?: string
  limit?: string
}) {
  const status = input.status?.trim() || null
  const category = input.category?.trim() || null
  if (status && !DELIVERY_STATUSES.has(status)) {
    throw new AppNotificationError(400, 'INVALID_DELIVERY_STATUS', '通知投递状态无效')
  }
  if (category && !CATEGORIES.has(category as AppNotificationCategory)) {
    throw new AppNotificationError(400, 'INVALID_NOTIFICATION_CATEGORY', '通知分类无效')
  }
  const parsedLimit = Number.parseInt(input.limit ?? '', 10)
  return {
    status,
    category,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50,
  }
}

export async function listAdminAppNotificationDeliveries(
  db: D1Database,
  policyId: string,
  query: ReturnType<typeof parseAdminAppNotificationDeliveryQuery>,
) {
  const conditions = ['outbox.policy_id = ?']
  const bindings: unknown[] = [policyId]
  if (query.status) {
    conditions.push('outbox.status = ?')
    bindings.push(query.status)
  }
  if (query.category) {
    conditions.push('definition.category = ?')
    bindings.push(query.category)
  }
  const result = await db.prepare(`
    SELECT outbox.id, account.account_public_id, outbox.event_type,
           definition.category, outbox.target_type, outbox.status, outbox.attempts,
           outbox.last_error_code, outbox.notification_id, outbox.created_at,
           outbox.processed_at
    FROM app_notification_outbox outbox
    JOIN app_notification_event_definitions definition
      ON definition.id = outbox.event_definition_id
    LEFT JOIN app_account_security account ON account.account_id = outbox.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY outbox.created_at DESC, outbox.id DESC
    LIMIT ?
  `).bind(...bindings, query.limit).all<Record<string, string | number | null>>()
  return result.results.map(row => ({
    outboxId: String(row.id),
    accountId: row.account_public_id === null ? null : String(row.account_public_id),
    eventType: String(row.event_type),
    category: String(row.category),
    targetType: String(row.target_type),
    status: String(row.status),
    attempts: Number(row.attempts),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
    notificationId: row.notification_id === null ? null : String(row.notification_id),
    createdAt: String(row.created_at),
    processedAt: row.processed_at === null ? null : String(row.processed_at),
  }))
}

function policyUnavailable() {
  return new AppNotificationError(503, 'NOTIFICATION_POLICY_UNAVAILABLE', '通知策略暂不可用', true)
}
