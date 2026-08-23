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
const TEMPLATE_ID = /^ntv_[A-Za-z0-9_-]{1,92}$/u
const VERSION_CODE = /^[A-Za-z0-9._-]{1,80}$/u
const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/u

export interface AdminNotificationTemplateDraftInput {
  expectedVersion?: unknown
  proposedTemplateId?: unknown
  versionCode?: unknown
  locale?: unknown
  regionScope?: unknown
  variableAllowlist?: unknown
  title?: unknown
  summary?: unknown
  body?: unknown
}

export interface AdminNotificationTemplateReviewInput {
  expectedVersion?: unknown
  decision?: unknown
  reviewNote?: unknown
}

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
           definition.template_variable_catalog_json,
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
    variableCatalog: parseStringArray(row.template_variable_catalog_json),
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
           template.variable_allowlist_json,
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
    variableAllowlist: parseStringArray(row.variable_allowlist_json),
    title: row.title_text,
    summary: row.summary_text,
    body: row.body_text,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  }))
}

export async function getAdminAppNotificationTemplateWorkspace(
  db: D1Database,
  policyId: string,
  templateId: string,
  reviewerId: number,
  reviewerRole?: string,
) {
  const template = await requireTemplate(db, policyId, templateId)
  const request = await db.prepare(`
    SELECT request.*, requester.email AS requester_email, requester.nickname AS requester_nickname,
           reviewer.email AS reviewer_email, reviewer.nickname AS reviewer_nickname
    FROM app_notification_template_change_requests request
    JOIN users requester ON requester.id = request.requested_by
    LEFT JOIN users reviewer ON reviewer.id = request.reviewed_by
    WHERE request.base_template_id = ?
      AND request.status IN ('draft', 'pending_review', 'executing')
    ORDER BY request.created_at DESC, request.id DESC
    LIMIT 1
  `).bind(templateId).first<Record<string, string | number | null>>()

  return {
    template,
    request: request ? mapTemplateRequest(request, reviewerId, reviewerRole === 'owner') : null,
    canCreateDraft: ['development', 'published'].includes(template.state) && !request,
  }
}

export async function saveAdminAppNotificationTemplateDraft(
  db: D1Database,
  policyId: string,
  templateId: string,
  adminId: number,
  input: AdminNotificationTemplateDraftInput,
) {
  const base = await requireTemplate(db, policyId, templateId)
  if (!['development', 'published'].includes(base.state)) {
    throw new AppNotificationError(409, 'TEMPLATE_BASE_NOT_CURRENT', '只能基于当前有效模板创建新版本')
  }
  const normalized = normalizeTemplateDraft(input)
  validateTemplateVariables(normalized, base.variableCatalog)
  const existingPublishedIdentity = await db.prepare(`
    SELECT id
    FROM app_notification_template_versions
    WHERE id = ?
       OR (event_definition_id = ? AND version_code = ? AND locale = ? AND region_scope = ?)
    LIMIT 1
  `).bind(
    normalized.proposedTemplateId,
    base.definitionId,
    normalized.versionCode,
    normalized.locale,
    normalized.regionScope,
  ).first<{ id: string }>()
  if (existingPublishedIdentity) {
    throw new AppNotificationError(409, 'TEMPLATE_VERSION_ALREADY_EXISTS', '模板标识或版本号已存在，请使用新的版本')
  }
  const current = await db.prepare(`
    SELECT id, status, version, requested_by
    FROM app_notification_template_change_requests
    WHERE base_template_id = ? AND status IN ('draft', 'pending_review', 'executing')
    LIMIT 1
  `).bind(templateId).first<{ id: string; status: string; version: number; requested_by: number }>()
  const timestamp = new Date().toISOString()
  const contentHash = await sha256Hex(JSON.stringify(normalized))

  if (current) {
    if (current.status !== 'draft') throw new AppNotificationError(409, 'TEMPLATE_REVIEW_PENDING', '模板已提交审核或正在发布，不能继续覆盖草稿')
    if (current.requested_by !== adminId) throw new AppNotificationError(403, 'TEMPLATE_DRAFT_OWNER_MISMATCH', '只能由草稿创建人继续编辑')
    const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
    const mutationToken = randomId('ntm')
    const result = await db.batch([
      db.prepare(`
        UPDATE app_notification_template_change_requests
        SET proposed_template_id = ?, version_code = ?, locale = ?, region_scope = ?,
            variable_allowlist_json = ?, title_text = ?, summary_text = ?, body_text = ?,
            version = version + 1, mutation_token = ?, content_hash = ?, updated_at = ?
        WHERE id = ? AND status = 'draft' AND version = ?
      `).bind(
        normalized.proposedTemplateId, normalized.versionCode, normalized.locale, normalized.regionScope,
        JSON.stringify(normalized.variableAllowlist), normalized.title, normalized.summary, normalized.body,
        mutationToken, contentHash, timestamp, current.id, expectedVersion,
      ),
      conditionalTemplateEventStatement(db, current.id, mutationToken, 'draft_saved', adminId, { version: expectedVersion + 1 }, timestamp),
      conditionalNotificationAuditStatement(db, adminId, 'app.notification.template.draft.update', current.id, mutationToken, { version: expectedVersion }, { version: expectedVersion + 1, contentHash }, timestamp),
    ])
    if (result[0]?.meta.changes !== 1) throw staleTemplate()
    return getAdminAppNotificationTemplateWorkspace(db, policyId, templateId, adminId)
  }

  const requestId = randomId('ntr')
  await db.batch([
    db.prepare(`
      INSERT INTO app_notification_template_change_requests (
        id, base_template_id, proposed_template_id, event_definition_id, version_code,
        locale, region_scope, variable_allowlist_json, title_text, summary_text, body_text,
        status, version, mutation_token, content_hash, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?)
    `).bind(
      requestId, templateId, normalized.proposedTemplateId, base.definitionId, normalized.versionCode,
      normalized.locale, normalized.regionScope, JSON.stringify(normalized.variableAllowlist),
      normalized.title, normalized.summary, normalized.body, randomId('ntm'), contentHash, adminId,
      timestamp, timestamp,
    ),
    db.prepare(`
      INSERT INTO app_notification_template_change_events
        (id, request_id, sequence, event_type, actor_id, safe_summary_json, created_at)
      VALUES (?, ?, 1, 'draft_saved', ?, ?, ?)
    `).bind(randomId('nte'), requestId, adminId, JSON.stringify({ version: 1 }), timestamp),
    db.prepare(`
      INSERT INTO admin_audit_logs
        (id, admin_id, action, target_type, target_id, before_value, after_value, created_at)
      VALUES (?, ?, 'app.notification.template.draft.create', 'app_notification_template_change_request', ?, NULL, ?, ?)
    `).bind(randomId('log'), adminId, requestId, JSON.stringify({ version: 1, contentHash }), timestamp),
  ])
  return getAdminAppNotificationTemplateWorkspace(db, policyId, templateId, adminId)
}

export async function submitAdminAppNotificationTemplateReview(
  db: D1Database,
  policyId: string,
  templateId: string,
  requestId: string,
  adminId: number,
  expectedVersionValue: unknown,
) {
  await requireTemplate(db, policyId, templateId)
  const expectedVersion = positiveInteger(expectedVersionValue, 'expectedVersion')
  const timestamp = new Date().toISOString()
  const mutationToken = randomId('ntm')
  const result = await db.batch([
    db.prepare(`
      UPDATE app_notification_template_change_requests
      SET status = 'pending_review', version = version + 1, mutation_token = ?, submitted_at = ?, updated_at = ?
      WHERE id = ? AND base_template_id = ? AND status = 'draft' AND version = ? AND requested_by = ?
    `).bind(mutationToken, timestamp, timestamp, requestId, templateId, expectedVersion, adminId),
    conditionalTemplateEventStatement(db, requestId, mutationToken, 'submitted', adminId, { version: expectedVersion + 1 }, timestamp),
    conditionalNotificationAuditStatement(db, adminId, 'app.notification.template.review.submit', requestId, mutationToken, { status: 'draft', version: expectedVersion }, { status: 'pending_review', version: expectedVersion + 1 }, timestamp),
  ])
  if (result[0]?.meta.changes !== 1) throw staleTemplate()
  return getAdminAppNotificationTemplateWorkspace(db, policyId, templateId, adminId)
}

export async function reviewAdminAppNotificationTemplate(
  db: D1Database,
  policyId: string,
  templateId: string,
  requestId: string,
  adminId: number,
  input: AdminNotificationTemplateReviewInput,
) {
  const base = await requireTemplate(db, policyId, templateId)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const decision = input.decision === 'approve' || input.decision === 'reject' ? input.decision : null
  if (!decision) throw new AppNotificationError(400, 'TEMPLATE_REVIEW_DECISION_INVALID', '模板复核结论无效')
  const reviewNote = requiredText(input.reviewNote, 'reviewNote', 2, 500)
  const request = await db.prepare(`
    SELECT * FROM app_notification_template_change_requests
    WHERE id = ? AND base_template_id = ? LIMIT 1
  `).bind(requestId, templateId).first<Record<string, string | number | null>>()
  if (!request) throw new AppNotificationError(404, 'TEMPLATE_REQUEST_NOT_FOUND', '模板变更申请不存在')
  if (request.status !== 'pending_review' || Number(request.version) !== expectedVersion) throw staleTemplate()
  if (Number(request.requested_by) === adminId) throw new AppNotificationError(403, 'INDEPENDENT_REVIEW_REQUIRED', '模板创建人不能复核自己的申请')
  if (String(request.event_definition_id) !== base.definitionId) throw staleTemplate()
  validateTemplateVariables(normalizeStoredTemplateRequest(request), base.variableCatalog)
  const timestamp = new Date().toISOString()

  if (decision === 'approve') {
    const claimToken = randomId('ntm')
    const finalizeToken = randomId('ntm')
    try {
      const result = await db.batch([
        db.prepare(`
          UPDATE app_notification_template_change_requests
          SET status = 'executing', version = version + 1, mutation_token = ?, reviewed_by = ?,
              review_note = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND base_template_id = ? AND status = 'pending_review' AND version = ?
            AND requested_by <> ?
            AND EXISTS (
              SELECT 1 FROM app_notification_template_versions
              WHERE id = ? AND state IN ('development', 'published')
            )
        `).bind(claimToken, adminId, reviewNote, timestamp, timestamp, requestId, templateId, expectedVersion, adminId, templateId),
        conditionalTemplateEventStatement(db, requestId, claimToken, 'executing', adminId, { version: expectedVersion + 1 }, timestamp),
        db.prepare(`
          UPDATE app_notification_template_versions
          SET state = 'retired'
          WHERE id = ? AND state IN ('development', 'published')
            AND EXISTS (
              SELECT 1 FROM app_notification_template_change_requests
              WHERE id = ? AND status = 'executing' AND version = ?
                AND reviewed_by = ? AND mutation_token = ?
            )
        `).bind(templateId, requestId, expectedVersion + 1, adminId, claimToken),
        db.prepare(`
          INSERT INTO app_notification_template_versions (
            id, event_definition_id, version_code, state, locale, region_scope,
            variable_allowlist_json, title_text, summary_text, body_text,
            approved_by, effective_at, created_at
          ) SELECT proposed_template_id, event_definition_id, version_code, 'published', locale, region_scope,
                   variable_allowlist_json, title_text, summary_text, body_text, ?, ?, ?
            FROM app_notification_template_change_requests
            WHERE id = ? AND status = 'executing' AND version = ? AND reviewed_by = ?
              AND mutation_token = ?
        `).bind(adminId, timestamp, timestamp, requestId, expectedVersion + 1, adminId, claimToken),
        db.prepare(`
          UPDATE app_notification_template_change_requests
          SET status = 'approved', version = version + 1, mutation_token = ?, updated_at = ?
          WHERE id = ? AND status = 'executing' AND version = ? AND reviewed_by = ?
            AND mutation_token = ?
        `).bind(finalizeToken, timestamp, requestId, expectedVersion + 1, adminId, claimToken),
        conditionalTemplateEventStatement(db, requestId, finalizeToken, 'approved', adminId, { version: expectedVersion + 2 }, timestamp),
        conditionalNotificationAuditStatement(db, adminId, 'app.notification.template.review.approve', requestId, finalizeToken, { status: 'pending_review', version: expectedVersion }, { status: 'approved', version: expectedVersion + 2 }, timestamp),
      ])
      if (result[0]?.meta.changes !== 1) throw staleTemplate()
      if (result[2]?.meta.changes !== 1 || result[3]?.meta.changes !== 1 || result[4]?.meta.changes !== 1) {
        throw new AppNotificationError(409, 'TEMPLATE_PUBLICATION_CONFLICT', '模板发布前置状态不一致，请刷新后重试')
      }
    }
    catch (error) {
      if (error instanceof AppNotificationError) throw error
      throw new AppNotificationError(409, 'TEMPLATE_PUBLICATION_CONFLICT', '模板版本或发布状态发生冲突，申请内容已保留，请刷新后重试')
    }
  }
  else {
    const mutationToken = randomId('ntm')
    const result = await db.batch([
      db.prepare(`
        UPDATE app_notification_template_change_requests
        SET status = 'rejected', version = version + 1, mutation_token = ?, reviewed_by = ?,
            review_note = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending_review' AND version = ? AND requested_by <> ?
      `).bind(mutationToken, adminId, reviewNote, timestamp, timestamp, requestId, expectedVersion, adminId),
      conditionalTemplateEventStatement(db, requestId, mutationToken, 'rejected', adminId, { version: expectedVersion + 1 }, timestamp),
      conditionalNotificationAuditStatement(db, adminId, 'app.notification.template.review.reject', requestId, mutationToken, { status: 'pending_review', version: expectedVersion }, { status: 'rejected', version: expectedVersion + 1 }, timestamp),
    ])
    if (result[0]?.meta.changes !== 1) throw staleTemplate()
  }
  return getAdminAppNotificationTemplateWorkspace(db, policyId, templateId, adminId)
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
           outbox.processed_at,
           (
             SELECT COUNT(*)
             FROM app_notification_duplicate_suppressions suppression
             WHERE suppression.existing_outbox_id = outbox.id
           ) AS duplicate_suppression_count
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
    duplicateSuppressionCount: Number(row.duplicate_suppression_count),
    createdAt: String(row.created_at),
    processedAt: row.processed_at === null ? null : String(row.processed_at),
  }))
}

function policyUnavailable() {
  return new AppNotificationError(503, 'NOTIFICATION_POLICY_UNAVAILABLE', '通知策略暂不可用', true)
}

async function requireTemplate(db: D1Database, policyId: string, templateId: string) {
  if (!TEMPLATE_ID.test(templateId)) throw new AppNotificationError(404, 'TEMPLATE_NOT_FOUND', '通知模板不存在')
  const row = await db.prepare(`
    SELECT template.id, template.event_definition_id, definition.event_type, definition.category,
           template.version_code, template.state, template.locale, template.region_scope,
           template.variable_allowlist_json,
           definition.template_variable_catalog_json,
           template.title_text, template.summary_text, template.body_text,
           template.effective_at, template.created_at
    FROM app_notification_template_versions template
    JOIN app_notification_event_definitions definition
      ON definition.id = template.event_definition_id
    WHERE template.id = ? AND definition.policy_id = ?
    LIMIT 1
  `).bind(templateId, policyId).first<Record<string, string | null>>()
  if (!row) throw new AppNotificationError(404, 'TEMPLATE_NOT_FOUND', '通知模板不存在')
  return {
    templateId: String(row.id),
    definitionId: String(row.event_definition_id),
    eventType: String(row.event_type),
    category: String(row.category),
    version: String(row.version_code),
    state: String(row.state),
    locale: String(row.locale),
    regionScope: String(row.region_scope),
    variableAllowlist: parseStringArray(row.variable_allowlist_json),
    variableCatalog: parseStringArray(row.template_variable_catalog_json),
    title: String(row.title_text),
    summary: String(row.summary_text),
    body: String(row.body_text),
    effectiveAt: row.effective_at === null ? null : String(row.effective_at),
    createdAt: String(row.created_at),
  }
}

function mapTemplateRequest(row: Record<string, string | number | null>, reviewerId: number, reviewerIsOwner = false) {
  const requestedBy = Number(row.requested_by)
  const status = String(row.status)
  return {
    requestId: String(row.id),
    baseTemplateId: String(row.base_template_id),
    proposedTemplateId: String(row.proposed_template_id),
    eventDefinitionId: String(row.event_definition_id),
    versionCode: String(row.version_code),
    locale: String(row.locale),
    regionScope: String(row.region_scope),
    variableAllowlist: parseStringArray(row.variable_allowlist_json),
    title: String(row.title_text),
    summary: String(row.summary_text),
    body: String(row.body_text),
    status,
    version: Number(row.version),
    contentHash: String(row.content_hash),
    requestedBy: {
      id: requestedBy,
      label: actorLabel(row.requester_email, row.requester_nickname, requestedBy),
    },
    reviewedBy: row.reviewed_by === null
      ? null
      : {
          id: Number(row.reviewed_by),
          label: actorLabel(row.reviewer_email, row.reviewer_nickname, Number(row.reviewed_by)),
        },
    reviewNote: row.review_note === null ? null : String(row.review_note),
    canEdit: status === 'draft' && requestedBy === reviewerId,
    canSubmit: status === 'draft' && requestedBy === reviewerId,
    canReview: reviewerIsOwner && status === 'pending_review' && requestedBy !== reviewerId,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    submittedAt: row.submitted_at === null ? null : String(row.submitted_at),
    reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
  }
}

function normalizeTemplateDraft(input: AdminNotificationTemplateDraftInput) {
  const proposedTemplateId = requiredText(input.proposedTemplateId, 'proposedTemplateId', 5, 96)
  if (!TEMPLATE_ID.test(proposedTemplateId)) throw new AppNotificationError(400, 'TEMPLATE_ID_INVALID', '模板标识必须以 ntv_ 开头且只能包含安全字符')
  const versionCode = requiredText(input.versionCode, 'versionCode', 1, 80)
  if (!VERSION_CODE.test(versionCode)) throw new AppNotificationError(400, 'TEMPLATE_VERSION_INVALID', '模板版本号只能包含字母、数字、点、下划线和连字符')
  const locale = requiredText(input.locale, 'locale', 1, 16)
  const regionScope = requiredText(input.regionScope, 'regionScope', 1, 32)
  if (locale !== 'zh-CN') {
    throw new AppNotificationError(400, 'TEMPLATE_LOCALE_CONFLICT', '模板语言必须与 App 1.0 的 zh-CN 生成任务一致')
  }
  if (regionScope !== 'all') {
    throw new AppNotificationError(400, 'TEMPLATE_REGION_CONFLICT', '模板地区必须与 App 1.0 的全部地区生成范围一致')
  }
  if (!Array.isArray(input.variableAllowlist) || input.variableAllowlist.length > 20) {
    throw new AppNotificationError(400, 'TEMPLATE_VARIABLES_INVALID', '变量白名单必须是最多 20 项的数组')
  }
  const variableAllowlist = [...new Set(input.variableAllowlist.map(value => String(value).trim()).filter(Boolean))]
  if (variableAllowlist.some(value => !VARIABLE_NAME.test(value))) {
    throw new AppNotificationError(400, 'TEMPLATE_VARIABLES_INVALID', '变量名必须使用小写字母、数字和下划线')
  }
  return {
    proposedTemplateId,
    versionCode,
    locale,
    regionScope,
    variableAllowlist,
    title: requiredText(input.title, 'title', 1, 80),
    summary: requiredText(input.summary, 'summary', 1, 160),
    body: requiredText(input.body, 'body', 1, 500),
  }
}

function normalizeStoredTemplateRequest(row: Record<string, string | number | null>) {
  return normalizeTemplateDraft({
    proposedTemplateId: row.proposed_template_id,
    versionCode: row.version_code,
    locale: row.locale,
    regionScope: row.region_scope,
    variableAllowlist: parseStringArray(row.variable_allowlist_json),
    title: row.title_text,
    summary: row.summary_text,
    body: row.body_text,
  })
}

function validateTemplateVariables(
  input: ReturnType<typeof normalizeTemplateDraft>,
  variableCatalog: string[],
) {
  const allowed = new Set(input.variableAllowlist)
  const registered = new Set(variableCatalog)
  const unregistered = input.variableAllowlist.find(variable => !registered.has(variable))
  if (unregistered) {
    throw new AppNotificationError(400, 'TEMPLATE_VARIABLE_NOT_REGISTERED', `变量未在事件定义中登记：${unregistered}`)
  }
  for (const [field, value] of [['标题', input.title], ['摘要', input.summary], ['正文', input.body]] as const) {
    const variables = [...value.matchAll(/\{([a-z][a-z0-9_]*)\}/gu)].map(match => match[1]!)
    const stripped = value.replace(/\{[a-z][a-z0-9_]*\}/gu, '')
    if (stripped.includes('{') || stripped.includes('}')) {
      throw new AppNotificationError(400, 'TEMPLATE_VARIABLE_SYNTAX_INVALID', `${field}包含不完整的变量占位符`)
    }
    const unknown = variables.find(variable => !allowed.has(variable))
    if (unknown) throw new AppNotificationError(400, 'TEMPLATE_VARIABLE_MISSING', `${field}使用的变量未加入白名单：${unknown}`)
  }
}

function requiredText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw new AppNotificationError(400, 'TEMPLATE_INPUT_INVALID', `${field} 格式无效`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw new AppNotificationError(400, 'TEMPLATE_INPUT_INVALID', `${field} 长度或字符无效`)
  }
  return normalized
}

function positiveInteger(value: unknown, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AppNotificationError(400, 'TEMPLATE_VERSION_REQUIRED', `${field} 必须为正整数`)
  return parsed
}

function conditionalTemplateEventStatement(
  db: D1Database,
  requestId: string,
  mutationToken: string,
  eventType: 'draft_saved' | 'submitted' | 'executing' | 'approved' | 'rejected' | 'stale',
  actorId: number,
  summary: Record<string, unknown>,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO app_notification_template_change_events
      (id, request_id, sequence, event_type, actor_id, safe_summary_json, created_at)
    SELECT ?, ?,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM app_notification_template_change_events WHERE request_id = ?),
           ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM app_notification_template_change_requests
      WHERE id = ? AND mutation_token = ?
    )
  `).bind(
    randomId('nte'), requestId, requestId, eventType, actorId, JSON.stringify(summary), timestamp,
    requestId, mutationToken,
  )
}

function conditionalNotificationAuditStatement(
  db: D1Database,
  adminId: number,
  action: string,
  targetId: string,
  mutationToken: string,
  beforeValue: Record<string, unknown> | null,
  afterValue: Record<string, unknown>,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs
      (id, admin_id, action, target_type, target_id, before_value, after_value, created_at)
    SELECT ?, ?, ?, 'app_notification_template_change_request', ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM app_notification_template_change_requests
      WHERE id = ? AND mutation_token = ?
    )
  `).bind(
    randomId('log'), adminId, action, targetId,
    beforeValue ? JSON.stringify(beforeValue) : null, JSON.stringify(afterValue), timestamp,
    targetId, mutationToken,
  )
}

function parseStringArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : []
  }
  catch {
    return []
  }
}

function actorLabel(email: unknown, nickname: unknown, id: number) {
  const label = typeof nickname === 'string' && nickname.trim()
    ? nickname.trim()
    : typeof email === 'string' && email.trim() ? email.trim() : `管理员 ${id}`
  return label
}

function staleTemplate() {
  return new AppNotificationError(409, 'TEMPLATE_VERSION_CONFLICT', '模板内容或审核状态已变化，请刷新后重试')
}

function randomId(prefix: 'ntr' | 'nte' | 'ntm' | 'log') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
