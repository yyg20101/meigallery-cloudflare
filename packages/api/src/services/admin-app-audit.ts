import { generateId } from '../utils/db'

const AUDIT_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/u
const AUDIT_CHECK_ID = /^aaic_[A-Za-z0-9_-]{1,90}$/u
const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u
const DOMAIN_KEY = /^[a-z][a-z0-9_-]{0,47}$/u
const TARGET_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const MAX_QUERY_DAYS = 31
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 30
const DEFAULT_QUERY_DAYS = 7
const MAX_INTEGRITY_RANGE = 5_000
const DEFAULT_INTEGRITY_RANGE = 1_000
const MAX_PERSISTED_FINDINGS = 50
const MAX_BUSINESS_GAP_SAMPLES_PER_TYPE = 12
const AUDIT_MANIFEST_VERSION = 'app-audit-manifest-v1'

const PURPOSES = new Set([
  'operational_investigation',
  'security_review',
  'financial_reconciliation',
  'compliance_audit',
])
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical'])
const RESULTS = new Set(['succeeded', 'denied', 'failed'])

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'access_token',
  'refresh_token',
  'session_token',
  'token',
  'token_hash',
  'secret',
  'credential',
  'credentials',
  'cookie',
  'authorization',
  'signed_url',
  'signedurl',
  'r2_key',
  'stream_token',
  'message',
  'message_body',
  'body',
  'internal_note',
  'internal_notes',
  'note',
  'notes',
  'review_note',
  'submit_note',
  'transfer_note',
  'handoff_note',
  'reason_text',
  'internal_reason',
  'user_explanation',
  'evidence',
  'evidence_body',
  'document_body',
  'raw_document',
  'ip',
  'ip_address',
  'user_agent',
  'email',
  'phone',
  'phone_number',
  'precise_location',
  'street_address',
])

export type AdminAppAuditRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type AdminAppAuditResult = 'succeeded' | 'denied' | 'failed'
export type AdminAppAuditPurpose =
  | 'operational_investigation'
  | 'security_review'
  | 'financial_reconciliation'
  | 'compliance_audit'

export interface AdminAppAuditActor {
  id: number
  role: string
  label: string
}

export interface AdminAppAuditRegistryEntry {
  actionKey: string
  schemaVersion: number
  displayName: string
  ownerReference: string
  sensitivity: 'internal' | 'restricted' | 'highly_restricted'
  status: 'active' | 'retired'
}

export interface AdminAppAuditContext {
  requestId: string | null
  traceId: string | null
  reasonCode: string | null
  businessReference: string | null
  targetVersion: string | null
  approvalRequestId: string | null
  approvalStepId: string | null
  policyVersion: string | null
  capability: string | null
  scopeSummary: string | null
  errorCode: string | null
}

export interface AdminAppAuditEventSummary {
  eventId: string
  sequence: number
  occurredAt: string
  actor: AdminAppAuditActor
  action: string
  actionDisplayName: string
  domain: string
  riskLevel: AdminAppAuditRiskLevel
  result: AdminAppAuditResult
  target: {
    type: string
    id: string | null
  }
  context: AdminAppAuditContext
  registry: AdminAppAuditRegistryEntry | null
  payloadState: {
    before: 'empty' | 'valid' | 'invalid'
    after: 'empty' | 'valid' | 'invalid'
  }
}

export interface AdminAppAuditRedactedPayload {
  state: 'empty' | 'valid' | 'invalid'
  digest: string | null
  value: unknown
  redactedFieldCount: number
}

export interface AdminAppAuditEventDetail extends AdminAppAuditEventSummary {
  before: AdminAppAuditRedactedPayload
  after: AdminAppAuditRedactedPayload
  relatedEvents: AdminAppAuditEventSummary[]
  explanation: {
    who: string
    when: string
    what: string
    target: string
    why: string
    result: string
    approval: string
  }
}

export interface AdminAppAuditEventList {
  events: AdminAppAuditEventSummary[]
  nextCursor: string | null
  appliedRange: { from: string; to: string; maxDays: number }
  summary: {
    total: number
    critical: number
    high: number
    unregistered: number
  }
  filterOptions: {
    actions: Array<{ value: string; label: string }>
    domains: string[]
  }
  visibility: 'all' | 'self'
}

export interface AdminAppAuditIntegrityFinding {
  findingId: string
  type:
    | 'sequence_gap'
    | 'missing_index'
    | 'malformed_payload'
    | 'sensitive_key'
    | 'unregistered_action'
    | 'business_without_audit'
    | 'manifest_changed'
  severity: 'info' | 'warning' | 'critical'
  sequence: number | null
  eventId: string | null
  evidenceDigest: string
  summaryCode: string
}

export interface AdminAppAuditIntegrityCheck {
  checkId: string
  startSequence: number
  endSequence: number
  eventCount: number
  manifestVersion: string
  manifestDigest: string
  status: 'passed' | 'findings'
  counts: {
    sequenceGap: number
    missingIndex: number
    malformedPayload: number
    sensitiveKey: number
    unregisteredAction: number
    businessWithoutAudit: number
  }
  previousManifestCheckId: string | null
  createdBy: AdminAppAuditActor
  createdAt: string
  findings: AdminAppAuditIntegrityFinding[]
}

export interface AdminAppAuditIntegrityOverview {
  sourceEventCount: number
  indexedEventCount: number
  minimumSequence: number | null
  maximumSequence: number | null
  missingIndexCount: number
  activeRegistryCount: number
  distinctActionCount: number
  unregisteredActionCount: number
  latestCheck: AdminAppAuditIntegrityCheck | null
  productionReady: boolean
  blockers: string[]
}

export interface AdminAppAuditListInput {
  purpose?: unknown
  from?: unknown
  to?: unknown
  action?: unknown
  domain?: unknown
  riskLevel?: unknown
  result?: unknown
  targetType?: unknown
  targetId?: unknown
  actorId?: unknown
  requestId?: unknown
  traceId?: unknown
  businessReference?: unknown
  cursor?: unknown
  limit?: unknown
}

export interface AdminAppAuditIntegrityInput {
  startSequence?: unknown
  endSequence?: unknown
}

export interface AdminAppAuditRequestContext {
  requestId: string
  traceId?: string | null
}

type AuditEventRow = {
  sequence: number
  audit_event_id: string
  actor_role_snapshot: string
  action_domain: string
  risk_level: AdminAppAuditRiskLevel
  result: AdminAppAuditResult
  occurred_at: string
  admin_id: number
  admin_email: string | null
  admin_nickname: string | null
  action: string
  target_type: string
  target_id: string | null
  before_value: string | null
  after_value: string | null
  request_id: string | null
  trace_id: string | null
  reason_code: string | null
  business_reference: string | null
  target_version: string | null
  approval_request_id: string | null
  approval_step_id: string | null
  policy_version: string | null
  capability: string | null
  scope_summary: string | null
  error_code: string | null
  registry_action_key: string | null
  registry_schema_version: number | null
  registry_display_name: string | null
  registry_owner_reference: string | null
  registry_sensitivity: AdminAppAuditRegistryEntry['sensitivity'] | null
  registry_status: AdminAppAuditRegistryEntry['status'] | null
}

export type ActorRow = {
  id: number
  role: string
  status: string
  email: string
  nickname: string | null
}

type IntegrityCheckRow = {
  id: string
  start_sequence: number
  end_sequence: number
  event_count: number
  manifest_version: string
  manifest_digest: string
  status: 'passed' | 'findings'
  sequence_gap_count: number
  missing_index_count: number
  malformed_payload_count: number
  sensitive_key_count: number
  unregistered_action_count: number
  business_without_audit_count: number
  previous_manifest_check_id: string | null
  created_by: number
  created_at: string
  actor_role: string
  actor_email: string | null
  actor_nickname: string | null
}

type IntegrityFindingRow = {
  id: string
  finding_type: AdminAppAuditIntegrityFinding['type']
  severity: AdminAppAuditIntegrityFinding['severity']
  sequence: number | null
  audit_event_id: string | null
  evidence_digest: string
  summary_code: string
}

type IntegrityCommandRow = {
  request_hash: string
  check_id: string
}

export type NormalizedAuditQuery = {
  purpose: AdminAppAuditPurpose
  from: string
  to: string
  action: string | null
  domain: string | null
  riskLevel: AdminAppAuditRiskLevel | null
  result: AdminAppAuditResult | null
  targetType: string | null
  targetId: string | null
  actorId: number | null
  requestId: string | null
  traceId: string | null
  businessReference: string | null
  cursor: string | null
  limit: number
}

type IntegrityCandidate = {
  sequence: number
  audit_event_id: string
  admin_id: number
  actor_role_snapshot: string
  action_domain: string
  risk_level: AdminAppAuditRiskLevel
  index_result: AdminAppAuditResult
  action: string
  target_type: string
  target_id: string | null
  before_value: string | null
  after_value: string | null
  occurred_at: string
  request_id: string | null
  trace_id: string | null
  idempotency_key_hash: string | null
  reason_code: string | null
  business_reference: string | null
  target_version: string | null
  approval_request_id: string | null
  approval_step_id: string | null
  policy_version: string | null
  capability: string | null
  scope_summary: string | null
  context_result: AdminAppAuditResult | null
  error_code: string | null
  registry_action_key: string | null
}

type BusinessAuditGapRow = {
  fact_type: string
  fact_id: string
  fact_time: string
  total_count: number
}

type BusinessAuditGap = {
  factType: string
  factId: string
  factTime: string
}

export class AdminAppAuditError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface AdminAppAuditPreparedQuery {
  actor: ActorRow
  query: NormalizedAuditQuery
  filters: { conditions: string[]; params: unknown[] }
  fingerprint: string
  visibility: 'all' | 'self'
  ownerId: number | null
}

export async function prepareAdminAppAuditQuery(
  db: D1Database,
  adminId: number,
  input: AdminAppAuditListInput,
  now = new Date(),
): Promise<AdminAppAuditPreparedQuery> {
  const actor = await requireActiveAdmin(db, adminId)
  const query = await normalizeAuditQuery(input, actor, now)
  const ownerId = actor.role === 'owner' ? null : actor.id
  return {
    actor,
    query,
    filters: buildAuditFilters(query, ownerId),
    fingerprint: await queryFingerprint(query, actor),
    visibility: actor.role === 'owner' ? 'all' : 'self',
    ownerId,
  }
}

export async function listAdminAppAuditEvents(
  db: D1Database,
  adminId: number,
  input: AdminAppAuditListInput,
  requestContext: AdminAppAuditRequestContext,
  now = new Date(),
): Promise<AdminAppAuditEventList> {
  const prepared = await prepareAdminAppAuditQuery(db, adminId, input, now)
  const { actor, query, filters, fingerprint } = prepared
  const visibilityCondition = prepared.ownerId === null ? null : 'audit.admin_id = ?'
  const registryVisibilityCondition = prepared.ownerId === null
    ? null
    : `registry.action_key IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM json_each(registry.visible_roles_json) visible_role
         WHERE visible_role.value = 'admin'
       )`
  const cursorSequence = query.cursor ? decodeCursor(query.cursor, fingerprint) : null
  const pageConditions = [...filters.conditions]
  const pageParams = [...filters.params]
  if (cursorSequence !== null) {
    pageConditions.push('audit_index.sequence < ?')
    pageParams.push(cursorSequence)
  }
  const where = `WHERE ${pageConditions.join(' AND ')}`
  const rows = await db.prepare(`
    ${auditEventSelect()}
    ${where}
    ORDER BY audit_index.sequence DESC
    LIMIT ?
  `).bind(...pageParams, query.limit + 1).all<AuditEventRow>()
  const hasNext = rows.results.length > query.limit
  const pageRows = hasNext ? rows.results.slice(0, query.limit) : rows.results
  const [summary, actions, domains] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN audit_index.risk_level = 'critical' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN audit_index.risk_level = 'high' THEN 1 ELSE 0 END) AS high,
        SUM(CASE WHEN registry.action_key IS NULL THEN 1 ELSE 0 END) AS unregistered
      FROM app_audit_event_index audit_index
      JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
      LEFT JOIN app_audit_event_contexts context ON context.audit_event_id = audit.id
      LEFT JOIN app_audit_production_action_registry registry
        ON registry.action_key = audit.action
      WHERE ${filters.conditions.join(' AND ')}
    `).bind(...filters.params).first<{ total: number; critical: number; high: number; unregistered: number }>(),
    db.prepare(`
      SELECT audit.action,
             COALESCE(registry.display_name, audit.action) AS display_name
      FROM app_audit_event_index audit_index
      JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
      LEFT JOIN app_audit_production_action_registry registry
        ON registry.action_key = audit.action
      WHERE audit_index.occurred_at >= ? AND audit_index.occurred_at <= ?
        ${visibilityCondition ? `AND ${visibilityCondition}` : ''}
        ${registryVisibilityCondition ? `AND ${registryVisibilityCondition}` : ''}
      GROUP BY audit.action, registry.display_name
      ORDER BY audit.action ASC
      LIMIT 200
    `).bind(query.from, query.to, ...(visibilityCondition ? [actor.id] : [])).all<{ action: string; display_name: string }>(),
    db.prepare(`
      SELECT DISTINCT audit_index.action_domain
      FROM app_audit_event_index audit_index
      JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
      LEFT JOIN app_audit_production_action_registry registry
        ON registry.action_key = audit.action
      WHERE audit_index.occurred_at >= ? AND audit_index.occurred_at <= ?
        ${visibilityCondition ? `AND ${visibilityCondition}` : ''}
        ${registryVisibilityCondition ? `AND ${registryVisibilityCondition}` : ''}
      ORDER BY audit_index.action_domain ASC
      LIMIT 100
    `).bind(query.from, query.to, ...(visibilityCondition ? [actor.id] : [])).all<{ action_domain: string }>(),
  ])
  const events = pageRows.map(mapAuditEventSummary)
  const nextCursor = hasNext && events.length > 0
    ? encodeCursor(events.at(-1)!.sequence, fingerprint)
    : null
  await writeAuditReadEvent(db, actor, 'app.audit.query', 'admin_audit_query', null, requestContext, {
    purpose: query.purpose,
    from: query.from,
    to: query.to,
    filterDigest: fingerprint,
    returnedCount: events.length,
    visibility: actor.role === 'owner' ? 'all' : 'self',
  })
  return {
    events,
    nextCursor,
    appliedRange: { from: query.from, to: query.to, maxDays: MAX_QUERY_DAYS },
    summary: {
      total: Number(summary?.total ?? 0),
      critical: Number(summary?.critical ?? 0),
      high: Number(summary?.high ?? 0),
      unregistered: Number(summary?.unregistered ?? 0),
    },
    filterOptions: {
      actions: actions.results.map(item => ({ value: item.action, label: item.display_name })),
      domains: domains.results.map(item => item.action_domain),
    },
    visibility: actor.role === 'owner' ? 'all' : 'self',
  }
}

export async function getAdminAppAuditEvent(
  db: D1Database,
  adminId: number,
  eventId: string,
  purposeInput: unknown,
  requestContext: AdminAppAuditRequestContext,
): Promise<AdminAppAuditEventDetail> {
  const actor = await requireActiveAdmin(db, adminId)
  const id = normalizeEventId(eventId)
  const purpose = normalizePurpose(purposeInput)
  const ownership = actor.role === 'owner'
    ? ''
    : `AND audit.admin_id = ?
       AND registry.action_key IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM json_each(registry.visible_roles_json) visible_role
         WHERE visible_role.value = 'admin'
       )`
  const row = await db.prepare(`
    ${auditEventSelect()}
    WHERE audit.id = ? ${ownership}
    LIMIT 1
  `).bind(id, ...(actor.role === 'owner' ? [] : [actor.id])).first<AuditEventRow>()
  if (!row) throw new AdminAppAuditError(404, 'APP_AUDIT_EVENT_NOT_FOUND', '审计事件不存在或不在当前授权范围')
  const before = await redactAdminAppAuditPayload(row.before_value)
  const after = await redactAdminAppAuditPayload(row.after_value)
  const related = await loadRelatedEvents(db, row, actor)
  await writeAuditReadEvent(db, actor, 'app.audit.read_detail', 'admin_audit_log', id, requestContext, {
    purpose,
    sourceSequence: Number(row.sequence),
    sourceAction: row.action,
    sourceTargetType: row.target_type,
    sourceTargetIdPresent: Boolean(row.target_id),
    returnedRelatedCount: related.length,
  })
  const summary = mapAuditEventSummary(row)
  return {
    ...summary,
    before,
    after,
    relatedEvents: related,
    explanation: {
      who: summary.actor.label,
      when: summary.occurredAt,
      what: summary.actionDisplayName,
      target: `${summary.target.type}${summary.target.id ? ` / ${summary.target.id}` : ''}`,
      why: summary.context.reasonCode || purposeLabel(purpose),
      result: resultLabel(summary.result),
      approval: summary.context.approvalRequestId || '未登记审批引用',
    },
  }
}

export async function getAdminAppAuditIntegrityOverview(
  db: D1Database,
  adminId: number,
): Promise<AdminAppAuditIntegrityOverview> {
  await requireActiveOwner(db, adminId)
  const [source, indexed, missing, registry, actions, latest, registryGovernance] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM admin_audit_logs').first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count, MIN(sequence) AS minimum_sequence, MAX(sequence) AS maximum_sequence
      FROM app_audit_event_index
    `).first<{ count: number; minimum_sequence: number | null; maximum_sequence: number | null }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_audit_logs audit
      LEFT JOIN app_audit_event_index audit_index ON audit_index.audit_event_id = audit.id
      WHERE audit_index.audit_event_id IS NULL
    `).first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM app_audit_production_action_registry').first<{ count: number }>(),
    db.prepare('SELECT COUNT(DISTINCT action) AS count FROM admin_audit_logs').first<{ count: number }>(),
    loadLatestIntegrityCheck(db),
    db.prepare(`
      SELECT
        (SELECT COUNT(*)
         FROM app_audit_registry_change_requests
         WHERE status = 'pending_review') AS pending_count,
        (SELECT COUNT(*)
         FROM app_audit_current_action_registry registry
         LEFT JOIN app_audit_production_action_registry production
           ON production.action_key = registry.action_key
         WHERE production.action_key IS NULL) AS incomplete_count
    `).first<{ pending_count: number; incomplete_count: number }>(),
  ])
  const unregistered = await db.prepare(`
    SELECT COUNT(DISTINCT audit.action) AS count
    FROM admin_audit_logs audit
    LEFT JOIN app_audit_production_action_registry registry
      ON registry.action_key = audit.action
    WHERE registry.action_key IS NULL
  `).first<{ count: number }>()
  const blockers: string[] = []
  if (Number(missing?.count ?? 0) > 0) blockers.push('存在未建立稳定序号的审计事实')
  if (Number(unregistered?.count ?? 0) > 0) blockers.push('存在未登记生产口径的 action')
  if (Number(registryGovernance?.pending_count ?? 0) > 0) blockers.push('存在待独立复核的 Action 口径申请')
  if (Number(registryGovernance?.incomplete_count ?? 0) > 0) blockers.push('存在缺少保留、质量或 Owner 可见引用的 Action 口径')
  if (!latest) blockers.push('尚未形成完整性检查清单')
  if (latest?.status === 'findings') blockers.push('最近一次完整性检查存在 finding')
  return {
    sourceEventCount: Number(source?.count ?? 0),
    indexedEventCount: Number(indexed?.count ?? 0),
    minimumSequence: indexed?.minimum_sequence == null ? null : Number(indexed.minimum_sequence),
    maximumSequence: indexed?.maximum_sequence == null ? null : Number(indexed.maximum_sequence),
    missingIndexCount: Number(missing?.count ?? 0),
    activeRegistryCount: Number(registry?.count ?? 0),
    distinctActionCount: Number(actions?.count ?? 0),
    unregisteredActionCount: Number(unregistered?.count ?? 0),
    latestCheck: latest,
    productionReady: blockers.length === 0,
    blockers,
  }
}

export async function listAdminAppAuditIntegrityChecks(
  db: D1Database,
  adminId: number,
): Promise<AdminAppAuditIntegrityCheck[]> {
  await requireActiveOwner(db, adminId)
  const rows = await db.prepare(`
    ${integrityCheckSelect()}
    ORDER BY integrity_check.created_at DESC, integrity_check.id DESC
    LIMIT 50
  `).all<IntegrityCheckRow>()
  return Promise.all(rows.results.map(row => mapIntegrityCheck(db, row, false)))
}

export async function getAdminAppAuditIntegrityCheck(
  db: D1Database,
  adminId: number,
  checkId: string,
): Promise<AdminAppAuditIntegrityCheck> {
  await requireActiveOwner(db, adminId)
  const id = normalizeCheckId(checkId)
  const row = await db.prepare(`
    ${integrityCheckSelect()}
    WHERE integrity_check.id = ?
    LIMIT 1
  `).bind(id).first<IntegrityCheckRow>()
  if (!row) throw new AdminAppAuditError(404, 'APP_AUDIT_CHECK_NOT_FOUND', '完整性检查不存在')
  return mapIntegrityCheck(db, row, true)
}

export async function runAdminAppAuditIntegrityCheck(
  db: D1Database,
  adminId: number,
  idempotencyKeyInput: string | null,
  input: AdminAppAuditIntegrityInput,
  requestContext: AdminAppAuditRequestContext,
): Promise<{ check: AdminAppAuditIntegrityCheck; replayed: boolean }> {
  const actor = await requireActiveOwner(db, adminId)
  const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyInput)
  const bounds = await resolveIntegrityBounds(db, input)
  const requestHash = await sha256Hex(stableStringify(bounds))
  const replay = await findIntegrityCommand(db, actor.id, idempotencyKey)
  if (replay) {
    if (replay.request_hash !== requestHash) throw idempotencyConflict()
    return { check: await getAdminAppAuditIntegrityCheck(db, actor.id, replay.check_id), replayed: true }
  }

  const candidates = await loadIntegrityCandidates(db, bounds.startSequence, bounds.endSequence)
  const missingIndexCount = Number((await db.prepare(`
    SELECT COUNT(*) AS count
    FROM admin_audit_logs audit
    LEFT JOIN app_audit_event_index audit_index ON audit_index.audit_event_id = audit.id
    WHERE audit_index.audit_event_id IS NULL
  `).first<{ count: number }>())?.count ?? 0)
  const previous = await db.prepare(`
    SELECT id, manifest_digest
    FROM app_audit_integrity_checks
    WHERE start_sequence = ? AND end_sequence = ? AND manifest_version = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).bind(
    bounds.startSequence,
    bounds.endSequence,
    AUDIT_MANIFEST_VERSION,
  ).first<{ id: string; manifest_digest: string }>()

  const businessAuditGaps = await loadBusinessAuditGaps(db, candidates)

  const analysis = await analyzeIntegrityRange(
    candidates,
    bounds.startSequence,
    bounds.endSequence,
    missingIndexCount,
    previous ?? null,
    businessAuditGaps,
  )
  const checkId = generateId('aaic')
  const auditEventId = generateId('audit')
  const timestamp = new Date().toISOString()
  const persistedFindings = analysis.findings.slice(0, MAX_PERSISTED_FINDINGS)
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO app_audit_integrity_checks (
          id, start_sequence, end_sequence, event_count, manifest_version, manifest_digest, status,
          sequence_gap_count, missing_index_count, malformed_payload_count,
          sensitive_key_count, unregistered_action_count,
          business_without_audit_count,
          previous_manifest_check_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        checkId,
        bounds.startSequence,
        bounds.endSequence,
        candidates.length,
        AUDIT_MANIFEST_VERSION,
        analysis.manifestDigest,
        analysis.status,
        analysis.counts.sequenceGap,
        analysis.counts.missingIndex,
        analysis.counts.malformedPayload,
        analysis.counts.sensitiveKey,
        analysis.counts.unregisteredAction,
        analysis.counts.businessWithoutAudit,
        previous?.id ?? null,
        actor.id,
        timestamp,
      ),
      ...persistedFindings.map(finding => db.prepare(`
        INSERT INTO app_audit_integrity_findings (
          id, check_id, finding_type, severity, sequence, audit_event_id,
          evidence_digest, summary_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        generateId('aaif'),
        checkId,
        finding.type,
        finding.severity,
        finding.sequence,
        finding.eventId,
        finding.evidenceDigest,
        finding.summaryCode,
        timestamp,
      )),
      db.prepare(`
        INSERT INTO app_audit_integrity_commands (
          id, admin_id, idempotency_key, request_hash, check_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(generateId('aaicmd'), actor.id, idempotencyKey, requestHash, checkId, timestamp),
      db.prepare(`
        INSERT INTO admin_audit_logs (
          id, admin_id, action, target_type, target_id, before_value, after_value, created_at
        ) VALUES (?, ?, 'app.audit.integrity.run', 'app_audit_integrity_check', ?, NULL, ?, ?)
      `).bind(
        auditEventId,
        actor.id,
        checkId,
        JSON.stringify({
          startSequence: bounds.startSequence,
          endSequence: bounds.endSequence,
          eventCount: candidates.length,
          status: analysis.status,
          findingCount: analysis.findings.length,
          persistedFindingCount: persistedFindings.length,
          businessWithoutAuditCount: analysis.counts.businessWithoutAudit,
          manifestVersion: AUDIT_MANIFEST_VERSION,
          manifestDigest: analysis.manifestDigest,
        }),
        timestamp,
      ),
      db.prepare(`
        INSERT INTO app_audit_event_contexts (
          audit_event_id, request_id, trace_id, idempotency_key_hash,
          reason_code, business_reference, capability, scope_summary, created_at
        ) SELECT ?, ?, ?, ?, 'integrity_check', ?, 'audit.integrity.run', ?, ?
        FROM admin_audit_logs WHERE id = ?
      `).bind(
        auditEventId,
        normalizeCorrelationId(requestContext.requestId),
        normalizeOptionalCorrelationId(requestContext.traceId),
        await sha256Hex(idempotencyKey),
        checkId,
        JSON.stringify({
          startSequence: bounds.startSequence,
          endSequence: bounds.endSequence,
          manifestVersion: AUDIT_MANIFEST_VERSION,
        }),
        timestamp,
        auditEventId,
      ),
    ])
  }
  catch (error) {
    const raced = await findIntegrityCommand(db, actor.id, idempotencyKey)
    if (!raced) throw error
    if (raced.request_hash !== requestHash) throw idempotencyConflict()
    return { check: await getAdminAppAuditIntegrityCheck(db, actor.id, raced.check_id), replayed: true }
  }
  return { check: await getAdminAppAuditIntegrityCheck(db, actor.id, checkId), replayed: false }
}

async function loadRelatedEvents(
  db: D1Database,
  row: AuditEventRow,
  actor: ActorRow,
): Promise<AdminAppAuditEventSummary[]> {
  const references: string[] = []
  const params: unknown[] = []
  if (row.target_id) {
    references.push('(audit.target_type = ? AND audit.target_id = ?)')
    params.push(row.target_type, row.target_id)
  }
  if (row.request_id) {
    references.push('context.request_id = ?')
    params.push(row.request_id)
  }
  if (row.trace_id) {
    references.push('context.trace_id = ?')
    params.push(row.trace_id)
  }
  if (row.business_reference) {
    references.push('context.business_reference = ?')
    params.push(row.business_reference)
  }
  if (references.length === 0) return [mapAuditEventSummary(row)]
  const ownership = actor.role === 'owner'
    ? ''
    : `AND audit.admin_id = ?
       AND registry.action_key IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM json_each(registry.visible_roles_json) visible_role
         WHERE visible_role.value = 'admin'
       )`
  const result = await db.prepare(`
    ${auditEventSelect()}
    WHERE (${references.join(' OR ')}) ${ownership}
    ORDER BY audit_index.sequence ASC
    LIMIT 100
  `).bind(...params, ...(actor.role === 'owner' ? [] : [actor.id])).all<AuditEventRow>()
  return result.results.map(mapAuditEventSummary)
}

async function writeAuditReadEvent(
  db: D1Database,
  actor: ActorRow,
  action: string,
  targetType: string,
  targetId: string | null,
  requestContext: AdminAppAuditRequestContext,
  safeSummary: Record<string, unknown>,
) {
  const eventId = generateId('audit')
  const timestamp = new Date().toISOString()
  const capability = action === 'app.audit.query' ? 'audit.query' : 'audit.event.read'
  await db.batch([
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).bind(eventId, actor.id, action, targetType, targetId, JSON.stringify(safeSummary), timestamp),
    db.prepare(`
      INSERT INTO app_audit_event_contexts (
        audit_event_id, request_id, trace_id, reason_code, business_reference,
        capability, scope_summary, created_at
      ) SELECT ?, ?, ?, 'audit_read', ?, ?, ?, ?
      FROM admin_audit_logs WHERE id = ?
    `).bind(
      eventId,
      normalizeCorrelationId(requestContext.requestId),
      normalizeOptionalCorrelationId(requestContext.traceId),
      targetId,
      capability,
      JSON.stringify({ purpose: safeSummary.purpose, visibility: safeSummary.visibility ?? 'bounded' }),
      timestamp,
      eventId,
    ),
  ])
}

function buildAuditFilters(query: NormalizedAuditQuery, ownerId: number | null) {
  const conditions = ['audit_index.occurred_at >= ?', 'audit_index.occurred_at <= ?']
  const params: unknown[] = [query.from, query.to]
  if (ownerId !== null) {
    conditions.push('audit.admin_id = ?')
    params.push(ownerId)
    conditions.push('registry.action_key IS NOT NULL')
    conditions.push(`EXISTS (
      SELECT 1 FROM json_each(registry.visible_roles_json) visible_role
      WHERE visible_role.value = 'admin'
    )`)
  }
  appendFilter(conditions, params, 'audit.action = ?', query.action)
  appendFilter(conditions, params, 'audit_index.action_domain = ?', query.domain)
  appendFilter(conditions, params, 'audit_index.risk_level = ?', query.riskLevel)
  appendFilter(conditions, params, 'COALESCE(context.result, audit_index.result) = ?', query.result)
  appendFilter(conditions, params, 'audit.target_type = ?', query.targetType)
  appendFilter(conditions, params, 'audit.target_id = ?', query.targetId)
  appendFilter(conditions, params, 'audit.admin_id = ?', query.actorId)
  appendFilter(conditions, params, 'context.request_id = ?', query.requestId)
  appendFilter(conditions, params, 'context.trace_id = ?', query.traceId)
  appendFilter(conditions, params, 'context.business_reference = ?', query.businessReference)
  return { conditions, params }
}

function appendFilter(conditions: string[], params: unknown[], condition: string, value: unknown) {
  if (value === null || value === undefined) return
  conditions.push(condition)
  params.push(value)
}

function auditEventSelect() {
  return `
    SELECT audit_index.sequence,
           audit_index.audit_event_id,
           audit_index.actor_role_snapshot,
           audit_index.action_domain,
           audit_index.risk_level,
           COALESCE(context.result, audit_index.result) AS result,
           audit_index.occurred_at,
           audit.admin_id,
           actor.email AS admin_email,
           actor.nickname AS admin_nickname,
           audit.action,
           audit.target_type,
           audit.target_id,
           audit.before_value,
           audit.after_value,
           context.request_id,
           context.trace_id,
           context.reason_code,
           context.business_reference,
           context.target_version,
           context.approval_request_id,
           context.approval_step_id,
           context.policy_version,
           context.capability,
           context.scope_summary,
           context.error_code,
           registry.action_key AS registry_action_key,
           registry.schema_version AS registry_schema_version,
           registry.display_name AS registry_display_name,
           registry.owner_reference AS registry_owner_reference,
           registry.sensitivity AS registry_sensitivity,
           registry.status AS registry_status
    FROM app_audit_event_index audit_index
    JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
    LEFT JOIN users actor ON actor.id = audit.admin_id
    LEFT JOIN app_audit_event_contexts context ON context.audit_event_id = audit.id
    LEFT JOIN app_audit_production_action_registry registry
      ON registry.action_key = audit.action
  `
}

function mapAuditEventSummary(row: AuditEventRow): AdminAppAuditEventSummary {
  const registry = row.registry_action_key && row.registry_schema_version && row.registry_display_name
    && row.registry_owner_reference && row.registry_sensitivity && row.registry_status
    ? {
        actionKey: row.registry_action_key,
        schemaVersion: Number(row.registry_schema_version),
        displayName: row.registry_display_name,
        ownerReference: row.registry_owner_reference,
        sensitivity: row.registry_sensitivity,
        status: row.registry_status,
      }
    : null
  return {
    eventId: row.audit_event_id,
    sequence: Number(row.sequence),
    occurredAt: row.occurred_at,
    actor: {
      id: Number(row.admin_id),
      role: row.actor_role_snapshot,
      label: actorLabel(row.admin_email, row.admin_nickname, Number(row.admin_id)),
    },
    action: row.action,
    actionDisplayName: registry?.displayName ?? row.action,
    domain: row.action_domain,
    riskLevel: row.risk_level,
    result: row.result,
    target: { type: row.target_type, id: row.target_id },
    context: {
      requestId: safeAdminAppAuditContextValue(row.request_id),
      traceId: safeAdminAppAuditContextValue(row.trace_id),
      reasonCode: safeAdminAppAuditContextValue(row.reason_code),
      businessReference: safeAdminAppAuditContextValue(row.business_reference),
      targetVersion: safeAdminAppAuditContextValue(row.target_version),
      approvalRequestId: safeAdminAppAuditContextValue(row.approval_request_id),
      approvalStepId: safeAdminAppAuditContextValue(row.approval_step_id),
      policyVersion: safeAdminAppAuditContextValue(row.policy_version),
      capability: safeAdminAppAuditContextValue(row.capability),
      scopeSummary: safeAdminAppAuditContextValue(row.scope_summary, 1_000, true),
      errorCode: safeAdminAppAuditContextValue(row.error_code),
    },
    registry,
    payloadState: {
      before: payloadState(row.before_value),
      after: payloadState(row.after_value),
    },
  }
}

export async function redactAdminAppAuditPayload(raw: string | null): Promise<AdminAppAuditRedactedPayload> {
  if (raw === null || raw === '') {
    return { state: 'empty', digest: null, value: null, redactedFieldCount: 0 }
  }
  const digest = await sha256Hex(raw)
  try {
    const parsed = JSON.parse(raw) as unknown
    const counter = { count: 0 }
    return {
      state: 'valid',
      digest,
      value: redactValue(parsed, counter, 0),
      redactedFieldCount: counter.count,
    }
  }
  catch {
    return {
      state: 'invalid',
      digest,
      value: { state: '原始载荷不是合法 JSON，已禁止显示', length: Array.from(raw).length },
      redactedFieldCount: 1,
    }
  }
}

function redactValue(value: unknown, counter: { count: number }, depth: number): unknown {
  if (depth > 8) {
    counter.count += 1
    return '[已按深度限制隐藏]'
  }
  if (Array.isArray(value)) {
    const visible = value.slice(0, 50).map(item => redactValue(item, counter, depth + 1))
    if (value.length > 50) visible.push(`[另有 ${value.length - 50} 项已隐藏]`)
    return visible
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        counter.count += 1
        result[key] = '[敏感字段已脱敏]'
      }
      else {
        result[key] = redactValue(child, counter, depth + 1)
      }
    }
    return result
  }
  if (typeof value === 'string') {
    if (looksSensitiveString(value)) {
      counter.count += 1
      return '[疑似敏感值已脱敏]'
    }
    if (Array.from(value).length > 500) {
      counter.count += 1
      return `[长文本已隐藏，长度 ${Array.from(value).length}]`
    }
  }
  return value
}

function payloadState(raw: string | null): 'empty' | 'valid' | 'invalid' {
  if (raw === null || raw === '') return 'empty'
  try {
    JSON.parse(raw)
    return 'valid'
  }
  catch {
    return 'invalid'
  }
}

export function safeAdminAppAuditContextValue(value: string | null, maximum = 192, inspectJson = false) {
  if (!value) return null
  const length = Array.from(value).length
  if (length > maximum) return `[过长上下文已隐藏，长度 ${length}]`
  if (looksSensitiveString(value)) return '[疑似敏感上下文已隐藏]'
  if (inspectJson) {
    try {
      if (countSensitiveKeys(JSON.parse(value) as unknown) > 0) return '[敏感上下文摘要已隐藏]'
    }
    catch {
      // scopeSummary 兼容既有纯文本摘要；非法 JSON 不代表可以扩大披露。
    }
  }
  return value
}

async function resolveIntegrityBounds(db: D1Database, input: AdminAppAuditIntegrityInput) {
  const bounds = await db.prepare(`
    SELECT MIN(sequence) AS minimum_sequence, MAX(sequence) AS maximum_sequence
    FROM app_audit_event_index
  `).first<{ minimum_sequence: number | null; maximum_sequence: number | null }>()
  if (bounds?.minimum_sequence == null || bounds.maximum_sequence == null) {
    throw new AdminAppAuditError(409, 'APP_AUDIT_EMPTY', '当前没有可检查的审计事件')
  }
  const minimum = Number(bounds.minimum_sequence)
  const maximum = Number(bounds.maximum_sequence)
  const endSequence = input.endSequence == null || input.endSequence === ''
    ? maximum
    : positiveInteger(input.endSequence, 'endSequence')
  const startSequence = input.startSequence == null || input.startSequence === ''
    ? Math.max(minimum, endSequence - DEFAULT_INTEGRITY_RANGE + 1)
    : positiveInteger(input.startSequence, 'startSequence')
  if (startSequence < minimum || endSequence > maximum || startSequence > endSequence) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_RANGE_INVALID', '完整性检查范围超出当前审计序号边界')
  }
  if (endSequence - startSequence + 1 > MAX_INTEGRITY_RANGE) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_RANGE_TOO_LARGE', `单次最多检查 ${MAX_INTEGRITY_RANGE} 个连续序号`)
  }
  return { startSequence, endSequence }
}

async function loadIntegrityCandidates(db: D1Database, start: number, end: number) {
  const result = await db.prepare(`
    SELECT audit_index.sequence,
           audit_index.audit_event_id,
           audit.admin_id,
           audit_index.actor_role_snapshot,
           audit_index.action_domain,
           audit_index.risk_level,
           audit_index.result AS index_result,
           audit.action,
           audit.target_type,
           audit.target_id,
           audit.before_value,
           audit.after_value,
           audit_index.occurred_at,
           context.request_id,
           context.trace_id,
           context.idempotency_key_hash,
           context.reason_code,
           context.business_reference,
           context.target_version,
           context.approval_request_id,
           context.approval_step_id,
           context.policy_version,
           context.capability,
           context.scope_summary,
           context.result AS context_result,
           context.error_code,
           registry.action_key AS registry_action_key
    FROM app_audit_event_index audit_index
    JOIN admin_audit_logs audit ON audit.id = audit_index.audit_event_id
    LEFT JOIN app_audit_event_contexts context ON context.audit_event_id = audit.id
    LEFT JOIN app_audit_production_action_registry registry
      ON registry.action_key = audit.action
    WHERE audit_index.sequence BETWEEN ? AND ?
    ORDER BY audit_index.sequence ASC
  `).bind(start, end).all<IntegrityCandidate>()
  return result.results
}

async function loadBusinessAuditGaps(
  db: D1Database,
  candidates: IntegrityCandidate[],
): Promise<{ total: number; samples: BusinessAuditGap[] }> {
  const first = candidates.at(0)
  if (!first) return { total: 0, samples: [] }

  const { from, to } = candidates.reduce(
    (range, candidate) => ({
      from: candidate.occurred_at < range.from ? candidate.occurred_at : range.from,
      to: candidate.occurred_at > range.to ? candidate.occurred_at : range.to,
    }),
    { from: first.occurred_at, to: first.occurred_at },
  )
  const [membership, wallet, operatorMessage, publishedPerson] = await Promise.all([
    db.prepare(`
      SELECT 'membership_grant' AS fact_type,
             grant_row.id AS fact_id,
             grant_row.created_at AS fact_time,
             COUNT(*) OVER () AS total_count
      FROM app_membership_grants grant_row
      WHERE grant_row.created_at >= ? AND grant_row.created_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM admin_audit_logs audit
          WHERE (
              audit.action = 'app_membership_grant'
              AND audit.target_type = 'app_membership_grant'
              AND audit.target_id = grant_row.id
            )
            OR (
              audit.action IN ('app.membership.change.approve', 'app_membership_application_approve')
              AND (
                json_extract(
                  CASE WHEN json_valid(audit.after_value) THEN audit.after_value ELSE '{}' END,
                  '$.resultGrantId'
                ) = grant_row.id
                OR json_extract(
                  CASE WHEN json_valid(audit.after_value) THEN audit.after_value ELSE '{}' END,
                  '$.grantId'
                ) = grant_row.id
              )
            )
        )
      ORDER BY grant_row.created_at ASC, grant_row.id ASC
      LIMIT ?
    `).bind(from, to, MAX_BUSINESS_GAP_SAMPLES_PER_TYPE).all<BusinessAuditGapRow>(),
    db.prepare(`
      SELECT 'wallet_entry' AS fact_type,
             entry.id AS fact_id,
             entry.posted_at AS fact_time,
             COUNT(*) OVER () AS total_count
      FROM app_wallet_entries entry
      WHERE entry.posted_at >= ? AND entry.posted_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM admin_audit_logs audit
          WHERE audit.action = 'app.wallet.adjustment.approve'
            AND audit.target_type = 'app_wallet_adjustment'
            AND audit.target_id = entry.adjustment_id
        )
      ORDER BY entry.posted_at ASC, entry.id ASC
      LIMIT ?
    `).bind(from, to, MAX_BUSINESS_GAP_SAMPLES_PER_TYPE).all<BusinessAuditGapRow>(),
    db.prepare(`
      SELECT 'operator_message' AS fact_type,
             message_fact.message_id AS fact_id,
             message_fact.created_at AS fact_time,
             COUNT(*) OVER () AS total_count
      FROM app_conversation_operator_message_facts message_fact
      WHERE message_fact.created_at >= ? AND message_fact.created_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM admin_audit_logs audit
          WHERE audit.action = 'app_conversation.operator_reply'
            AND audit.target_type = 'app_conversation'
            AND audit.target_id = message_fact.conversation_id
            AND json_extract(
              CASE WHEN json_valid(audit.after_value) THEN audit.after_value ELSE '{}' END,
              '$.messageId'
            ) = message_fact.message_id
        )
      ORDER BY message_fact.created_at ASC, message_fact.message_id ASC
      LIMIT ?
    `).bind(from, to, MAX_BUSINESS_GAP_SAMPLES_PER_TYPE).all<BusinessAuditGapRow>(),
    db.prepare(`
      SELECT 'person_publication' AS fact_type,
             publication.id AS fact_id,
             publication.reviewed_at AS fact_time,
             COUNT(*) OVER () AS total_count
      FROM person_publication_reviews publication
      WHERE publication.status = 'published'
        AND publication.reviewed_at >= ? AND publication.reviewed_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM admin_audit_logs audit
          WHERE audit.action = 'app_person.publication_publish'
            AND audit.target_type = 'person_profile'
            AND audit.target_id = publication.profile_id
            AND json_extract(
              CASE WHEN json_valid(audit.after_value) THEN audit.after_value ELSE '{}' END,
              '$.publicationId'
            ) = publication.id
        )
      ORDER BY publication.reviewed_at ASC, publication.id ASC
      LIMIT ?
    `).bind(from, to, MAX_BUSINESS_GAP_SAMPLES_PER_TYPE).all<BusinessAuditGapRow>(),
  ])
  const groups = [membership.results, wallet.results, operatorMessage.results, publishedPerson.results]
  return {
    total: groups.reduce((total, rows) => total + Number(rows.at(0)?.total_count ?? 0), 0),
    samples: groups.flatMap(rows => rows.map(row => ({
      factType: row.fact_type,
      factId: row.fact_id,
      factTime: row.fact_time,
    }))),
  }
}

async function analyzeIntegrityRange(
  candidates: IntegrityCandidate[],
  startSequence: number,
  endSequence: number,
  missingIndexCount: number,
  previous: { id: string; manifest_digest: string } | null,
  businessAuditGaps: { total: number; samples: BusinessAuditGap[] },
) {
  const findings: Array<Omit<AdminAppAuditIntegrityFinding, 'findingId'>> = []
  let sequenceGap = 0
  let malformedPayload = 0
  let sensitiveKey = 0
  let unregisteredAction = 0
  const bySequence = new Map(candidates.map(item => [Number(item.sequence), item]))
  for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
    if (bySequence.has(sequence)) continue
    sequenceGap += 1
    findings.push(await makeFinding('sequence_gap', 'critical', sequence, null, 'AUDIT_SEQUENCE_GAP'))
  }
  if (missingIndexCount > 0) {
    findings.push(await makeFinding('missing_index', 'critical', null, null, 'AUDIT_SOURCE_WITHOUT_INDEX'))
  }
  let chain = await sha256Hex(`${AUDIT_MANIFEST_VERSION}:${startSequence}:${endSequence}`)
  for (const candidate of candidates) {
    const canonical = stableStringify({
      sequence: Number(candidate.sequence),
      eventId: candidate.audit_event_id,
      actorId: Number(candidate.admin_id),
      actorRole: candidate.actor_role_snapshot,
      actionDomain: candidate.action_domain,
      riskLevel: candidate.risk_level,
      indexResult: candidate.index_result,
      action: candidate.action,
      targetType: candidate.target_type,
      targetId: candidate.target_id,
      before: candidate.before_value,
      after: candidate.after_value,
      occurredAt: candidate.occurred_at,
      requestId: candidate.request_id,
      traceId: candidate.trace_id,
      idempotencyKeyHash: candidate.idempotency_key_hash,
      reasonCode: candidate.reason_code,
      businessReference: candidate.business_reference,
      targetVersion: candidate.target_version,
      approvalRequestId: candidate.approval_request_id,
      approvalStepId: candidate.approval_step_id,
      policyVersion: candidate.policy_version,
      capability: candidate.capability,
      scopeSummary: candidate.scope_summary,
      contextResult: candidate.context_result,
      errorCode: candidate.error_code,
    })
    chain = await sha256Hex(`${chain}\n${canonical}`)
    for (const [field, raw] of [['before', candidate.before_value], ['after', candidate.after_value]] as const) {
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as unknown
        const sensitiveCount = countSensitiveKeys(parsed)
        if (sensitiveCount > 0) {
          sensitiveKey += sensitiveCount
          findings.push(await makeFinding(
            'sensitive_key',
            'critical',
            Number(candidate.sequence),
            candidate.audit_event_id,
            `AUDIT_${field.toUpperCase()}_SENSITIVE_KEY`,
          ))
        }
      }
      catch {
        malformedPayload += 1
        findings.push(await makeFinding(
          'malformed_payload',
          'warning',
          Number(candidate.sequence),
          candidate.audit_event_id,
          `AUDIT_${field.toUpperCase()}_INVALID_JSON`,
        ))
      }
    }
    if (!candidate.registry_action_key) {
      unregisteredAction += 1
      findings.push(await makeFinding(
        'unregistered_action',
        'info',
        Number(candidate.sequence),
        candidate.audit_event_id,
        'AUDIT_ACTION_UNREGISTERED',
      ))
    }
  }
  if (previous && previous.manifest_digest !== chain) {
    findings.push(await makeFinding('manifest_changed', 'critical', null, null, 'AUDIT_MANIFEST_CHANGED'))
  }
  for (const gap of businessAuditGaps.samples) {
    findings.push({
      type: 'business_without_audit',
      severity: 'critical',
      sequence: null,
      eventId: null,
      evidenceDigest: await sha256Hex(stableStringify({
        type: 'business_without_audit',
        factType: gap.factType,
        factId: gap.factId,
        factTime: gap.factTime,
      })),
      summaryCode: `AUDIT_BUSINESS_FACT_WITHOUT_EVENT:${gap.factType}`,
    })
  }
  return {
    manifestDigest: chain,
    status: findings.length > 0 ? 'findings' as const : 'passed' as const,
    findings,
    counts: {
      sequenceGap,
      missingIndex: missingIndexCount,
      malformedPayload,
      sensitiveKey,
      unregisteredAction,
      businessWithoutAudit: businessAuditGaps.total,
    },
  }
}

async function makeFinding(
  type: AdminAppAuditIntegrityFinding['type'],
  severity: AdminAppAuditIntegrityFinding['severity'],
  sequence: number | null,
  eventId: string | null,
  summaryCode: string,
): Promise<Omit<AdminAppAuditIntegrityFinding, 'findingId'>> {
  return {
    type,
    severity,
    sequence,
    eventId,
    evidenceDigest: await sha256Hex(stableStringify({ type, severity, sequence, eventId, summaryCode })),
    summaryCode,
  }
}

function countSensitiveKeys(value: unknown, depth = 0): number {
  if (depth > 12 || value === null) return 0
  if (typeof value === 'string') return looksSensitiveString(value) ? 1 : 0
  if (typeof value !== 'object') return 0
  if (Array.isArray(value)) return value.reduce((total, item) => total + countSensitiveKeys(item, depth + 1), 0)
  let total = 0
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) total += 1
    else total += countSensitiveKeys(child, depth + 1)
  }
  return total
}

function isSensitiveKey(key: string) {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replaceAll('-', '_')
  return SENSITIVE_KEYS.has(normalized)
}

function looksSensitiveString(value: string) {
  const normalized = value.trim()
  if (!normalized) return false
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(normalized)) return true
  if (/^Bearer\s+[A-Za-z0-9._~+/=-]+$/iu.test(normalized)) return true
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(normalized)) return true
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return true
  if (/^https?:\/\//iu.test(normalized) && /[?&](?:token|sig|signature|key|credential)=/iu.test(normalized)) return true
  return false
}

function integrityCheckSelect() {
  return `
    SELECT integrity_check.*,
           actor.role AS actor_role,
           actor.email AS actor_email,
           actor.nickname AS actor_nickname
    FROM app_audit_integrity_checks integrity_check
    LEFT JOIN users actor ON actor.id = integrity_check.created_by
  `
}

async function loadLatestIntegrityCheck(db: D1Database) {
  const row = await db.prepare(`
    ${integrityCheckSelect()}
    ORDER BY integrity_check.created_at DESC, integrity_check.id DESC
    LIMIT 1
  `).first<IntegrityCheckRow>()
  return row ? mapIntegrityCheck(db, row, false) : null
}

async function mapIntegrityCheck(
  db: D1Database,
  row: IntegrityCheckRow,
  includeFindings: boolean,
): Promise<AdminAppAuditIntegrityCheck> {
  const findings = includeFindings
    ? (await db.prepare(`
        SELECT id, finding_type, severity, sequence, audit_event_id,
               evidence_digest, summary_code
        FROM app_audit_integrity_findings
        WHERE check_id = ?
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 sequence ASC, id ASC
        LIMIT ?
      `).bind(row.id, MAX_PERSISTED_FINDINGS).all<IntegrityFindingRow>()).results.map(mapIntegrityFinding)
    : []
  return {
    checkId: row.id,
    startSequence: Number(row.start_sequence),
    endSequence: Number(row.end_sequence),
    eventCount: Number(row.event_count),
    manifestVersion: row.manifest_version,
    manifestDigest: row.manifest_digest,
    status: row.status,
    counts: {
      sequenceGap: Number(row.sequence_gap_count),
      missingIndex: Number(row.missing_index_count),
      malformedPayload: Number(row.malformed_payload_count),
      sensitiveKey: Number(row.sensitive_key_count),
      unregisteredAction: Number(row.unregistered_action_count),
      businessWithoutAudit: Number(row.business_without_audit_count),
    },
    previousManifestCheckId: row.previous_manifest_check_id,
    createdBy: {
      id: Number(row.created_by),
      role: row.actor_role,
      label: actorLabel(row.actor_email, row.actor_nickname, Number(row.created_by)),
    },
    createdAt: row.created_at,
    findings,
  }
}

function mapIntegrityFinding(row: IntegrityFindingRow): AdminAppAuditIntegrityFinding {
  return {
    findingId: row.id,
    type: row.finding_type,
    severity: row.severity,
    sequence: row.sequence == null ? null : Number(row.sequence),
    eventId: row.audit_event_id,
    evidenceDigest: row.evidence_digest,
    summaryCode: row.summary_code,
  }
}

async function findIntegrityCommand(db: D1Database, adminId: number, key: string) {
  return db.prepare(`
    SELECT request_hash, check_id
    FROM app_audit_integrity_commands
    WHERE admin_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(adminId, key).first<IntegrityCommandRow>()
}

async function requireActiveAdmin(db: D1Database, adminId: number) {
  const actor = await db.prepare(`
    SELECT id, role, status, email, nickname
    FROM users
    WHERE id = ? AND role IN ('admin', 'owner') AND status = 'active'
    LIMIT 1
  `).bind(adminId).first<ActorRow>()
  if (!actor) throw new AdminAppAuditError(403, 'APP_AUDIT_FORBIDDEN', '当前管理员无审计访问权限')
  return actor
}

async function requireActiveOwner(db: D1Database, adminId: number) {
  const actor = await requireActiveAdmin(db, adminId)
  if (actor.role !== 'owner') {
    throw new AdminAppAuditError(403, 'APP_AUDIT_OWNER_REQUIRED', '只有有效 Owner 可以查看或运行完整性检查')
  }
  return actor
}

async function normalizeAuditQuery(
  input: AdminAppAuditListInput,
  actor: ActorRow,
  now: Date,
): Promise<NormalizedAuditQuery> {
  const purpose = normalizePurpose(input.purpose)
  const toDate = parseDate(input.to, now, 'to')
  const fromDate = parseDate(input.from, new Date(toDate.getTime() - DEFAULT_QUERY_DAYS * 86_400_000), 'from')
  if (fromDate.getTime() > toDate.getTime()) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_TIME_RANGE_INVALID', '开始时间不能晚于结束时间')
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_QUERY_DAYS * 86_400_000) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_TIME_RANGE_TOO_LARGE', `单次查询最多覆盖 ${MAX_QUERY_DAYS} 天`)
  }
  const actorId = optionalPositiveInteger(input.actorId, 'actorId')
  if (actor.role !== 'owner' && actorId !== null && actorId !== actor.id) {
    throw new AdminAppAuditError(403, 'APP_AUDIT_ACTOR_SCOPE_FORBIDDEN', '普通管理员只能查询自己的审计事件')
  }
  return {
    purpose,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    action: optionalPattern(input.action, 'action', ACTION_KEY),
    domain: optionalPattern(input.domain, 'domain', DOMAIN_KEY),
    riskLevel: optionalEnum(input.riskLevel, 'riskLevel', RISK_LEVELS) as AdminAppAuditRiskLevel | null,
    result: optionalEnum(input.result, 'result', RESULTS) as AdminAppAuditResult | null,
    targetType: optionalPattern(input.targetType, 'targetType', TARGET_TYPE),
    targetId: optionalReference(input.targetId, 'targetId'),
    actorId,
    requestId: optionalReference(input.requestId, 'requestId'),
    traceId: optionalReference(input.traceId, 'traceId'),
    businessReference: optionalReference(input.businessReference, 'businessReference'),
    cursor: optionalText(input.cursor, 'cursor', 1, 1_000),
    limit: boundedInteger(input.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, 'limit'),
  }
}

function normalizePurpose(value: unknown): AdminAppAuditPurpose {
  if (typeof value !== 'string' || !PURPOSES.has(value)) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_PURPOSE_REQUIRED', '必须选择合法的审计查询用途')
  }
  return value as AdminAppAuditPurpose
}

function normalizeEventId(value: string) {
  const normalized = value.trim()
  if (!AUDIT_EVENT_ID.test(normalized)) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_EVENT_ID_INVALID', '审计事件 ID 格式错误')
  }
  return normalized
}

function normalizeCheckId(value: string) {
  const normalized = value.trim()
  if (!AUDIT_CHECK_ID.test(normalized)) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_CHECK_ID_INVALID', '完整性检查 ID 格式错误')
  }
  return normalized
}

function normalizeIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? ''
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new AdminAppAuditError(400, 'APP_AUDIT_IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 格式错误')
  }
  return normalized
}

function parseDate(value: unknown, fallback: Date, field: string) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') throw invalidField(field)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw invalidField(field)
  return parsed
}

function optionalPattern(value: unknown, field: string, pattern: RegExp) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw invalidField(field)
  const normalized = value.trim()
  if (!pattern.test(normalized)) throw invalidField(field)
  return normalized
}

function optionalReference(value: unknown, field: string) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw invalidField(field)
  const normalized = value.trim()
  if (!REFERENCE.test(normalized)) throw invalidField(field)
  return normalized
}

function optionalText(value: unknown, field: string, minimum: number, maximum: number) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw invalidField(field)
  const normalized = value.trim()
  const length = Array.from(normalized).length
  if (length < minimum || length > maximum) throw invalidField(field)
  return normalized
}

function optionalEnum(value: unknown, field: string, values: Set<string>) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !values.has(value)) throw invalidField(field)
  return value
}

function optionalPositiveInteger(value: unknown, field: string) {
  if (value == null || value === '') return null
  return positiveInteger(value, field)
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
  return new AdminAppAuditError(400, 'APP_AUDIT_FIELD_INVALID', `${field} 格式错误`)
}

function normalizeCorrelationId(value: string) {
  return optionalReference(value, 'requestId') ?? crypto.randomUUID()
}

function normalizeOptionalCorrelationId(value: string | null | undefined) {
  return value ? optionalReference(value, 'traceId') : null
}

async function queryFingerprint(query: NormalizedAuditQuery, actor: ActorRow) {
  return sha256Hex(stableStringify({
    actorId: actor.id,
    visibility: actor.role === 'owner' ? 'all' : 'self',
    purpose: query.purpose,
    from: query.from,
    to: query.to,
    action: query.action,
    domain: query.domain,
    riskLevel: query.riskLevel,
    result: query.result,
    targetType: query.targetType,
    targetId: query.targetId,
    requestedActorId: query.actorId,
    requestId: query.requestId,
    traceId: query.traceId,
    businessReference: query.businessReference,
  }))
}

function encodeCursor(sequence: number, fingerprint: string) {
  return base64UrlEncode(JSON.stringify({ v: 1, sequence, fingerprint }))
}

function decodeCursor(cursor: string, fingerprint: string) {
  try {
    const value = JSON.parse(base64UrlDecode(cursor)) as { v?: unknown; sequence?: unknown; fingerprint?: unknown }
    if (value.v !== 1 || value.fingerprint !== fingerprint) throw new Error('cursor scope mismatch')
    return positiveInteger(value.sequence, 'cursor.sequence')
  }
  catch (error) {
    if (error instanceof AdminAppAuditError) throw error
    throw new AdminAppAuditError(400, 'APP_AUDIT_CURSOR_INVALID', '审计游标无效或与当前筛选范围不匹配')
  }
}

function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlDecode(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function actorLabel(email: string | null, nickname: string | null, id: number) {
  return nickname?.trim() || email?.trim() || `管理员 #${id}`
}

function purposeLabel(purpose: AdminAppAuditPurpose) {
  return {
    operational_investigation: '运营调查',
    security_review: '安全复核',
    financial_reconciliation: '财务对账',
    compliance_audit: '合规审计',
  }[purpose]
}

function resultLabel(result: AdminAppAuditResult) {
  return { succeeded: '已成功', denied: '已拒绝', failed: '执行失败' }[result]
}

function idempotencyConflict() {
  return new AdminAppAuditError(409, 'APP_AUDIT_IDEMPOTENCY_CONFLICT', '幂等键已用于不同完整性检查范围')
}
