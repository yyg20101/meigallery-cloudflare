import { generateId } from '../utils/db'

const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u
const DOMAIN_KEY = /^[a-z][a-z0-9_-]{0,47}$/u
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,191}$/u
const REQUEST_ID = /^aarq_[A-Za-z0-9_-]{1,90}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const OPERATIONS = new Set(['publish', 'retire'])
const SENSITIVITIES = new Set(['internal', 'restricted', 'highly_restricted'])
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical'])
const REQUEST_STATUSES = new Set(['pending_review', 'approved', 'rejected', 'stale'])
const REVIEW_DECISIONS = new Set(['approve', 'reject'])
const APPROVE_REASON_CODES = new Set(['definition_verified', 'other'])
const REJECT_REASON_CODES = new Set([
  'scope_incorrect',
  'risk_incorrect',
  'visibility_incorrect',
  'policy_reference_invalid',
  'quality_rule_invalid',
  'other',
])
const MAX_ACTIONS = 500
const MAX_REQUESTS = 100

export type AdminAppAuditRegistryOperation = 'publish' | 'retire'
export type AdminAppAuditRegistrySensitivity = 'internal' | 'restricted' | 'highly_restricted'
export type AdminAppAuditRegistryRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type AdminAppAuditRegistryRequestStatus = 'pending_review' | 'approved' | 'rejected' | 'stale'

export interface AdminAppAuditRegistryActor {
  id: number
  role: string
  label: string
}

export interface AdminAppAuditRegistryDefinition {
  registryId: string
  actionKey: string
  schemaVersion: number
  domain: string
  displayName: string
  ownerReference: string
  sensitivity: AdminAppAuditRegistrySensitivity
  riskLevel: AdminAppAuditRegistryRiskLevel
  visibleRoles: Array<'admin' | 'owner'>
  retentionPolicyReference: string | null
  qualityRuleReference: string | null
  status: 'active' | 'retired'
  createdBy: AdminAppAuditRegistryActor
  createdAt: string
  productionReady: boolean
}

export interface AdminAppAuditRegistryObservation {
  eventCount: number
  missingIndexCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  domains: string[]
  riskLevels: AdminAppAuditRegistryRiskLevel[]
  observationDigest: string
}

export interface AdminAppAuditRegistryActionSummary {
  actionKey: string
  governanceState: 'active' | 'unregistered' | 'retired' | 'pending_review' | 'inconsistent'
  latestDefinition: AdminAppAuditRegistryDefinition | null
  observation: AdminAppAuditRegistryObservation
  pendingRequest: null | {
    requestId: string
    operation: AdminAppAuditRegistryOperation
    requestedBy: AdminAppAuditRegistryActor
    createdAt: string
  }
}

export interface AdminAppAuditRegistryOverview {
  distinctActionCount: number
  activeActionCount: number
  unregisteredActionCount: number
  retiredActionCount: number
  inconsistentActionCount: number
  pendingRequestCount: number
  unregisteredEventCount: number
  definitionsNotProductionReady: number
  productionReady: boolean
  blockers: string[]
}

export interface AdminAppAuditRegistryProposalInput {
  actionKey?: unknown
  operation?: unknown
  domain?: unknown
  displayName?: unknown
  ownerReference?: unknown
  sensitivity?: unknown
  riskLevel?: unknown
  visibleRoles?: unknown
  retentionPolicyReference?: unknown
  qualityRuleReference?: unknown
  requestReason?: unknown
}

export interface AdminAppAuditRegistryReviewInput {
  expectedVersion?: unknown
  decision?: unknown
  reasonCode?: unknown
  reviewNote?: unknown
}

export interface AdminAppAuditRegistryProposal {
  actionKey: string
  operation: AdminAppAuditRegistryOperation
  schemaVersion: number
  domain: string
  displayName: string
  ownerReference: string
  sensitivity: AdminAppAuditRegistrySensitivity
  riskLevel: AdminAppAuditRegistryRiskLevel
  visibleRoles: Array<'admin' | 'owner'>
  retentionPolicyReference: string | null
  qualityRuleReference: string | null
}

export interface AdminAppAuditRegistryPreview {
  proposal: AdminAppAuditRegistryProposal
  currentDefinition: AdminAppAuditRegistryDefinition | null
  latestDefinition: AdminAppAuditRegistryDefinition | null
  observation: AdminAppAuditRegistryObservation
  affectedHistoricalEventCount: number
  blockers: string[]
  warnings: string[]
  canSubmit: boolean
}

export interface AdminAppAuditRegistryRequestEvent {
  eventId: string
  sequence: number
  type: 'submitted' | 'approved' | 'rejected' | 'stale'
  actor: AdminAppAuditRegistryActor
  reasonCode: string
  summary: Record<string, unknown>
  createdAt: string
}

export interface AdminAppAuditRegistryRequest {
  requestId: string
  operation: AdminAppAuditRegistryOperation
  proposal: AdminAppAuditRegistryProposal
  baseline: {
    expectedCurrentSchemaVersion: number | null
    observationDigest: string
    observedEventCount: number
    observedFirstAt: string | null
    observedLastAt: string | null
  }
  requestReason: string
  status: AdminAppAuditRegistryRequestStatus
  version: number
  requestedBy: AdminAppAuditRegistryActor
  reviewedBy: AdminAppAuditRegistryActor | null
  reviewReasonCode: string | null
  reviewNote: string | null
  resultRegistryId: string | null
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  appliedAt: string | null
  canReview: boolean
  currentState: {
    latestDefinition: AdminAppAuditRegistryDefinition | null
    observation: AdminAppAuditRegistryObservation
    governanceReady: boolean
    baselineChanged: boolean
  }
  events: AdminAppAuditRegistryRequestEvent[]
}

export interface AdminAppAuditRegistryRequestContext {
  requestId: string
  traceId: string | null
}

type ActorRow = {
  id: number
  role: string
  status: string
  email: string
  nickname: string | null
}

type DefinitionRow = {
  id: string
  action_key: string
  schema_version: number
  domain: string
  display_name: string
  owner_reference: string
  sensitivity: AdminAppAuditRegistrySensitivity
  risk_level: AdminAppAuditRegistryRiskLevel
  visible_roles_json: string
  retention_policy_reference: string | null
  quality_rule_reference: string | null
  status: 'active' | 'retired'
  created_by: number
  created_at: string
  creator_role: string | null
  creator_email: string | null
  creator_nickname: string | null
  retention_policy_ready: number
  quality_rule_ready: number
}

type ActionRow = {
  action_key: string
  registry_id: string | null
  schema_version: number | null
  domain: string | null
  display_name: string | null
  owner_reference: string | null
  sensitivity: AdminAppAuditRegistrySensitivity | null
  risk_level: AdminAppAuditRegistryRiskLevel | null
  visible_roles_json: string | null
  retention_policy_reference: string | null
  quality_rule_reference: string | null
  registry_status: 'active' | 'retired' | null
  registry_created_by: number | null
  registry_created_at: string | null
  registry_creator_role: string | null
  registry_creator_email: string | null
  registry_creator_nickname: string | null
  retention_policy_ready: number | null
  quality_rule_ready: number | null
  event_count: number
  missing_index_count: number
  first_seen_at: string | null
  last_seen_at: string | null
  observed_domains: string | null
  observed_risk_levels: string | null
  pending_request_id: string | null
  pending_operation: AdminAppAuditRegistryOperation | null
  pending_requested_by: number | null
  pending_created_at: string | null
  pending_requester_role: string | null
  pending_requester_email: string | null
  pending_requester_nickname: string | null
}

type ObservationRow = {
  event_count: number
  missing_index_count: number
  first_seen_at: string | null
  last_seen_at: string | null
  observed_domains: string | null
  observed_risk_levels: string | null
}

type RequestRow = {
  id: string
  action_key: string
  operation: AdminAppAuditRegistryOperation
  proposed_schema_version: number
  proposed_domain: string
  proposed_display_name: string
  proposed_owner_reference: string
  proposed_sensitivity: AdminAppAuditRegistrySensitivity
  proposed_risk_level: AdminAppAuditRegistryRiskLevel
  proposed_visible_roles_json: string
  proposed_retention_policy_reference: string | null
  proposed_quality_rule_reference: string | null
  expected_current_schema_version: number | null
  observation_digest: string
  observed_event_count: number
  observed_first_at: string | null
  observed_last_at: string | null
  request_reason: string
  status: AdminAppAuditRegistryRequestStatus
  version: number
  mutation_token: string
  request_hash: string
  requested_by: number
  reviewed_by: number | null
  review_reason_code: string | null
  review_note: string | null
  result_registry_id: string | null
  created_at: string
  updated_at: string
  reviewed_at: string | null
  applied_at: string | null
  requester_role: string | null
  requester_email: string | null
  requester_nickname: string | null
  reviewer_role: string | null
  reviewer_email: string | null
  reviewer_nickname: string | null
}

type RequestEventRow = {
  id: string
  sequence: number
  event_type: AdminAppAuditRegistryRequestEvent['type']
  actor_id: number
  actor_role: string | null
  actor_email: string | null
  actor_nickname: string | null
  reason_code: string
  safe_summary_json: string
  created_at: string
}

type CommandRow = {
  request_hash: string
  request_id: string
  result_status: AdminAppAuditRegistryRequestStatus
}

type NormalizedReview = {
  expectedVersion: number
  decision: 'approve' | 'reject'
  reasonCode: string
  reviewNote: string
}

export class AdminAppAuditRegistryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function getAdminAppAuditRegistryOverview(
  db: D1Database,
  adminId: number,
): Promise<AdminAppAuditRegistryOverview> {
  await requireActiveOwner(db, adminId)
  const actions = await loadActionSummaries(db)
  const pendingRequestCount = Number((await db.prepare(`
    SELECT COUNT(*) AS count
    FROM app_audit_registry_change_requests
    WHERE status = 'pending_review'
  `).first<{ count: number }>())?.count ?? 0)
  const active = actions.filter(item => item.latestDefinition?.status === 'active')
  const unregistered = actions.filter(item => item.latestDefinition === null)
  const retired = actions.filter(item => item.latestDefinition?.status === 'retired')
  const inconsistent = actions.filter(item => observationConflictsWithDefinition(item.observation, item.latestDefinition))
  const missingPolicy = active.filter(item => !item.latestDefinition?.productionReady).length
  const blockers: string[] = []
  if (actions.length === 0) blockers.push('尚未观察到任何审计 Action，不能判断 Registry 已就绪')
  if (unregistered.length > 0) blockers.push(`存在 ${unregistered.length} 个未登记 Action`)
  if (retired.some(item => item.observation.eventCount > 0)) blockers.push('存在仍有历史事实但当前已退休的 Action')
  if (inconsistent.length > 0) blockers.push(`存在 ${inconsistent.length} 个观察口径冲突的 Action`)
  if (pendingRequestCount > 0) blockers.push(`存在 ${pendingRequestCount} 项待独立复核的口径申请`)
  if (missingPolicy > 0) blockers.push(`存在 ${missingPolicy} 个 active 口径的治理引用未批准或未达到 production-ready`)
  return {
    distinctActionCount: actions.length,
    activeActionCount: active.length,
    unregisteredActionCount: unregistered.length,
    retiredActionCount: retired.length,
    inconsistentActionCount: inconsistent.length,
    pendingRequestCount,
    unregisteredEventCount: actions
      .filter(item => item.latestDefinition?.status !== 'active')
      .reduce((total, item) => total + item.observation.eventCount, 0),
    definitionsNotProductionReady: missingPolicy,
    productionReady: actions.length > 0 && blockers.length === 0,
    blockers,
  }
}

export async function listAdminAppAuditRegistryActions(
  db: D1Database,
  adminId: number,
  query: { state?: unknown; domain?: unknown; q?: unknown } = {},
): Promise<AdminAppAuditRegistryActionSummary[]> {
  await requireActiveOwner(db, adminId)
  const state = optionalEnum(query.state, 'state', new Set(['active', 'unregistered', 'retired', 'pending_review', 'inconsistent']))
  const domain = optionalPattern(query.domain, 'domain', DOMAIN_KEY)
  const keyword = optionalText(query.q, 'q', 1, 80)?.toLocaleLowerCase('zh-CN') ?? null
  return (await loadActionSummaries(db)).filter((item) => {
    if (state && item.governanceState !== state) return false
    const currentDomain = item.latestDefinition?.domain ?? item.observation.domains[0] ?? null
    if (domain && currentDomain !== domain) return false
    if (keyword && !`${item.actionKey} ${item.latestDefinition?.displayName ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)) return false
    return true
  }).slice(0, MAX_ACTIONS)
}

export async function listAdminAppAuditRegistryRequests(
  db: D1Database,
  adminId: number,
  query: { status?: unknown; operation?: unknown; limit?: unknown } = {},
): Promise<AdminAppAuditRegistryRequest[]> {
  const actor = await requireActiveOwner(db, adminId)
  const status = optionalEnum(query.status, 'status', REQUEST_STATUSES)
  const operation = optionalEnum(query.operation, 'operation', OPERATIONS)
  const limit = boundedInteger(query.limit, 50, 1, MAX_REQUESTS, 'limit')
  const conditions: string[] = []
  const params: unknown[] = []
  if (status) {
    conditions.push('request.status = ?')
    params.push(status)
  }
  if (operation) {
    conditions.push('request.operation = ?')
    params.push(operation)
  }
  const rows = await db.prepare(`
    ${requestSelect()}
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY CASE request.status WHEN 'pending_review' THEN 0 ELSE 1 END,
             request.updated_at DESC, request.id DESC
    LIMIT ?
  `).bind(...params, limit).all<RequestRow>()
  return Promise.all(rows.results.map(row => mapRequest(db, row, actor, false)))
}

export async function getAdminAppAuditRegistryRequest(
  db: D1Database,
  adminId: number,
  requestIdInput: string,
): Promise<AdminAppAuditRegistryRequest> {
  const actor = await requireActiveOwner(db, adminId)
  const requestId = normalizeRequestId(requestIdInput)
  const row = await db.prepare(`
    ${requestSelect()}
    WHERE request.id = ?
    LIMIT 1
  `).bind(requestId).first<RequestRow>()
  if (!row) throw new AdminAppAuditRegistryError(404, 'APP_AUDIT_REGISTRY_REQUEST_NOT_FOUND', 'Action 口径申请不存在')
  return mapRequest(db, row, actor, true)
}

export async function previewAdminAppAuditRegistryProposal(
  db: D1Database,
  adminId: number,
  input: AdminAppAuditRegistryProposalInput,
): Promise<AdminAppAuditRegistryPreview> {
  await requireActiveOwner(db, adminId)
  return buildPreview(db, input)
}

export async function createAdminAppAuditRegistryRequest(
  db: D1Database,
  adminId: number,
  idempotencyKeyInput: string | null,
  input: AdminAppAuditRegistryProposalInput,
  context: AdminAppAuditRegistryRequestContext,
  now = new Date(),
): Promise<{ request: AdminAppAuditRegistryRequest; replayed: boolean }> {
  const actor = await requireActiveOwner(db, adminId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyInput)
  const idempotencyKeyHash = await sha256Hex(idempotencyKey)
  const requestReason = requiredText(input.requestReason, 'requestReason', 10, 1000)
  const preview = await buildPreview(db, input)
  const requestHash = await sha256Hex(stableStringify({ proposal: preview.proposal, requestReason }))
  const replay = await findCommand(db, actor.id, 'create', idempotencyKeyHash)
  if (replay) return resolveReplay(db, actor, replay, requestHash)
  if (!preview.canSubmit) {
    throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_PROPOSAL_BLOCKED', preview.blockers[0] ?? '当前口径候选不能提交')
  }

  const requestId = generateId('aarq')
  const eventId = generateId('aare')
  const commandId = generateId('aarc')
  const auditId = generateId('audit')
  const timestamp = now.toISOString()
  const mutationToken = crypto.randomUUID()
  const proposed = preview.proposal
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_audit_registry_change_requests (
          id, action_key, operation, proposed_schema_version, proposed_domain,
          proposed_display_name, proposed_owner_reference, proposed_sensitivity,
          proposed_risk_level, proposed_visible_roles_json,
          proposed_retention_policy_reference, proposed_quality_rule_reference,
          expected_current_schema_version, observation_digest, observed_event_count,
          observed_first_at, observed_last_at, request_reason, status, version,
          mutation_token, request_hash, requested_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 1, ?, ?, ?, ?, ?)
      `).bind(
        requestId,
        proposed.actionKey,
        proposed.operation,
        proposed.schemaVersion,
        proposed.domain,
        proposed.displayName,
        proposed.ownerReference,
        proposed.sensitivity,
        proposed.riskLevel,
        JSON.stringify(proposed.visibleRoles),
        proposed.retentionPolicyReference,
        proposed.qualityRuleReference,
        preview.latestDefinition?.schemaVersion ?? null,
        preview.observation.observationDigest,
        preview.observation.eventCount,
        preview.observation.firstSeenAt,
        preview.observation.lastSeenAt,
        requestReason,
        mutationToken,
        requestHash,
        actor.id,
        timestamp,
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_audit_registry_change_events (
          id, request_id, sequence, event_type, actor_id, reason_code, safe_summary_json, created_at
        ) VALUES (?, ?, 1, 'submitted', ?, 'registry_change_requested', ?, ?)
      `).bind(eventId, requestId, actor.id, JSON.stringify({
        actionKey: proposed.actionKey,
        operation: proposed.operation,
        schemaVersion: proposed.schemaVersion,
        observedEventCount: preview.observation.eventCount,
        warningCount: preview.warnings.length,
      }), timestamp),
      db.prepare(`
        INSERT INTO app_audit_registry_commands (
          id, admin_id, command_scope, idempotency_key_hash, request_hash,
          request_id, result_status, created_at
        ) VALUES (?, ?, 'create', ?, ?, ?, 'pending_review', ?)
      `).bind(commandId, actor.id, idempotencyKeyHash, requestHash, requestId, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app.audit.integrity.registry.request', 'app_audit_registry_change_request', ?, ?, ?, ?)
      `).bind(
        auditId,
        actor.id,
        requestId,
        JSON.stringify(preview.currentDefinition ? safeDefinition(preview.currentDefinition) : null),
        JSON.stringify({
          ...safeProposal(proposed),
          status: 'pending_review',
          observationDigest: preview.observation.observationDigest,
          observedEventCount: preview.observation.eventCount,
          requestReasonDigest: await sha256Hex(requestReason),
        }),
        timestamp,
      ),
      auditContextStatement(db, {
        auditId,
        context,
        idempotencyKeyHash,
        reasonCode: 'registry_change_requested',
        businessReference: proposed.actionKey,
        targetVersion: String(proposed.schemaVersion),
        approvalRequestId: requestId,
        policyVersion: proposed.retentionPolicyReference,
        result: 'succeeded',
        createdAt: timestamp,
      }),
    ])
  }
  catch (error) {
    const raced = await findCommand(db, actor.id, 'create', idempotencyKeyHash)
    if (raced) return resolveReplay(db, actor, raced, requestHash)
    const pending = await findPendingRequest(db, proposed.actionKey)
    if (pending) {
      throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_REQUEST_ALREADY_PENDING', '该 Action 已有待复核口径申请')
    }
    throw error
  }
  return {
    request: await getAdminAppAuditRegistryRequest(db, actor.id, requestId),
    replayed: false,
  }
}

export async function reviewAdminAppAuditRegistryRequest(
  db: D1Database,
  adminId: number,
  requestIdInput: string,
  idempotencyKeyInput: string | null,
  input: AdminAppAuditRegistryReviewInput,
  context: AdminAppAuditRegistryRequestContext,
  now = new Date(),
): Promise<{ request: AdminAppAuditRegistryRequest; replayed: boolean }> {
  const actor = await requireActiveOwner(db, adminId)
  const requestId = normalizeRequestId(requestIdInput)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyInput)
  const idempotencyKeyHash = await sha256Hex(idempotencyKey)
  const review = normalizeReview(input)
  const requestHash = await sha256Hex(stableStringify({ requestId, ...review }))
  const replay = await findCommand(db, actor.id, 'review', idempotencyKeyHash)
  if (replay) return resolveReplay(db, actor, replay, requestHash)
  const row = await requireRequestRow(db, requestId)
  if (row.requested_by === actor.id) {
    throw new AdminAppAuditRegistryError(403, 'APP_AUDIT_REGISTRY_SELF_REVIEW_FORBIDDEN', '申请人不能复核本人提交的 Action 口径')
  }
  if (row.status !== 'pending_review' || row.version !== review.expectedVersion) {
    throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_REQUEST_VERSION_CONFLICT', '口径申请状态或版本已变化，请刷新后重试')
  }
  if (review.decision === 'reject') {
    return transitionRequest(db, actor, row, review, requestHash, idempotencyKeyHash, context, now, 'rejected')
  }

  const preview = await buildPreview(db, proposalInputFromRequest(row), row.id)
  const baselineChanged = (preview.latestDefinition?.schemaVersion ?? null) !== row.expected_current_schema_version
    || preview.observation.observationDigest !== row.observation_digest
    || preview.proposal.schemaVersion !== row.proposed_schema_version
  if (baselineChanged || !preview.canSubmit) {
    const staleReview: NormalizedReview = {
      ...review,
      reasonCode: 'baseline_changed',
      reviewNote: '复核时发现当前 Action 版本、观察口径或待处理申请发生变化，原申请已安全失效。',
    }
    return transitionRequest(db, actor, row, staleReview, requestHash, idempotencyKeyHash, context, now, 'stale')
  }
  return approveRequest(db, actor, row, review, requestHash, idempotencyKeyHash, context, now)
}

async function approveRequest(
  db: D1Database,
  actor: ActorRow,
  row: RequestRow,
  review: NormalizedReview,
  requestHash: string,
  idempotencyKeyHash: string,
  context: AdminAppAuditRegistryRequestContext,
  now: Date,
): Promise<{ request: AdminAppAuditRegistryRequest; replayed: boolean }> {
  const registryId = generateId('aarr')
  const eventId = generateId('aare')
  const commandId = generateId('aarc')
  const auditId = generateId('audit')
  const timestamp = now.toISOString()
  const nextVersion = row.version + 1
  const mutationToken = crypto.randomUUID()
  const latestGuard = row.expected_current_schema_version === null
    ? `NOT EXISTS (SELECT 1 FROM app_audit_action_registry existing WHERE existing.action_key = request.action_key)`
    : `(SELECT MAX(existing.schema_version) FROM app_audit_action_registry existing WHERE existing.action_key = request.action_key) = ${row.expected_current_schema_version}`
  let results: D1Result<unknown>[]
  try {
    results = await db.batch([
      db.prepare(`
        INSERT INTO app_audit_action_registry (
          id, action_key, schema_version, domain, display_name, owner_reference,
          sensitivity, risk_level, visible_roles_json, retention_policy_reference,
          quality_rule_reference, status, created_by, created_at
        )
        SELECT ?, request.action_key, request.proposed_schema_version, request.proposed_domain,
               request.proposed_display_name, request.proposed_owner_reference,
               request.proposed_sensitivity, request.proposed_risk_level,
               request.proposed_visible_roles_json, request.proposed_retention_policy_reference,
               request.proposed_quality_rule_reference,
               CASE request.operation WHEN 'publish' THEN 'active' ELSE 'retired' END,
               ?, ?
        FROM app_audit_registry_change_requests request
        WHERE request.id = ? AND request.status = 'pending_review' AND request.version = ?
          AND request.requested_by <> ? AND ${latestGuard}
          AND (
            request.operation = 'retire'
            OR (
              EXISTS (
                SELECT 1
                FROM app_audit_current_governance_policies retention
                WHERE retention.reference_key = request.proposed_retention_policy_reference
                  AND retention.policy_type = 'retention'
                  AND retention.decision_status = 'approved'
                  AND retention.production_ready = 1
              )
              AND EXISTS (
                SELECT 1
                FROM app_audit_current_governance_policies quality
                WHERE quality.reference_key = request.proposed_quality_rule_reference
                  AND quality.policy_type = 'quality'
                  AND quality.decision_status = 'approved'
                  AND quality.production_ready = 1
              )
            )
          )
      `).bind(registryId, actor.id, timestamp, row.id, row.version, actor.id),
      db.prepare(`
      UPDATE app_audit_registry_change_requests
      SET status = 'approved', version = ?, mutation_token = ?, reviewed_by = ?,
          review_reason_code = ?, review_note = ?, result_registry_id = ?,
          reviewed_at = ?, applied_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_review' AND version = ?
        AND requested_by <> ?
        AND EXISTS (SELECT 1 FROM app_audit_action_registry registry WHERE registry.id = ?)
      `).bind(
      nextVersion,
      mutationToken,
      actor.id,
      review.reasonCode,
      review.reviewNote,
      registryId,
      timestamp,
      timestamp,
      timestamp,
      row.id,
      row.version,
      actor.id,
      registryId,
    ),
      db.prepare(`
      INSERT INTO app_audit_registry_change_events (
        id, request_id, sequence, event_type, actor_id, reason_code, safe_summary_json, created_at
      )
      SELECT ?, id, 2, 'approved', ?, ?, ?, ?
      FROM app_audit_registry_change_requests
      WHERE id = ? AND status = 'approved' AND version = ? AND result_registry_id = ?
      `).bind(eventId, actor.id, review.reasonCode, JSON.stringify({
      actionKey: row.action_key,
      operation: row.operation,
      schemaVersion: row.proposed_schema_version,
      registryId,
    }), timestamp, row.id, nextVersion, registryId),
      db.prepare(`
      INSERT INTO app_audit_registry_commands (
        id, admin_id, command_scope, idempotency_key_hash, request_hash,
        request_id, result_status, created_at
      )
      SELECT ?, ?, 'review', ?, ?, id, 'approved', ?
      FROM app_audit_registry_change_requests
      WHERE id = ? AND status = 'approved' AND version = ? AND result_registry_id = ?
      `).bind(commandId, actor.id, idempotencyKeyHash, requestHash, timestamp, row.id, nextVersion, registryId),
      db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, 'app.audit.integrity.registry.approve', 'app_audit_registry_change_request', id, ?, ?, ?
      FROM app_audit_registry_change_requests
      WHERE id = ? AND status = 'approved' AND version = ? AND result_registry_id = ?
      `).bind(
      auditId,
      actor.id,
      JSON.stringify({ status: 'pending_review', version: row.version }),
      JSON.stringify({
        status: 'approved',
        version: nextVersion,
        actionKey: row.action_key,
        operation: row.operation,
        schemaVersion: row.proposed_schema_version,
        registryId,
        reviewReasonCode: review.reasonCode,
        hasReviewNote: true,
      }),
      timestamp,
      row.id,
      nextVersion,
      registryId,
    ),
      auditContextStatement(db, {
      auditId,
      context,
      idempotencyKeyHash,
      reasonCode: review.reasonCode,
      businessReference: row.action_key,
      targetVersion: String(row.proposed_schema_version),
      approvalRequestId: row.id,
      approvalStepId: 'registry_independent_review',
      policyVersion: row.proposed_retention_policy_reference,
      result: 'succeeded',
      createdAt: timestamp,
      guardAuditId: auditId,
      }),
    ])
  }
  catch (error) {
    const latest = await requireRequestRow(db, row.id)
    if (latest.status !== 'pending_review' || latest.version !== row.version) {
      throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_REQUEST_VERSION_CONFLICT', '口径申请已被其他复核操作处理，请刷新后重试')
    }
    throw error
  }
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    const latest = await requireRequestRow(db, row.id)
    if (latest.status !== 'pending_review' || latest.version !== row.version) {
      throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_REQUEST_VERSION_CONFLICT', '口径申请已被其他复核操作处理，请刷新后重试')
    }
    const staleReview: NormalizedReview = {
      ...review,
      reasonCode: 'baseline_changed',
      reviewNote: '复核提交时 Action 当前版本或治理策略就绪状态发生并发变化，原申请已安全失效。',
    }
    return transitionRequest(db, actor, latest, staleReview, requestHash, idempotencyKeyHash, context, now, 'stale')
  }
  return { request: await getAdminAppAuditRegistryRequest(db, actor.id, row.id), replayed: false }
}

async function transitionRequest(
  db: D1Database,
  actor: ActorRow,
  row: RequestRow,
  review: NormalizedReview,
  requestHash: string,
  idempotencyKeyHash: string,
  context: AdminAppAuditRegistryRequestContext,
  now: Date,
  status: 'rejected' | 'stale',
): Promise<{ request: AdminAppAuditRegistryRequest; replayed: boolean }> {
  const eventId = generateId('aare')
  const commandId = generateId('aarc')
  const auditId = generateId('audit')
  const timestamp = now.toISOString()
  const nextVersion = row.version + 1
  const mutationToken = crypto.randomUUID()
  const action = status === 'rejected'
    ? 'app.audit.integrity.registry.reject'
    : 'app.audit.integrity.registry.stale'
  let results: D1Result<unknown>[]
  try {
    results = await db.batch([
      db.prepare(`
      UPDATE app_audit_registry_change_requests
      SET status = ?, version = ?, mutation_token = ?, reviewed_by = ?,
          review_reason_code = ?, review_note = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_review' AND version = ? AND requested_by <> ?
      `).bind(
      status,
      nextVersion,
      mutationToken,
      actor.id,
      review.reasonCode,
      review.reviewNote,
      timestamp,
      timestamp,
      row.id,
      row.version,
      actor.id,
    ),
      db.prepare(`
      INSERT INTO app_audit_registry_change_events (
        id, request_id, sequence, event_type, actor_id, reason_code, safe_summary_json, created_at
      )
      SELECT ?, id, 2, ?, ?, ?, ?, ?
      FROM app_audit_registry_change_requests
      WHERE id = ? AND status = ? AND version = ?
      `).bind(eventId, status, actor.id, review.reasonCode, JSON.stringify({
      actionKey: row.action_key,
      operation: row.operation,
      schemaVersion: row.proposed_schema_version,
      baselineChanged: status === 'stale',
    }), timestamp, row.id, status, nextVersion),
      db.prepare(`
      INSERT INTO app_audit_registry_commands (
        id, admin_id, command_scope, idempotency_key_hash, request_hash,
        request_id, result_status, created_at
      )
      SELECT ?, ?, 'review', ?, ?, id, ?, ?
      FROM app_audit_registry_change_requests
      WHERE id = ? AND status = ? AND version = ?
      `).bind(commandId, actor.id, idempotencyKeyHash, requestHash, status, timestamp, row.id, status, nextVersion),
      db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, 'app_audit_registry_change_request', id, ?, ?, ?
      FROM app_audit_registry_change_requests
      WHERE id = ? AND status = ? AND version = ?
      `).bind(
      auditId,
      actor.id,
      action,
      JSON.stringify({ status: 'pending_review', version: row.version }),
      JSON.stringify({
        status,
        version: nextVersion,
        actionKey: row.action_key,
        operation: row.operation,
        schemaVersion: row.proposed_schema_version,
        reviewReasonCode: review.reasonCode,
        hasReviewNote: true,
      }),
      timestamp,
      row.id,
      status,
      nextVersion,
    ),
      auditContextStatement(db, {
      auditId,
      context,
      idempotencyKeyHash,
      reasonCode: review.reasonCode,
      businessReference: row.action_key,
      targetVersion: String(row.proposed_schema_version),
      approvalRequestId: row.id,
      approvalStepId: 'registry_independent_review',
      policyVersion: row.proposed_retention_policy_reference,
      result: status === 'rejected' ? 'denied' : 'failed',
      errorCode: status === 'stale' ? 'APP_AUDIT_REGISTRY_BASELINE_CHANGED' : null,
      createdAt: timestamp,
      guardAuditId: auditId,
      }),
    ])
  }
  catch (error) {
    const replay = await findCommand(db, actor.id, 'review', idempotencyKeyHash)
    if (replay) return resolveReplay(db, actor, replay, requestHash)
    const latest = await requireRequestRow(db, row.id)
    if (latest.status !== 'pending_review' || latest.version !== row.version) {
      throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_REQUEST_VERSION_CONFLICT', '口径申请已被其他复核操作处理，请刷新后重试')
    }
    throw error
  }
  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const replay = await findCommand(db, actor.id, 'review', idempotencyKeyHash)
    if (replay) return resolveReplay(db, actor, replay, requestHash)
    throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_REQUEST_VERSION_CONFLICT', '口径申请状态或版本已变化，请刷新后重试')
  }
  return { request: await getAdminAppAuditRegistryRequest(db, actor.id, row.id), replayed: false }
}

async function buildPreview(
  db: D1Database,
  input: AdminAppAuditRegistryProposalInput,
  ignorePendingRequestId: string | null = null,
): Promise<AdminAppAuditRegistryPreview> {
  const actionKey = requiredPattern(input.actionKey, 'actionKey', ACTION_KEY)
  const operation = requiredEnum(input.operation, 'operation', OPERATIONS) as AdminAppAuditRegistryOperation
  const [latest, observation, pending] = await Promise.all([
    loadLatestDefinition(db, actionKey),
    loadObservation(db, actionKey),
    findPendingRequest(db, actionKey),
  ])
  const current = latest?.status === 'active' ? latest : null
  const proposal = operation === 'retire'
    ? proposalForRetirement(actionKey, latest, current)
    : proposalForPublication(actionKey, input, latest)
  const policyReadiness = operation === 'publish'
    ? await loadGovernancePolicyReadiness(
        db,
        proposal.retentionPolicyReference!,
        proposal.qualityRuleReference!,
      )
    : { retention: true, quality: true }
  const blockers: string[] = []
  const warnings: string[] = []
  if (pending && pending.id !== ignorePendingRequestId) blockers.push('该 Action 已有待独立复核的口径申请')
  if (observation.missingIndexCount > 0) blockers.push('该 Action 存在未建立稳定索引的审计事实，无法验证观察口径')
  if (observation.domains.length > 1) blockers.push('历史审计事实出现多个业务域，必须先修正 Action 产出契约')
  if (observation.riskLevels.length > 1) blockers.push('历史审计事实出现多个风险等级，必须先修正 Action 产出契约')
  if (observation.domains[0] && observation.domains[0] !== proposal.domain) {
    blockers.push(`候选业务域 ${proposal.domain} 与历史索引 ${observation.domains[0]} 不一致`)
  }
  if (observation.riskLevels[0] && observation.riskLevels[0] !== proposal.riskLevel) {
    blockers.push(`候选风险等级 ${proposal.riskLevel} 与历史索引 ${observation.riskLevels[0]} 不一致`)
  }
  if (operation === 'retire' && !current) blockers.push('只有当前 active 的 Action 才能申请退休')
  if (operation === 'publish' && current && sameDefinition(current, proposal)) {
    blockers.push('候选口径与当前 active 版本没有语义变化，无需新增版本')
  }
  if (operation === 'publish' && !policyReadiness.retention) {
    blockers.push('保留策略引用尚未进入已批准且 production-ready 的治理目录')
  }
  if (operation === 'publish' && !policyReadiness.quality) {
    blockers.push('质量规则引用尚未进入已批准且 production-ready 的治理目录')
  }
  if (observation.eventCount === 0) warnings.push('这是尚无审计事实的前置登记，复核人需要额外确认代码产出契约')
  else warnings.push(`发布后会以当前口径解释 ${observation.eventCount} 条既有审计事实，但不会改写原始记录`)
  if (latest?.status === 'retired' && operation === 'publish') warnings.push('该 Action 当前已退休，本次发布会以新版本重新激活')
  if (operation === 'retire' && observation.eventCount > 0) warnings.push('退休后既有事实仍保留，但完整性检查会把该 Action 视为当前未登记')
  return {
    proposal,
    currentDefinition: current,
    latestDefinition: latest,
    observation,
    affectedHistoricalEventCount: observation.eventCount,
    blockers,
    warnings,
    canSubmit: blockers.length === 0,
  }
}

function proposalForPublication(
  actionKey: string,
  input: AdminAppAuditRegistryProposalInput,
  latest: AdminAppAuditRegistryDefinition | null,
): AdminAppAuditRegistryProposal {
  return {
    actionKey,
    operation: 'publish',
    schemaVersion: (latest?.schemaVersion ?? 0) + 1,
    domain: requiredPattern(input.domain, 'domain', DOMAIN_KEY),
    displayName: requiredText(input.displayName, 'displayName', 1, 120),
    ownerReference: requiredReference(input.ownerReference, 'ownerReference'),
    sensitivity: requiredEnum(input.sensitivity, 'sensitivity', SENSITIVITIES) as AdminAppAuditRegistrySensitivity,
    riskLevel: requiredEnum(input.riskLevel, 'riskLevel', RISK_LEVELS) as AdminAppAuditRegistryRiskLevel,
    visibleRoles: normalizeVisibleRoles(input.visibleRoles),
    retentionPolicyReference: requiredReference(input.retentionPolicyReference, 'retentionPolicyReference'),
    qualityRuleReference: requiredReference(input.qualityRuleReference, 'qualityRuleReference'),
  }
}

function proposalForRetirement(
  actionKey: string,
  latest: AdminAppAuditRegistryDefinition | null,
  current: AdminAppAuditRegistryDefinition | null,
): AdminAppAuditRegistryProposal {
  const source = current ?? latest
  if (!source) {
    return {
      actionKey,
      operation: 'retire',
      schemaVersion: 1,
      domain: 'audit',
      displayName: actionKey,
      ownerReference: 'unregistered',
      sensitivity: 'restricted',
      riskLevel: 'high',
      visibleRoles: ['owner'],
      retentionPolicyReference: null,
      qualityRuleReference: null,
    }
  }
  return {
    actionKey,
    operation: 'retire',
    schemaVersion: source.schemaVersion + 1,
    domain: source.domain,
    displayName: source.displayName,
    ownerReference: source.ownerReference,
    sensitivity: source.sensitivity,
    riskLevel: source.riskLevel,
    visibleRoles: source.visibleRoles,
    retentionPolicyReference: source.retentionPolicyReference,
    qualityRuleReference: source.qualityRuleReference,
  }
}

async function loadActionSummaries(db: D1Database): Promise<AdminAppAuditRegistryActionSummary[]> {
  const rows = await db.prepare(`
    WITH action_keys AS (
      SELECT action AS action_key FROM admin_audit_logs
      UNION
      SELECT action_key FROM app_audit_action_registry
    ),
    latest_version AS (
      SELECT action_key, MAX(schema_version) AS schema_version
      FROM app_audit_action_registry
      GROUP BY action_key
    ),
    latest AS (
      SELECT registry.*
      FROM app_audit_action_registry registry
      JOIN latest_version version
        ON version.action_key = registry.action_key
       AND version.schema_version = registry.schema_version
    ),
    pending AS (
      SELECT request.*
      FROM app_audit_registry_change_requests request
      WHERE request.status = 'pending_review'
    )
    SELECT keys.action_key,
           latest.id AS registry_id,
           latest.schema_version,
           latest.domain,
           latest.display_name,
           latest.owner_reference,
           latest.sensitivity,
           latest.risk_level,
           latest.visible_roles_json,
           latest.retention_policy_reference,
           latest.quality_rule_reference,
           latest.status AS registry_status,
           latest.created_by AS registry_created_by,
           latest.created_at AS registry_created_at,
           registry_creator.role AS registry_creator_role,
           registry_creator.email AS registry_creator_email,
           registry_creator.nickname AS registry_creator_nickname,
           CASE WHEN retention.decision_status = 'approved' AND retention.production_ready = 1 THEN 1 ELSE 0 END AS retention_policy_ready,
           CASE WHEN quality.decision_status = 'approved' AND quality.production_ready = 1 THEN 1 ELSE 0 END AS quality_rule_ready,
           COUNT(audit.id) AS event_count,
           SUM(CASE WHEN audit.id IS NOT NULL AND audit_index.audit_event_id IS NULL THEN 1 ELSE 0 END) AS missing_index_count,
           MIN(audit.created_at) AS first_seen_at,
           MAX(audit.created_at) AS last_seen_at,
           GROUP_CONCAT(DISTINCT audit_index.action_domain) AS observed_domains,
           GROUP_CONCAT(DISTINCT audit_index.risk_level) AS observed_risk_levels,
           pending.id AS pending_request_id,
           pending.operation AS pending_operation,
           pending.requested_by AS pending_requested_by,
           pending.created_at AS pending_created_at,
           pending_requester.role AS pending_requester_role,
           pending_requester.email AS pending_requester_email,
           pending_requester.nickname AS pending_requester_nickname
    FROM action_keys keys
    LEFT JOIN latest ON latest.action_key = keys.action_key
    LEFT JOIN users registry_creator ON registry_creator.id = latest.created_by
    LEFT JOIN app_audit_current_governance_policies retention
      ON retention.reference_key = latest.retention_policy_reference
     AND retention.policy_type = 'retention'
    LEFT JOIN app_audit_current_governance_policies quality
      ON quality.reference_key = latest.quality_rule_reference
     AND quality.policy_type = 'quality'
    LEFT JOIN admin_audit_logs audit ON audit.action = keys.action_key
    LEFT JOIN app_audit_event_index audit_index ON audit_index.audit_event_id = audit.id
    LEFT JOIN pending ON pending.action_key = keys.action_key
    LEFT JOIN users pending_requester ON pending_requester.id = pending.requested_by
    GROUP BY keys.action_key
    ORDER BY
      CASE WHEN pending.id IS NOT NULL THEN 0 WHEN latest.status = 'active' THEN 2 ELSE 1 END,
      MAX(audit.created_at) DESC,
      keys.action_key ASC
  `).all<ActionRow>()
  return Promise.all(rows.results.map(mapActionSummary))
}

async function mapActionSummary(row: ActionRow): Promise<AdminAppAuditRegistryActionSummary> {
  const latestDefinition = row.registry_id ? mapDefinition({
    id: row.registry_id,
    action_key: row.action_key,
    schema_version: Number(row.schema_version),
    domain: row.domain!,
    display_name: row.display_name!,
    owner_reference: row.owner_reference!,
    sensitivity: row.sensitivity!,
    risk_level: row.risk_level!,
    visible_roles_json: row.visible_roles_json!,
    retention_policy_reference: row.retention_policy_reference,
    quality_rule_reference: row.quality_rule_reference,
    status: row.registry_status!,
    created_by: Number(row.registry_created_by),
    created_at: row.registry_created_at!,
    creator_role: row.registry_creator_role,
    creator_email: row.registry_creator_email,
    creator_nickname: row.registry_creator_nickname,
    retention_policy_ready: Number(row.retention_policy_ready ?? 0),
    quality_rule_ready: Number(row.quality_rule_ready ?? 0),
  }) : null
  const observation = await mapObservation(row.action_key, row)
  const inconsistent = observation.missingIndexCount > 0
    || observation.domains.length > 1
    || observation.riskLevels.length > 1
    || Boolean(latestDefinition?.status === 'active' && observation.domains[0] && latestDefinition.domain !== observation.domains[0])
    || Boolean(latestDefinition?.status === 'active' && observation.riskLevels[0] && latestDefinition.riskLevel !== observation.riskLevels[0])
  let governanceState: AdminAppAuditRegistryActionSummary['governanceState']
  if (row.pending_request_id) governanceState = 'pending_review'
  else if (inconsistent) governanceState = 'inconsistent'
  else if (latestDefinition?.status === 'active') governanceState = 'active'
  else if (latestDefinition?.status === 'retired') governanceState = 'retired'
  else governanceState = 'unregistered'
  return {
    actionKey: row.action_key,
    governanceState,
    latestDefinition,
    observation,
    pendingRequest: row.pending_request_id ? {
      requestId: row.pending_request_id,
      operation: row.pending_operation!,
      requestedBy: mapActor(
        Number(row.pending_requested_by),
        row.pending_requester_role,
        row.pending_requester_email,
        row.pending_requester_nickname,
      ),
      createdAt: row.pending_created_at!,
    } : null,
  }
}

async function loadObservation(db: D1Database, actionKey: string): Promise<AdminAppAuditRegistryObservation> {
  const row = await db.prepare(`
    SELECT COUNT(audit.id) AS event_count,
           SUM(CASE WHEN audit.id IS NOT NULL AND audit_index.audit_event_id IS NULL THEN 1 ELSE 0 END) AS missing_index_count,
           MIN(audit.created_at) AS first_seen_at,
           MAX(audit.created_at) AS last_seen_at,
           GROUP_CONCAT(DISTINCT audit_index.action_domain) AS observed_domains,
           GROUP_CONCAT(DISTINCT audit_index.risk_level) AS observed_risk_levels
    FROM admin_audit_logs audit
    LEFT JOIN app_audit_event_index audit_index ON audit_index.audit_event_id = audit.id
    WHERE audit.action = ?
  `).bind(actionKey).first<ObservationRow>()
  return mapObservation(actionKey, row ?? {
    event_count: 0,
    missing_index_count: 0,
    first_seen_at: null,
    last_seen_at: null,
    observed_domains: null,
    observed_risk_levels: null,
  })
}

async function mapObservation(actionKey: string, row: ObservationRow): Promise<AdminAppAuditRegistryObservation> {
  const domains = splitDistinct(row.observed_domains)
  const riskLevels = splitDistinct(row.observed_risk_levels)
    .filter(value => RISK_LEVELS.has(value)) as AdminAppAuditRegistryRiskLevel[]
  const missingIndexCount = Number(row.missing_index_count ?? 0)
  return {
    eventCount: Number(row.event_count ?? 0),
    missingIndexCount,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    domains,
    riskLevels,
    observationDigest: await sha256Hex(stableStringify({
      actionKey,
      domains,
      riskLevels,
      hasMissingIndex: missingIndexCount > 0,
    })),
  }
}

async function loadLatestDefinition(db: D1Database, actionKey: string) {
  const row = await db.prepare(`
    ${definitionSelect()}
    WHERE registry.action_key = ?
    ORDER BY registry.schema_version DESC
    LIMIT 1
  `).bind(actionKey).first<DefinitionRow>()
  return row ? mapDefinition(row) : null
}

async function loadGovernancePolicyReadiness(
  db: D1Database,
  retentionReference: string,
  qualityReference: string,
) {
  const rows = await db.prepare(`
    SELECT reference_key, policy_type, decision_status, production_ready
    FROM app_audit_current_governance_policies
    WHERE (reference_key = ? AND policy_type = 'retention')
       OR (reference_key = ? AND policy_type = 'quality')
  `).bind(retentionReference, qualityReference).all<{
    reference_key: string
    policy_type: 'retention' | 'quality'
    decision_status: 'unresolved' | 'approved'
    production_ready: number
  }>()
  return {
    retention: rows.results.some(row => row.policy_type === 'retention'
      && row.reference_key === retentionReference
      && row.decision_status === 'approved'
      && row.production_ready === 1),
    quality: rows.results.some(row => row.policy_type === 'quality'
      && row.reference_key === qualityReference
      && row.decision_status === 'approved'
      && row.production_ready === 1),
  }
}

function mapDefinition(row: DefinitionRow): AdminAppAuditRegistryDefinition {
  const visibleRoles = parseVisibleRoles(row.visible_roles_json)
  return {
    registryId: row.id,
    actionKey: row.action_key,
    schemaVersion: Number(row.schema_version),
    domain: row.domain,
    displayName: row.display_name,
    ownerReference: row.owner_reference,
    sensitivity: row.sensitivity,
    riskLevel: row.risk_level,
    visibleRoles,
    retentionPolicyReference: row.retention_policy_reference,
    qualityRuleReference: row.quality_rule_reference,
    status: row.status,
    createdBy: mapActor(row.created_by, row.creator_role, row.creator_email, row.creator_nickname),
    createdAt: row.created_at,
    productionReady: row.status === 'active'
      && visibleRoles.includes('owner')
      && Boolean(row.retention_policy_reference)
      && Boolean(row.quality_rule_reference)
      && Number(row.retention_policy_ready) === 1
      && Number(row.quality_rule_ready) === 1,
  }
}

async function mapRequest(
  db: D1Database,
  row: RequestRow,
  actor: ActorRow,
  includeEvents: boolean,
): Promise<AdminAppAuditRegistryRequest> {
  const proposal = proposalFromRequest(row)
  const [latestDefinition, observation, policyReadiness, events] = await Promise.all([
    loadLatestDefinition(db, row.action_key),
    loadObservation(db, row.action_key),
    proposal.operation === 'publish'
      ? loadGovernancePolicyReadiness(
          db,
          proposal.retentionPolicyReference!,
          proposal.qualityRuleReference!,
        )
      : Promise.resolve({ retention: true, quality: true }),
    includeEvents ? loadRequestEvents(db, row.id) : Promise.resolve([]),
  ])
  const governanceReady = policyReadiness.retention && policyReadiness.quality
  const pendingBaselineChanged = (latestDefinition?.schemaVersion ?? null) !== row.expected_current_schema_version
    || observation.observationDigest !== row.observation_digest
    || !governanceReady
  return {
    requestId: row.id,
    operation: row.operation,
    proposal,
    baseline: {
      expectedCurrentSchemaVersion: row.expected_current_schema_version,
      observationDigest: row.observation_digest,
      observedEventCount: Number(row.observed_event_count),
      observedFirstAt: row.observed_first_at,
      observedLastAt: row.observed_last_at,
    },
    requestReason: row.request_reason,
    status: row.status,
    version: Number(row.version),
    requestedBy: mapActor(row.requested_by, row.requester_role, row.requester_email, row.requester_nickname),
    reviewedBy: row.reviewed_by === null ? null : mapActor(row.reviewed_by, row.reviewer_role, row.reviewer_email, row.reviewer_nickname),
    reviewReasonCode: row.review_reason_code,
    reviewNote: row.review_note,
    resultRegistryId: row.result_registry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    appliedAt: row.applied_at,
    canReview: row.status === 'pending_review' && row.requested_by !== actor.id,
    currentState: {
      latestDefinition,
      observation,
      governanceReady,
      baselineChanged: row.status === 'stale'
        || (row.status === 'pending_review' && pendingBaselineChanged),
    },
    events,
  }
}

async function loadRequestEvents(db: D1Database, requestId: string) {
  const rows = await db.prepare(`
    SELECT event.id, event.sequence, event.event_type, event.actor_id,
           actor.role AS actor_role, actor.email AS actor_email, actor.nickname AS actor_nickname,
           event.reason_code, event.safe_summary_json, event.created_at
    FROM app_audit_registry_change_events event
    LEFT JOIN users actor ON actor.id = event.actor_id
    WHERE event.request_id = ?
    ORDER BY event.sequence ASC
  `).bind(requestId).all<RequestEventRow>()
  return rows.results.map(row => ({
    eventId: row.id,
    sequence: Number(row.sequence),
    type: row.event_type,
    actor: mapActor(row.actor_id, row.actor_role, row.actor_email, row.actor_nickname),
    reasonCode: row.reason_code,
    summary: safeJsonObject(row.safe_summary_json),
    createdAt: row.created_at,
  }))
}

async function requireRequestRow(db: D1Database, requestId: string) {
  const row = await db.prepare(`
    ${requestSelect()}
    WHERE request.id = ?
    LIMIT 1
  `).bind(requestId).first<RequestRow>()
  if (!row) throw new AdminAppAuditRegistryError(404, 'APP_AUDIT_REGISTRY_REQUEST_NOT_FOUND', 'Action 口径申请不存在')
  return row
}

async function findPendingRequest(db: D1Database, actionKey: string) {
  return db.prepare(`
    SELECT id, action_key, operation, requested_by, created_at
    FROM app_audit_registry_change_requests
    WHERE action_key = ? AND status = 'pending_review'
    LIMIT 1
  `).bind(actionKey).first<{
    id: string
    action_key: string
    operation: AdminAppAuditRegistryOperation
    requested_by: number
    created_at: string
  }>()
}

async function findCommand(
  db: D1Database,
  adminId: number,
  scope: 'create' | 'review',
  idempotencyKeyHash: string,
) {
  return db.prepare(`
    SELECT request_hash, request_id, result_status
    FROM app_audit_registry_commands
    WHERE admin_id = ? AND command_scope = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(adminId, scope, idempotencyKeyHash).first<CommandRow>()
}

async function resolveReplay(
  db: D1Database,
  actor: ActorRow,
  command: CommandRow,
  requestHash: string,
): Promise<{ request: AdminAppAuditRegistryRequest; replayed: boolean }> {
  if (command.request_hash !== requestHash) {
    throw new AdminAppAuditRegistryError(409, 'APP_AUDIT_REGISTRY_IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于不同的 Action 口径请求')
  }
  return {
    request: await getAdminAppAuditRegistryRequest(db, actor.id, command.request_id),
    replayed: true,
  }
}

function requestSelect() {
  return `
    SELECT request.*,
           requester.role AS requester_role,
           requester.email AS requester_email,
           requester.nickname AS requester_nickname,
           reviewer.role AS reviewer_role,
           reviewer.email AS reviewer_email,
           reviewer.nickname AS reviewer_nickname
    FROM app_audit_registry_change_requests request
    LEFT JOIN users requester ON requester.id = request.requested_by
    LEFT JOIN users reviewer ON reviewer.id = request.reviewed_by
  `
}

function definitionSelect() {
  return `
    SELECT registry.*,
           creator.role AS creator_role,
           creator.email AS creator_email,
           creator.nickname AS creator_nickname,
           CASE WHEN retention.decision_status = 'approved' AND retention.production_ready = 1 THEN 1 ELSE 0 END AS retention_policy_ready,
           CASE WHEN quality.decision_status = 'approved' AND quality.production_ready = 1 THEN 1 ELSE 0 END AS quality_rule_ready
    FROM app_audit_action_registry registry
    LEFT JOIN users creator ON creator.id = registry.created_by
    LEFT JOIN app_audit_current_governance_policies retention
      ON retention.reference_key = registry.retention_policy_reference
     AND retention.policy_type = 'retention'
    LEFT JOIN app_audit_current_governance_policies quality
      ON quality.reference_key = registry.quality_rule_reference
     AND quality.policy_type = 'quality'
  `
}

function auditContextStatement(db: D1Database, value: {
  auditId: string
  context: AdminAppAuditRegistryRequestContext
  idempotencyKeyHash: string
  reasonCode: string
  businessReference: string
  targetVersion: string
  approvalRequestId: string
  approvalStepId?: string | null
  policyVersion: string | null
  result: 'succeeded' | 'denied' | 'failed'
  errorCode?: string | null
  createdAt: string
  guardAuditId?: string
}) {
  return db.prepare(`
    INSERT INTO app_audit_event_contexts (
      audit_event_id, request_id, trace_id, idempotency_key_hash, reason_code,
      business_reference, target_version, approval_request_id, approval_step_id,
      policy_version, capability, scope_summary, result, error_code, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audit.registry.manage', ?, ?, ?, ?
    FROM admin_audit_logs audit
    WHERE audit.id = ?
  `).bind(
    value.auditId,
    normalizeCorrelationId(value.context.requestId),
    normalizeOptionalCorrelationId(value.context.traceId),
    value.idempotencyKeyHash,
    value.reasonCode,
    value.businessReference,
    value.targetVersion,
    value.approvalRequestId,
    value.approvalStepId ?? null,
    value.policyVersion,
    JSON.stringify({ actionKey: value.businessReference, schemaVersion: value.targetVersion }),
    value.result,
    value.errorCode ?? null,
    value.createdAt,
    value.guardAuditId ?? value.auditId,
  )
}

async function requireActiveOwner(db: D1Database, adminId: number) {
  const actor = await db.prepare(`
    SELECT id, role, status, email, nickname
    FROM users
    WHERE id = ? AND role = 'owner' AND status = 'active'
    LIMIT 1
  `).bind(adminId).first<ActorRow>()
  if (!actor) throw new AdminAppAuditRegistryError(403, 'APP_AUDIT_REGISTRY_OWNER_REQUIRED', '只有有效 Owner 可以管理 Action 口径')
  return actor
}

function normalizeReview(input: AdminAppAuditRegistryReviewInput): NormalizedReview {
  const decision = requiredEnum(input.decision, 'decision', REVIEW_DECISIONS) as 'approve' | 'reject'
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    decision,
    reasonCode: requiredEnum(
      input.reasonCode,
      'reasonCode',
      decision === 'approve' ? APPROVE_REASON_CODES : REJECT_REASON_CODES,
    ),
    reviewNote: requiredText(input.reviewNote, 'reviewNote', 10, 1000),
  }
}

function proposalFromRequest(row: RequestRow): AdminAppAuditRegistryProposal {
  return {
    actionKey: row.action_key,
    operation: row.operation,
    schemaVersion: Number(row.proposed_schema_version),
    domain: row.proposed_domain,
    displayName: row.proposed_display_name,
    ownerReference: row.proposed_owner_reference,
    sensitivity: row.proposed_sensitivity,
    riskLevel: row.proposed_risk_level,
    visibleRoles: parseVisibleRoles(row.proposed_visible_roles_json),
    retentionPolicyReference: row.proposed_retention_policy_reference,
    qualityRuleReference: row.proposed_quality_rule_reference,
  }
}

function proposalInputFromRequest(row: RequestRow): AdminAppAuditRegistryProposalInput {
  return {
    actionKey: row.action_key,
    operation: row.operation,
    domain: row.proposed_domain,
    displayName: row.proposed_display_name,
    ownerReference: row.proposed_owner_reference,
    sensitivity: row.proposed_sensitivity,
    riskLevel: row.proposed_risk_level,
    visibleRoles: parseVisibleRoles(row.proposed_visible_roles_json),
    retentionPolicyReference: row.proposed_retention_policy_reference,
    qualityRuleReference: row.proposed_quality_rule_reference,
  }
}

function sameDefinition(current: AdminAppAuditRegistryDefinition, proposal: AdminAppAuditRegistryProposal) {
  return current.domain === proposal.domain
    && current.displayName === proposal.displayName
    && current.ownerReference === proposal.ownerReference
    && current.sensitivity === proposal.sensitivity
    && current.riskLevel === proposal.riskLevel
    && stableStringify(current.visibleRoles) === stableStringify(proposal.visibleRoles)
    && current.retentionPolicyReference === proposal.retentionPolicyReference
    && current.qualityRuleReference === proposal.qualityRuleReference
}

function observationConflictsWithDefinition(
  observation: AdminAppAuditRegistryObservation,
  definition: AdminAppAuditRegistryDefinition | null,
) {
  return observation.missingIndexCount > 0
    || observation.domains.length > 1
    || observation.riskLevels.length > 1
    || Boolean(definition?.status === 'active' && observation.domains[0] && definition.domain !== observation.domains[0])
    || Boolean(definition?.status === 'active' && observation.riskLevels[0] && definition.riskLevel !== observation.riskLevels[0])
}

function safeDefinition(value: AdminAppAuditRegistryDefinition) {
  return {
    registryId: value.registryId,
    actionKey: value.actionKey,
    schemaVersion: value.schemaVersion,
    status: value.status,
    domain: value.domain,
    sensitivity: value.sensitivity,
    riskLevel: value.riskLevel,
    visibleRoles: value.visibleRoles,
    retentionPolicyReference: value.retentionPolicyReference,
    qualityRuleReference: value.qualityRuleReference,
  }
}

function safeProposal(value: AdminAppAuditRegistryProposal) {
  return {
    actionKey: value.actionKey,
    operation: value.operation,
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    sensitivity: value.sensitivity,
    riskLevel: value.riskLevel,
    visibleRoles: value.visibleRoles,
    retentionPolicyReference: value.retentionPolicyReference,
    qualityRuleReference: value.qualityRuleReference,
  }
}

function mapActor(id: number, role: string | null, email: string | null, nickname: string | null): AdminAppAuditRegistryActor {
  return {
    id: Number(id),
    role: role ?? 'unknown',
    label: nickname?.trim() || maskEmail(email) || `管理员 #${id}`,
  }
}

function maskEmail(value: string | null) {
  if (!value) return ''
  const [local, domain] = value.split('@')
  if (!local || !domain) return '管理员账号'
  return `${local.slice(0, 2)}***@${domain}`
}

function splitDistinct(value: string | null) {
  return value ? [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))].sort() : []
}

function parseVisibleRoles(value: string): Array<'admin' | 'owner'> {
  try {
    return normalizeVisibleRoles(JSON.parse(value))
  }
  catch {
    return ['owner']
  }
}

function normalizeVisibleRoles(value: unknown): Array<'admin' | 'owner'> {
  if (!Array.isArray(value)) throw invalidField('visibleRoles')
  const roles = [...new Set(value.map(item => typeof item === 'string' ? item.trim() : ''))]
  if (roles.some(role => role !== 'admin' && role !== 'owner') || !roles.includes('owner')) {
    throw new AdminAppAuditRegistryError(400, 'APP_AUDIT_REGISTRY_VISIBLE_ROLES_INVALID', '可见角色只允许 admin/owner，且必须包含 owner')
  }
  return (roles.includes('admin') ? ['admin', 'owner'] : ['owner']) as Array<'admin' | 'owner'>
}

function normalizeRequestId(value: string) {
  const normalized = value.trim()
  if (!REQUEST_ID.test(normalized)) throw invalidField('requestId')
  return normalized
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AdminAppAuditRegistryError(400, 'APP_AUDIT_REGISTRY_IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 格式错误')
  }
  return normalized
}

function requiredPattern(value: unknown, field: string, pattern: RegExp) {
  if (typeof value !== 'string') throw invalidField(field)
  const normalized = value.trim()
  if (!pattern.test(normalized)) throw invalidField(field)
  return normalized
}

function optionalPattern(value: unknown, field: string, pattern: RegExp) {
  if (value == null || value === '') return null
  return requiredPattern(value, field, pattern)
}

function requiredReference(value: unknown, field: string) {
  return requiredPattern(value, field, REFERENCE)
}

function requiredEnum(value: unknown, field: string, values: Set<string>) {
  if (typeof value !== 'string' || !values.has(value)) throw invalidField(field)
  return value
}

function optionalEnum(value: unknown, field: string, values: Set<string>) {
  if (value == null || value === '') return null
  return requiredEnum(value, field, values)
}

function requiredText(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') throw invalidField(field)
  const normalized = value.trim()
  const length = Array.from(normalized).length
  if (length < minimum || length > maximum) throw invalidField(field)
  return normalized
}

function optionalText(value: unknown, field: string, minimum: number, maximum: number) {
  if (value == null || value === '') return null
  return requiredText(value, field, minimum, maximum)
}

function positiveInteger(value: unknown, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw invalidField(field)
  return parsed
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string) {
  if (value == null || value === '') return fallback
  const parsed = positiveInteger(value, field)
  if (parsed < minimum || parsed > maximum) throw invalidField(field)
  return parsed
}

function invalidField(field: string) {
  return new AdminAppAuditRegistryError(400, 'APP_AUDIT_REGISTRY_FIELD_INVALID', `${field} 格式错误`)
}

function normalizeCorrelationId(value: string) {
  const normalized = value.trim()
  return normalized && normalized.length <= 192 ? normalized : crypto.randomUUID()
}

function normalizeOptionalCorrelationId(value: string | null | undefined) {
  if (!value) return null
  const normalized = value.trim()
  return normalized && normalized.length <= 192 ? normalized : null
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
