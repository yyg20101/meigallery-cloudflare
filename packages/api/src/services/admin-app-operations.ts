import { generateId } from '../utils/db'
import {
  APP_OPERATIONAL_CONTROL_KEYS,
  getAppOperationalControl,
  type AppOperationalControl,
  type AppOperationalControlKey,
} from './app-operational-safety'
import {
  readCloudflareOperationsAnalytics,
  type CloudflareOperationsAnalyticsConfig,
  type CloudflareOperationsMetricValues,
} from './cloudflare-operations-analytics'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u
const INCIDENT_ID = /^opinc_[A-Za-z0-9_-]{1,89}$/u
const RUNBOOK_ID = /^oprb_[A-Za-z0-9_-]{1,89}$/u
const REASON_CODE = /^[a-z0-9_]{3,80}$/u
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,239}$/u
const MAX_INCIDENT_PAGE_SIZE = 100
const DEFAULT_INCIDENT_PAGE_SIZE = 40
const METRIC_RUN_VERSION = 'operations-metrics-v2'
const DETECTOR_VERSION = 'operations-detectors-v3'
const CLOUDFLARE_STATUS_SUMMARY_URL = 'https://www.cloudflarestatus.com/api/v2/summary.json'
const CLOUDFLARE_STATUS_TIMEOUT_MS = 4_000
const CLOUDFLARE_STATUS_MAX_RESPONSE_BYTES = 1_000_000
const RELEVANT_CLOUDFLARE_COMPONENT_NAMES = [
  'API',
  'D1',
  'Durable Objects',
  'Email Sending',
  'Queues',
  'R2',
  'Turnstile',
  'Workers',
  'Workers Assets',
] as const

const INCIDENT_STATUSES = [
  'open',
  'acknowledged',
  'investigating',
  'mitigated',
  'resolved',
  'false_positive',
] as const
const INCIDENT_SEVERITIES = ['p0', 'p1', 'p2', 'p3'] as const
const INCIDENT_DOMAINS = [
  'supply',
  'discovery',
  'messaging',
  'membership',
  'wallet',
  'notification',
  'safety',
  'audit',
  'platform',
] as const
const INCIDENT_TYPES = [
  'unauthorized_publication',
  'operator_identity_anomaly',
  'membership_expiry_not_revoked',
  'duplicate_membership_grant',
  'wallet_balance_mismatch',
  'unreviewed_wallet_adjustment',
  'audit_integrity_gap',
  'internal_note_exposure',
  'notification_backlog',
  'data_rights_overdue',
  'platform_health_anomaly',
] as const

type IncidentStatus = typeof INCIDENT_STATUSES[number]
type IncidentSeverity = typeof INCIDENT_SEVERITIES[number]
type IncidentDomain = typeof INCIDENT_DOMAINS[number]
type IncidentType = typeof INCIDENT_TYPES[number]
type MetricQuality = 'known' | 'unknown' | 'delayed' | 'partial' | 'invalid' | 'unconfigured'

export type AdminOperationsActor = {
  adminId: number
  role: string
  requestId: string
  traceId: string | null
}

export class AdminAppOperationsError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

type MetricDefinitionRow = {
  id: string
  metric_key: string
  schema_version: number
  topic: string
  display_name: string
  description: string
  unit: string
  source_type: string
  source_reference: string
  owner_reference: string
  freshness_slo_seconds: number
  sensitivity: string
  retention_decision_status: string
  retention_policy_reference: string | null
  production_ready: number
}

type MetricRunRow = {
  id: string
  run_version: string
  status: string
  metric_count: number
  known_count: number
  quality_summary_json: string
  started_by: number
  started_at: string
  completed_at: string
}

type MetricSnapshotRow = MetricDefinitionRow & {
  snapshot_id: string | null
  run_id: string | null
  quality_state: string | null
  value_integer: number | null
  value_real: number | null
  value_text: string | null
  source_watermark: string | null
  measured_at: string | null
  safe_details_json: string | null
}

type MetricValue = {
  quality: MetricQuality
  valueInteger?: number
  valueReal?: number
  valueText?: string
  sourceWatermark: string | null
  details: Record<string, unknown>
}

type IncidentRow = {
  id: string
  incident_key: string
  incident_type: string
  domain: string
  severity: string
  title: string
  safe_summary: string
  source_type: string
  source_reference: string
  impact_count: number | null
  impact_scope_json: string
  status: string
  owner_admin_id: number | null
  owner_nickname: string | null
  owner_role: string | null
  runbook_id: string | null
  runbook_title: string | null
  runbook_key: string | null
  runbook_version: number | null
  runbook_summary: string | null
  runbook_reference: string | null
  version: number
  signal_count: number
  first_seen_at: string
  last_seen_at: string
  acknowledged_at: string | null
  mitigated_at: string | null
  resolved_at: string | null
  resolution_code: string | null
  resolution_summary: string | null
  close_evidence_reference: string | null
  postmortem_reference: string | null
  last_detection_run_id: string | null
  created_at: string
  updated_at: string
}

type IncidentEventRow = {
  id: string
  sequence: number
  incident_version: number
  event_type: string
  actor_type: string
  actor_admin_id: number | null
  actor_nickname: string | null
  actor_role: string | null
  status_from: string | null
  status_to: string | null
  reason_code: string
  response_note: string | null
  safe_summary_json: string
  evidence_reference: string | null
  created_at: string
}

type RunbookRow = {
  id: string
  runbook_key: string
  version: number
  title: string
  safe_summary: string
  document_reference: string
  domains_json: string
  control_keys_json: string
  minimum_severity: string
}

type AdminCommandRow = {
  operation: string
  request_hash: string
  result_type: string
  result_id: string
  result_version: number | null
}

export interface AdminAppIncidentListInput {
  status?: unknown
  severity?: unknown
  domain?: unknown
  type?: unknown
  owner?: unknown
  cursor?: unknown
  limit?: unknown
}

export interface AdminAppIncidentClaimInput {
  expectedVersion?: unknown
}

export interface AdminAppIncidentNoteInput {
  expectedVersion?: unknown
  reasonCode?: unknown
  note?: unknown
  evidenceReference?: unknown
}

export interface AdminAppIncidentStatusInput {
  expectedVersion?: unknown
  status?: unknown
  reasonCode?: unknown
  note?: unknown
  evidenceReference?: unknown
  resolutionSummary?: unknown
  postmortemReference?: unknown
}

export interface AdminAppIncidentRunbookInput {
  expectedVersion?: unknown
  runbookId?: unknown
  reasonCode?: unknown
}

export interface AdminAppSafetyControlChangeInput {
  action?: unknown
  controlKey?: unknown
  expectedControlVersion?: unknown
  incidentId?: unknown
  expectedIncidentVersion?: unknown
  reasonCode?: unknown
  reasonSummary?: unknown
  evidenceReference?: unknown
}

export async function getAdminAppOperationsOverview(db: D1Database, now = new Date()) {
  const [definitions, latestRun, controls, incidentStats, recentIncidents] = await Promise.all([
    listCurrentMetricDefinitions(db),
    latestMetricRun(db),
    listAppOperationalControls(db),
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('resolved', 'false_positive') THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status NOT IN ('resolved', 'false_positive') AND severity = 'p0' THEN 1 ELSE 0 END) AS p0_count,
        SUM(CASE WHEN status NOT IN ('resolved', 'false_positive') AND severity = 'p1' THEN 1 ELSE 0 END) AS p1_count,
        SUM(CASE WHEN status NOT IN ('resolved', 'false_positive') AND owner_admin_id IS NULL THEN 1 ELSE 0 END) AS unassigned_count
      FROM app_operational_incidents
    `).first<{
      total: number
      open_count: number | null
      p0_count: number | null
      p1_count: number | null
      unassigned_count: number | null
    }>(),
    db.prepare(`${incidentSelect()}
      WHERE incident.status NOT IN ('resolved', 'false_positive')
      ORDER BY ${incidentSeverityOrder('incident.severity')}, incident.last_seen_at DESC, incident.id DESC
      LIMIT 6
    `).all<IncidentRow>(),
  ])

  const snapshots = latestRun
    ? await listMetricSnapshotsForRun(db, latestRun.id)
    : []
  const snapshotMap = new Map(snapshots.map(item => [item.metric_key, item]))
  const topics = orderedTopics().map(topic => {
    const metrics = definitions
      .filter(definition => definition.topic === topic.key)
      .map(definition => mapOverviewMetric(definition, snapshotMap.get(definition.metric_key), latestRun, now))
    return {
      key: topic.key,
      label: topic.label,
      state: summarizeTopicState(metrics.map(metric => metric.quality.state), controls, topic.key),
      metrics,
    }
  })
  const openP0 = Number(incidentStats?.p0_count ?? 0)
  const openP1 = Number(incidentStats?.p1_count ?? 0)
  const paused = controls.filter(control => control.state === 'paused')
  const unknownMetricCount = topics.flatMap(topic => topic.metrics)
    .filter(metric => metric.quality.state !== 'known').length
  const overallState = openP0 > 0
    ? 'critical'
    : openP1 > 0 || paused.length > 0
      ? 'attention'
      : !latestRun || unknownMetricCount > 0
        ? 'partial'
        : 'healthy'

  return {
    scope: { key: 'global', label: 'App 全局运营范围' },
    generatedAt: now.toISOString(),
    overall: {
      state: overallState,
      label: {
        critical: '存在 P0 事件',
        attention: '存在高优事件或安全暂停',
        partial: '数据不完整',
        healthy: '当前未发现高优异常',
      }[overallState],
      unknownMetricCount,
    },
    snapshot: latestRun
      ? {
          runId: latestRun.id,
          version: latestRun.run_version,
          status: latestRun.status,
          metricCount: Number(latestRun.metric_count),
          knownCount: Number(latestRun.known_count),
          completedAt: latestRun.completed_at,
          ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(latestRun.completed_at)) / 1000)),
        }
      : null,
    controls,
    incidents: {
      total: Number(incidentStats?.total ?? 0),
      open: Number(incidentStats?.open_count ?? 0),
      p0: openP0,
      p1: openP1,
      unassigned: Number(incidentStats?.unassigned_count ?? 0),
      recent: recentIncidents.results.map(mapIncidentSummary),
    },
    topics,
    dataBoundary: {
      missingIsZero: false,
      individualRankingEnabled: false,
      futureCapabilityMetricsIncluded: false,
      excludedFutureCapabilities: ['payment', 'gifts', 'cosmetics', 'push', 'person_claim'],
    },
  }
}

export async function refreshAdminAppOperationsOverview(
  db: D1Database,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  now = new Date(),
  cloudflareAnalyticsConfig: CloudflareOperationsAnalyticsConfig = {},
  cloudflareAnalyticsReader: typeof readCloudflareOperationsAnalytics = readCloudflareOperationsAnalytics,
) {
  requireOwnerActor(actor)
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({ scope: 'global', version: METRIC_RUN_VERSION }))
  const replay = await findAdminCommand(db, actor.adminId, 'refresh_overview', idempotencyKey)
  if (replay) {
    assertCommandReplay(replay, requestHash, 'metric_run')
    return { overview: await getAdminAppOperationsOverview(db, now), replayed: true }
  }

  const [definitions, cloudflareMetricValues] = await Promise.all([
    listCurrentMetricDefinitions(db),
    readCloudflareOperationsMetricsSafely(cloudflareAnalyticsReader, cloudflareAnalyticsConfig, now),
  ])
  const measuredAt = now.toISOString()
  const values = await Promise.all(definitions.map(async definition => ({
    definition,
    value: await collectMetricValue(db, definition.metric_key, now, cloudflareMetricValues),
  })))
  const knownCount = values.filter(item => item.value.quality === 'known').length
  const failedCount = values.filter(item => ['unknown', 'invalid'].includes(item.value.quality)).length
  const partialCount = values.filter(item => ['partial', 'delayed', 'unconfigured'].includes(item.value.quality)).length
  const status = failedCount > 0 ? 'partial' : partialCount > 0 ? 'partial' : 'completed'
  const runId = generateId('opmr')
  const auditId = generateId('audit')
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_operational_metric_runs (
        id, run_version, scope_key, status, metric_count, known_count,
        quality_summary_json, started_by, started_at, completed_at
      ) VALUES (?, ?, 'global', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId,
      METRIC_RUN_VERSION,
      status,
      values.length,
      knownCount,
      JSON.stringify({ known: knownCount, unavailable: values.length - knownCount }),
      actor.adminId,
      measuredAt,
      measuredAt,
    ),
  ]
  for (const { definition, value } of values) {
    statements.push(db.prepare(`
      INSERT INTO app_operational_metric_snapshots (
        id, run_id, definition_id, scope_key, quality_state,
        value_integer, value_real, value_text, source_watermark,
        measured_at, safe_details_json, created_at
      ) VALUES (?, ?, ?, 'global', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('opms'),
      runId,
      definition.id,
      value.quality,
      value.valueInteger ?? null,
      value.valueReal ?? null,
      value.valueText ?? null,
      value.sourceWatermark,
      measuredAt,
      JSON.stringify(value.details),
      measuredAt,
    ))
  }
  statements.push(
    db.prepare(`
      INSERT INTO app_operational_admin_commands (
        id, admin_id, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, created_at
      ) VALUES (?, ?, 'refresh_overview', ?, ?, 'metric_run', ?, NULL, ?)
    `).bind(generateId('opcmd'), actor.adminId, idempotencyKey, requestHash, runId, measuredAt),
    auditStatement(db, auditId, actor, 'app.operations.overview.refresh', 'app_operational_metric_run', runId, null, {
      runVersion: METRIC_RUN_VERSION,
      metricCount: values.length,
      knownCount,
      status,
    }, measuredAt),
    auditContextStatement(db, auditId, actor, 'manual_refresh', runId, measuredAt),
  )
  try {
    await db.batch(statements)
  }
  catch (error) {
    const raced = await findAdminCommand(db, actor.adminId, 'refresh_overview', idempotencyKey)
    if (raced) {
      assertCommandReplay(raced, requestHash, 'metric_run')
      return { overview: await getAdminAppOperationsOverview(db, now), replayed: true }
    }
    throw error
  }
  return { overview: await getAdminAppOperationsOverview(db, now), replayed: false }
}

async function listCurrentMetricDefinitions(db: D1Database) {
  const rows = await db.prepare(`
    SELECT id, metric_key, schema_version, topic, display_name, description, unit,
           source_type, source_reference, owner_reference, freshness_slo_seconds,
           sensitivity, retention_decision_status, retention_policy_reference, production_ready
    FROM app_operational_current_metric_definitions
    ORDER BY topic ASC, metric_key ASC
  `).all<MetricDefinitionRow>()
  return rows.results
}

async function latestMetricRun(db: D1Database) {
  return db.prepare(`
    SELECT id, run_version, status, metric_count, known_count, quality_summary_json,
           started_by, started_at, completed_at
    FROM app_operational_metric_runs
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `).first<MetricRunRow>()
}

async function listMetricSnapshotsForRun(db: D1Database, runId: string) {
  const rows = await db.prepare(`
    SELECT definition.id, definition.metric_key, definition.schema_version,
           definition.topic, definition.display_name, definition.description,
           definition.unit, definition.source_type, definition.source_reference,
           definition.owner_reference, definition.freshness_slo_seconds,
           definition.sensitivity, definition.retention_decision_status,
           definition.retention_policy_reference, definition.production_ready,
           snapshot.id AS snapshot_id, snapshot.run_id, snapshot.quality_state,
           snapshot.value_integer, snapshot.value_real, snapshot.value_text,
           snapshot.source_watermark, snapshot.measured_at, snapshot.safe_details_json
    FROM app_operational_current_metric_definitions definition
    LEFT JOIN app_operational_metric_snapshots snapshot
      ON snapshot.definition_id = definition.id AND snapshot.run_id = ?
    ORDER BY definition.topic ASC, definition.metric_key ASC
  `).bind(runId).all<MetricSnapshotRow>()
  return rows.results
}

function mapOverviewMetric(
  definition: MetricDefinitionRow,
  snapshot: MetricSnapshotRow | undefined,
  run: MetricRunRow | null,
  now: Date,
) {
  let quality: MetricQuality = snapshot?.quality_state as MetricQuality || 'unknown'
  if (
    quality === 'known'
    && run
    && now.getTime() - Date.parse(run.completed_at) > Number(definition.freshness_slo_seconds) * 1000
  ) {
    quality = 'delayed'
  }
  const value = quality === 'known'
    ? snapshot?.value_integer ?? snapshot?.value_real ?? snapshot?.value_text ?? null
    : null
  return {
    key: definition.metric_key,
    name: definition.display_name,
    description: definition.description,
    unit: definition.unit,
    value,
    quality: {
      state: quality,
      label: metricQualityLabel(quality),
    },
    source: {
      type: definition.source_type,
      reference: definition.source_reference,
      watermark: snapshot?.source_watermark ?? null,
      measuredAt: snapshot?.measured_at ?? null,
      freshnessSloSeconds: Number(definition.freshness_slo_seconds),
    },
    governance: {
      ownerReference: definition.owner_reference,
      sensitivity: definition.sensitivity,
      retentionDecisionStatus: definition.retention_decision_status,
      retentionPolicyReference: definition.retention_policy_reference,
      productionReady: definition.production_ready === 1,
    },
  }
}

async function readCloudflareOperationsMetricsSafely(
  reader: typeof readCloudflareOperationsAnalytics,
  config: CloudflareOperationsAnalyticsConfig,
  now: Date,
): Promise<Partial<CloudflareOperationsMetricValues>> {
  try {
    return await reader(config, now)
  }
  catch {
    return {}
  }
}

async function collectMetricValue(
  db: D1Database,
  metricKey: string,
  now: Date,
  cloudflareMetricValues: Partial<CloudflareOperationsMetricValues>,
): Promise<MetricValue> {
  if (metricKey.startsWith('platform.')) {
    return cloudflareMetricValues[metricKey as keyof CloudflareOperationsMetricValues] ?? {
      quality: 'unknown',
      sourceWatermark: null,
      details: { code: 'CLOUDFLARE_ANALYTICS_READER_FAILED' },
    }
  }
  try {
    switch (metricKey) {
      case 'supply.public_profiles':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(projection.updated_at) AS watermark
          FROM profile_public_projections projection
          JOIN galleries gallery ON gallery.id = projection.source_gallery_id
          WHERE projection.verification_status = 'verified'
            AND projection.publication_status = 'published'
            AND projection.authorization_status = 'active'
            AND projection.visibility_status = 'visible'
            AND (projection.authorization_valid_from IS NULL OR datetime(projection.authorization_valid_from) <= datetime(?))
            AND (projection.authorization_valid_until IS NULL OR datetime(projection.authorization_valid_until) > datetime(?))
            AND (projection.verification_valid_until IS NULL OR datetime(projection.verification_valid_until) > datetime(?))
            AND gallery.status = 'published'
        `, [now.toISOString(), now.toISOString(), now.toISOString()])
      case 'supply.pending_publications':
        return countMetric(db, `SELECT COUNT(*) AS count, MAX(updated_at) AS watermark FROM person_profiles WHERE publication_status = 'pending_review'`)
      case 'discovery.active_rules':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_recommendation_rule_versions
          WHERE state = 'active'
            AND (effective_at IS NULL OR datetime(effective_at) <= datetime(?))
            AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        `, [now.toISOString(), now.toISOString()])
      case 'discovery.active_editorial':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_recommendation_editorial_placements
          WHERE state = 'active' AND datetime(starts_at) <= datetime(?) AND datetime(ends_at) > datetime(?)
        `, [now.toISOString(), now.toISOString()])
      case 'messaging.unassigned_conversations':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(conversation.updated_at) AS watermark
          FROM app_conversations conversation
          WHERE conversation.status = 'active' AND conversation.queue_status = 'awaiting_operator'
            AND NOT EXISTS (
              SELECT 1 FROM app_conversation_assignment_state assignment
              WHERE assignment.conversation_id = conversation.id
                AND assignment.status = 'active'
                AND datetime(assignment.lease_expires_at) > datetime(?)
            )
        `, [now.toISOString()])
      case 'messaging.open_safety_escalations':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_conversation_safety_escalations
          WHERE status IN ('submitted', 'investigating')
        `)
      case 'membership.active_grants':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(grant_row.created_at) AS watermark
          FROM app_membership_grants grant_row
          WHERE datetime(grant_row.starts_at) <= datetime(?) AND datetime(grant_row.expires_at) > datetime(?)
            AND NOT EXISTS (
              SELECT 1 FROM app_membership_grant_revocations revocation WHERE revocation.grant_id = grant_row.id
            )
        `, [now.toISOString(), now.toISOString()])
      case 'membership.pending_reviews':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_membership_change_requests
          WHERE status IN ('pending_review', 'executing')
        `)
      case 'wallet.pending_adjustments':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_wallet_adjustments
          WHERE status IN ('pending_review', 'executing')
        `)
      case 'wallet.integrity_mismatches':
        return countMetric(db, walletMismatchCountSql())
      case 'notification.pending_deliveries':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(created_at) AS watermark
          FROM app_notification_outbox WHERE status IN ('pending', 'processing')
        `)
      case 'notification.dead_letters':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(processed_at) AS watermark
          FROM app_notification_outbox WHERE status = 'dead_letter'
        `)
      case 'safety.open_reports':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_safety_reports WHERE status IN ('submitted', 'triaged', 'investigating')
        `)
      case 'safety.open_appeals':
        return countMetric(db, `
          SELECT COUNT(*) AS count, MAX(updated_at) AS watermark
          FROM app_safety_appeals WHERE status IN ('submitted', 'triaged', 'investigating')
        `)
      case 'audit.integrity_findings': {
        const latest = await db.prepare(`
          SELECT id, status, created_at,
                 sequence_gap_count + missing_index_count + malformed_payload_count
                 + sensitive_key_count + unregistered_action_count
                 + business_without_audit_count AS count
          FROM app_audit_integrity_checks
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).first<{ id: string; status: string; created_at: string; count: number }>()
        if (!latest) {
          return { quality: 'unknown', sourceWatermark: null, details: { code: 'AUDIT_CHECK_NOT_RUN' } }
        }
        return {
          quality: 'known',
          valueInteger: Number(latest.count),
          sourceWatermark: latest.created_at,
          details: { checkId: latest.id, status: latest.status },
        }
      }
      default:
        return { quality: 'unknown', sourceWatermark: null, details: { code: 'METRIC_COLLECTOR_MISSING' } }
    }
  }
  catch {
    return { quality: 'unknown', sourceWatermark: null, details: { code: 'SOURCE_QUERY_FAILED' } }
  }
}

async function countMetric(db: D1Database, sql: string, bindings: unknown[] = []): Promise<MetricValue> {
  const row = await db.prepare(sql).bind(...bindings).first<{ count: number; watermark: string | null }>()
  if (!row || !Number.isFinite(Number(row.count))) {
    return { quality: 'invalid', sourceWatermark: null, details: { code: 'COUNT_RESULT_INVALID' } }
  }
  return {
    quality: 'known',
    valueInteger: Number(row.count),
    sourceWatermark: row.watermark,
    details: {},
  }
}

function walletMismatchCountSql() {
  return `
    SELECT COUNT(*) AS count, MAX(wallet.updated_at) AS watermark
    FROM app_wallets wallet
    WHERE wallet.sequence <> COALESCE((
      SELECT MAX(entry.sequence) FROM app_wallet_entries entry WHERE entry.wallet_id = wallet.id
    ), 0)
      OR (
        wallet.sequence = 0 AND wallet.balance <> 0
      )
      OR (
        wallet.sequence > 0 AND NOT EXISTS (
          SELECT 1 FROM app_wallet_entries entry
          WHERE entry.wallet_id = wallet.id
            AND entry.sequence = wallet.sequence
            AND entry.balance_after = wallet.balance
            AND entry.status = 'posted'
        )
      )
  `
}

async function listAppOperationalControls(db: D1Database) {
  return Promise.all(APP_OPERATIONAL_CONTROL_KEYS.map(key => getAppOperationalControl(db, key)))
}

function orderedTopics(): Array<{ key: IncidentDomain; label: string }> {
  return [
    { key: 'supply', label: '人物供给' },
    { key: 'discovery', label: '发现与推荐' },
    { key: 'messaging', label: '平台话题' },
    { key: 'membership', label: '会员' },
    { key: 'wallet', label: '金币钱包' },
    { key: 'notification', label: '站内通知' },
    { key: 'safety', label: '安全与申诉' },
    { key: 'audit', label: '审计完整性' },
    { key: 'platform', label: '平台健康' },
  ]
}

function summarizeTopicState(
  qualities: MetricQuality[],
  controls: AppOperationalControl[],
  topic: IncidentDomain,
) {
  const topicControlKeys: Partial<Record<IncidentDomain, AppOperationalControlKey[]>> = {
    supply: ['person_publication'],
    discovery: ['recommendation_delivery'],
    messaging: ['operator_messaging'],
    membership: ['membership_grants'],
    wallet: ['wallet_adjustments'],
  }
  if (controls.some(control => topicControlKeys[topic]?.includes(control.key) && control.state === 'paused')) return 'paused'
  if (qualities.includes('invalid')) return 'invalid'
  if (qualities.some(value => ['unknown', 'unconfigured'].includes(value))) return 'unknown'
  if (qualities.some(value => ['delayed', 'partial'].includes(value))) return 'delayed'
  return 'known'
}

function metricQualityLabel(quality: MetricQuality) {
  return {
    known: '数据可用',
    unknown: '未知',
    delayed: '数据延迟',
    partial: '数据不完整',
    invalid: '口径异常',
    unconfigured: '数据源未配置',
  }[quality]
}

export async function listAdminAppOperationalIncidents(
  db: D1Database,
  actor: AdminOperationsActor,
  input: AdminAppIncidentListInput,
) {
  const filter = normalizeIncidentListInput(input)
  const conditions: string[] = []
  const bindings: Array<string | number> = []
  if (filter.status) {
    conditions.push('incident.status = ?')
    bindings.push(filter.status)
  }
  if (filter.severity) {
    conditions.push('incident.severity = ?')
    bindings.push(filter.severity)
  }
  if (filter.domain) {
    conditions.push('incident.domain = ?')
    bindings.push(filter.domain)
  }
  if (filter.type) {
    conditions.push('incident.incident_type = ?')
    bindings.push(filter.type)
  }
  if (filter.owner === 'mine') {
    conditions.push('incident.owner_admin_id = ?')
    bindings.push(actor.adminId)
  } else if (filter.owner === 'unassigned') {
    conditions.push('incident.owner_admin_id IS NULL')
  } else if (filter.owner === 'assigned') {
    conditions.push('incident.owner_admin_id IS NOT NULL')
  }
  const baseConditions = [...conditions]
  const baseBindings = [...bindings]
  if (filter.cursor) {
    conditions.push('(incident.last_seen_at < ? OR (incident.last_seen_at = ? AND incident.id < ?))')
    bindings.push(filter.cursor.lastSeenAt, filter.cursor.lastSeenAt, filter.cursor.id)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const baseWhere = baseConditions.length ? `WHERE ${baseConditions.join(' AND ')}` : ''
  const [rows, summary] = await Promise.all([
    db.prepare(`${incidentSelect()}
      ${where}
      ORDER BY incident.last_seen_at DESC, incident.id DESC
      LIMIT ?
    `).bind(...bindings, filter.limit + 1).all<IncidentRow>(),
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ('resolved', 'false_positive') THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN severity = 'p0' AND status NOT IN ('resolved', 'false_positive') THEN 1 ELSE 0 END) AS p0_count,
        SUM(CASE WHEN severity = 'p1' AND status NOT IN ('resolved', 'false_positive') THEN 1 ELSE 0 END) AS p1_count,
        SUM(CASE WHEN owner_admin_id IS NULL AND status NOT IN ('resolved', 'false_positive') THEN 1 ELSE 0 END) AS unassigned_count
      FROM app_operational_incidents incident
      ${baseWhere}
    `).bind(...baseBindings).first<{
      total: number
      open_count: number | null
      p0_count: number | null
      p1_count: number | null
      unassigned_count: number | null
    }>(),
  ])
  const hasMore = rows.results.length > filter.limit
  const page = rows.results.slice(0, filter.limit)
  const last = page.at(-1)
  return {
    incidents: page.map(mapIncidentSummary),
    nextCursor: hasMore && last
      ? encodeIncidentCursor({ lastSeenAt: last.last_seen_at, id: last.id })
      : null,
    summary: {
      total: Number(summary?.total ?? 0),
      open: Number(summary?.open_count ?? 0),
      p0: Number(summary?.p0_count ?? 0),
      p1: Number(summary?.p1_count ?? 0),
      unassigned: Number(summary?.unassigned_count ?? 0),
    },
    appliedFilters: {
      status: filter.status,
      severity: filter.severity,
      domain: filter.domain,
      type: filter.type,
      owner: filter.owner,
    },
  }
}

export async function getAdminAppOperationalIncident(
  db: D1Database,
  incidentIdValue: unknown,
  actor?: AdminOperationsActor,
) {
  const incidentId = requireIncidentId(incidentIdValue)
  const incident = await requireIncidentRow(db, incidentId)
  const [events, controls] = await Promise.all([
    db.prepare(`
      SELECT event.id, event.sequence, event.incident_version, event.event_type,
             event.actor_type, event.actor_admin_id, actor.nickname AS actor_nickname,
             actor.role AS actor_role, event.status_from, event.status_to,
             event.reason_code, event.response_note, event.safe_summary_json,
             event.evidence_reference, event.created_at
      FROM app_operational_incident_events event
      LEFT JOIN users actor ON actor.id = event.actor_admin_id
      WHERE event.incident_id = ?
      ORDER BY event.sequence ASC
    `).bind(incidentId).all<IncidentEventRow>(),
    listAppOperationalControls(db),
  ])
  if (actor) {
    const nowIso = new Date().toISOString()
    const auditId = generateId('audit')
    await db.batch([
      auditStatement(db, auditId, actor, 'app.operations.incident.view', 'app_operational_incident', incidentId, null, {
        purpose: 'operational_investigation',
        visibleFields: ['response_note', 'resolution_summary', 'evidence_reference'],
      }, nowIso),
      auditContextStatement(db, auditId, actor, 'operational_investigation', incidentId, nowIso),
    ])
  }
  return {
    ...mapIncidentSummary(incident),
    source: {
      type: incident.source_type,
      reference: incident.source_reference,
      lastDetectionRunId: incident.last_detection_run_id,
    },
    timestamps: {
      firstSeenAt: incident.first_seen_at,
      lastSeenAt: incident.last_seen_at,
      acknowledgedAt: incident.acknowledged_at,
      mitigatedAt: incident.mitigated_at,
      resolvedAt: incident.resolved_at,
      createdAt: incident.created_at,
      updatedAt: incident.updated_at,
    },
    resolution: incident.resolution_code
      ? {
          code: incident.resolution_code,
          summary: incident.resolution_summary,
          evidenceReference: incident.close_evidence_reference,
          postmortemReference: incident.postmortem_reference,
        }
      : null,
    events: events.results.map(event => ({
      eventId: event.id,
      sequence: Number(event.sequence),
      incidentVersion: Number(event.incident_version),
      type: event.event_type,
      actor: event.actor_type === 'system'
        ? { type: 'system', id: null, label: '系统检测器' }
        : {
            type: 'admin',
            id: Number(event.actor_admin_id),
            label: adminLabel(event.actor_nickname, event.actor_role, Number(event.actor_admin_id)),
          },
      transition: event.status_from && event.status_to
        ? { from: event.status_from, to: event.status_to }
        : null,
      reasonCode: event.reason_code,
      responseNote: event.response_note,
      safeSummary: safeJsonObject(event.safe_summary_json),
      evidenceReference: event.evidence_reference,
      createdAt: event.created_at,
    })),
    controls: controls.map(control => ({
      ...control,
      linkedToThisIncident: control.incidentId === incident.id,
    })),
    permissions: {
      canClaim: !incident.owner_admin_id && !isTerminalIncident(incident.status),
      canRespond: actor
        ? actor.role === 'owner' || incident.owner_admin_id === actor.adminId
        : false,
      canOperateSafetyControls: actor?.role === 'owner',
    },
  }
}

export async function listAdminAppOperationalRunbooks(db: D1Database) {
  const rows = await db.prepare(`
    SELECT id, runbook_key, version, title, safe_summary, document_reference,
           domains_json, control_keys_json, minimum_severity
    FROM app_operational_current_runbooks
    ORDER BY title ASC, runbook_key ASC
  `).all<RunbookRow>()
  return rows.results.map(mapRunbook)
}

export async function claimAdminAppOperationalIncident(
  db: D1Database,
  incidentIdValue: unknown,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  input: AdminAppIncidentClaimInput,
  now = new Date(),
) {
  const incidentId = requireIncidentId(incidentIdValue)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({ incidentId, expectedVersion }))
  const replay = await findAdminCommand(db, actor.adminId, 'claim_incident', idempotencyKey)
  if (replay) return incidentCommandReplay(db, replay, requestHash, incidentId)

  const current = await requireIncidentRow(db, incidentId)
  if (current.version !== expectedVersion) throw incidentVersionConflict()
  if (isTerminalIncident(current.status)) {
    throw new AdminAppOperationsError(409, 'INCIDENT_TERMINAL', '已关闭事件不能再领取')
  }
  if (current.owner_admin_id !== null) {
    throw new AdminAppOperationsError(409, 'INCIDENT_ALREADY_ASSIGNED', '事件已由其他管理员领取')
  }
  const timestamp = now.toISOString()
  const nextVersion = current.version + 1
  const token = crypto.randomUUID()
  const auditId = generateId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_operational_incidents
      SET owner_admin_id = ?, status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
          acknowledged_at = COALESCE(acknowledged_at, ?), version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND version = ? AND owner_admin_id IS NULL
        AND status NOT IN ('resolved', 'false_positive')
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.status = 'active' AND actor.role IN ('admin', 'owner')
        )
    `).bind(
      actor.adminId,
      timestamp,
      nextVersion,
      token,
      timestamp,
      incidentId,
      expectedVersion,
      actor.adminId,
    ),
    guardedIncidentEvent(db, incidentId, nextVersion, token, {
      type: 'claimed',
      actor,
      statusFrom: current.status,
      statusTo: current.status === 'open' ? 'acknowledged' : current.status,
      reasonCode: 'operator_claimed',
      responseNote: null,
      evidenceReference: null,
      safeSummary: { assigned: true },
      timestamp,
    }),
    guardedIncidentCommand(db, incidentId, nextVersion, token, actor, 'claim_incident', idempotencyKey, requestHash, timestamp),
    guardedIncidentAudit(db, incidentId, nextVersion, token, auditId, actor, 'app.operations.incident.claim', {
      status: current.status,
      ownerAssigned: false,
      version: current.version,
    }, {
      status: current.status === 'open' ? 'acknowledged' : current.status,
      ownerAssigned: true,
      version: nextVersion,
    }, timestamp),
    auditContextStatement(db, auditId, actor, 'operator_claimed', incidentId, timestamp, true),
  ])
  await assertIncidentCommandStored(db, actor.adminId, 'claim_incident', idempotencyKey)
  return { incident: await getAdminAppOperationalIncident(db, incidentId), replayed: false }
}

export async function addAdminAppOperationalIncidentNote(
  db: D1Database,
  incidentIdValue: unknown,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  input: AdminAppIncidentNoteInput,
  now = new Date(),
) {
  const incidentId = requireIncidentId(incidentIdValue)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const reasonCode = requireReasonCode(input.reasonCode)
  const note = requiredText(input.note, 'note', 2, 1000)
  const evidenceReference = optionalReference(input.evidenceReference, 192)
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({ incidentId, expectedVersion, reasonCode, note, evidenceReference }))
  const replay = await findAdminCommand(db, actor.adminId, 'add_incident_note', idempotencyKey)
  if (replay) return incidentCommandReplay(db, replay, requestHash, incidentId)
  const current = await requireIncidentRow(db, incidentId)
  assertIncidentMutationAccess(current, actor)
  if (current.version !== expectedVersion) throw incidentVersionConflict()
  const timestamp = now.toISOString()
  const nextVersion = current.version + 1
  const token = crypto.randomUUID()
  const noteHash = await sha256Hex(note)
  const auditId = generateId('audit')
  await db.batch([
    guardedIncidentTouch(db, current, actor, nextVersion, token, timestamp),
    guardedIncidentEvent(db, incidentId, nextVersion, token, {
      type: 'note_added', actor, statusFrom: current.status, statusTo: current.status,
      reasonCode, responseNote: note, evidenceReference,
      safeSummary: { noteSha256: noteHash, noteLength: note.length }, timestamp,
    }),
    guardedIncidentCommand(db, incidentId, nextVersion, token, actor, 'add_incident_note', idempotencyKey, requestHash, timestamp),
    guardedIncidentAudit(db, incidentId, nextVersion, token, auditId, actor, 'app.operations.incident.note',
      { version: current.version },
      { version: nextVersion, reasonCode, noteSha256: noteHash, noteLength: note.length, hasEvidence: Boolean(evidenceReference) },
      timestamp),
    auditContextStatement(db, auditId, actor, reasonCode, incidentId, timestamp, true),
  ])
  await assertIncidentCommandStored(db, actor.adminId, 'add_incident_note', idempotencyKey)
  return { incident: await getAdminAppOperationalIncident(db, incidentId), replayed: false }
}

export async function changeAdminAppOperationalIncidentStatus(
  db: D1Database,
  incidentIdValue: unknown,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  input: AdminAppIncidentStatusInput,
  now = new Date(),
) {
  const incidentId = requireIncidentId(incidentIdValue)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const targetStatus = requireEnum(input.status, INCIDENT_STATUSES, 'status')
  const reasonCode = requireReasonCode(input.reasonCode)
  const note = optionalText(input.note, 1000)
  const evidenceReference = optionalReference(input.evidenceReference, 192)
  const resolutionSummary = optionalText(input.resolutionSummary, 500)
  const postmortemReference = optionalReference(input.postmortemReference, 240)
  if (isTerminalIncident(targetStatus) && (!evidenceReference || !resolutionSummary)) {
    throw new AdminAppOperationsError(422, 'INCIDENT_CLOSE_EVIDENCE_REQUIRED', '关闭事件必须提供结论摘要和证据引用')
  }
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({
    incidentId, expectedVersion, targetStatus, reasonCode, note,
    evidenceReference, resolutionSummary, postmortemReference,
  }))
  const replay = await findAdminCommand(db, actor.adminId, 'change_incident_status', idempotencyKey)
  if (replay) return incidentCommandReplay(db, replay, requestHash, incidentId)
  const current = await requireIncidentRow(db, incidentId)
  assertIncidentMutationAccess(current, actor)
  if (current.version !== expectedVersion) throw incidentVersionConflict()
  assertIncidentTransition(current.status as IncidentStatus, targetStatus)
  const timestamp = now.toISOString()
  const nextVersion = current.version + 1
  const token = crypto.randomUUID()
  const eventType = isTerminalIncident(targetStatus)
    ? targetStatus === 'resolved' ? 'resolved' : 'false_positive'
    : isTerminalIncident(current.status) && targetStatus === 'open'
      ? 'reopened'
      : 'status_changed'
  const noteHash = note ? await sha256Hex(note) : null
  const resolutionHash = resolutionSummary ? await sha256Hex(resolutionSummary) : null
  const auditId = generateId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_operational_incidents
      SET status = ?,
          acknowledged_at = CASE WHEN ? = 'acknowledged' THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END,
          mitigated_at = CASE WHEN ? = 'mitigated' THEN ? WHEN ? = 'open' THEN NULL ELSE mitigated_at END,
          resolved_at = CASE WHEN ? IN ('resolved', 'false_positive') THEN ? WHEN ? = 'open' THEN NULL ELSE resolved_at END,
          resolution_code = CASE WHEN ? IN ('resolved', 'false_positive') THEN ? WHEN ? = 'open' THEN NULL ELSE resolution_code END,
          resolution_summary = CASE WHEN ? IN ('resolved', 'false_positive') THEN ? WHEN ? = 'open' THEN NULL ELSE resolution_summary END,
          close_evidence_reference = CASE WHEN ? IN ('resolved', 'false_positive') THEN ? WHEN ? = 'open' THEN NULL ELSE close_evidence_reference END,
          postmortem_reference = CASE WHEN ? IN ('resolved', 'false_positive') THEN ? WHEN ? = 'open' THEN NULL ELSE postmortem_reference END,
          version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND version = ?
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.status = 'active'
            AND actor.role IN ('admin', 'owner')
            AND (actor.role = 'owner' OR app_operational_incidents.owner_admin_id = actor.id)
        )
    `).bind(
      targetStatus,
      targetStatus, timestamp,
      targetStatus, timestamp, targetStatus,
      targetStatus, timestamp, targetStatus,
      targetStatus, reasonCode, targetStatus,
      targetStatus, resolutionSummary, targetStatus,
      targetStatus, evidenceReference, targetStatus,
      targetStatus, postmortemReference, targetStatus,
      nextVersion, token, timestamp,
      incidentId, expectedVersion, actor.adminId,
    ),
    guardedIncidentEvent(db, incidentId, nextVersion, token, {
      type: eventType,
      actor,
      statusFrom: current.status,
      statusTo: targetStatus,
      reasonCode,
      responseNote: note,
      evidenceReference,
      safeSummary: {
        noteSha256: noteHash,
        noteLength: note?.length ?? 0,
        resolutionSha256: resolutionHash,
        hasPostmortem: Boolean(postmortemReference),
      },
      timestamp,
    }),
    guardedIncidentCommand(db, incidentId, nextVersion, token, actor, 'change_incident_status', idempotencyKey, requestHash, timestamp),
    guardedIncidentAudit(db, incidentId, nextVersion, token, auditId, actor, 'app.operations.incident.status',
      { status: current.status, version: current.version },
      {
        status: targetStatus, version: nextVersion, reasonCode,
        hasEvidence: Boolean(evidenceReference), resolutionSha256: resolutionHash,
      }, timestamp),
    auditContextStatement(db, auditId, actor, reasonCode, incidentId, timestamp, true),
  ])
  await assertIncidentCommandStored(db, actor.adminId, 'change_incident_status', idempotencyKey)
  return { incident: await getAdminAppOperationalIncident(db, incidentId), replayed: false }
}

export async function linkAdminAppOperationalIncidentRunbook(
  db: D1Database,
  incidentIdValue: unknown,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  input: AdminAppIncidentRunbookInput,
  now = new Date(),
) {
  const incidentId = requireIncidentId(incidentIdValue)
  const runbookId = requireRunbookId(input.runbookId)
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion')
  const reasonCode = requireReasonCode(input.reasonCode)
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({ incidentId, runbookId, expectedVersion, reasonCode }))
  const replay = await findAdminCommand(db, actor.adminId, 'link_runbook', idempotencyKey)
  if (replay) return incidentCommandReplay(db, replay, requestHash, incidentId)
  const [current, runbook] = await Promise.all([
    requireIncidentRow(db, incidentId),
    requireRunbook(db, runbookId),
  ])
  assertIncidentMutationAccess(current, actor)
  if (current.version !== expectedVersion) throw incidentVersionConflict()
  const timestamp = now.toISOString()
  const nextVersion = current.version + 1
  const token = crypto.randomUUID()
  const auditId = generateId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_operational_incidents
      SET runbook_id = ?, version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND version = ?
        AND EXISTS (
          SELECT 1 FROM users actor
          WHERE actor.id = ? AND actor.status = 'active'
            AND actor.role IN ('admin', 'owner')
            AND (actor.role = 'owner' OR app_operational_incidents.owner_admin_id = actor.id)
        )
    `).bind(runbookId, nextVersion, token, timestamp, incidentId, expectedVersion, actor.adminId),
    guardedIncidentEvent(db, incidentId, nextVersion, token, {
      type: 'runbook_linked', actor, statusFrom: current.status, statusTo: current.status,
      reasonCode, responseNote: null, evidenceReference: runbook.document_reference,
      safeSummary: { runbookId, runbookKey: runbook.runbook_key, runbookVersion: runbook.version }, timestamp,
    }),
    guardedIncidentCommand(db, incidentId, nextVersion, token, actor, 'link_runbook', idempotencyKey, requestHash, timestamp),
    guardedIncidentAudit(db, incidentId, nextVersion, token, auditId, actor, 'app.operations.incident.runbook.link',
      { runbookId: current.runbook_id, version: current.version },
      { runbookId, runbookVersion: runbook.version, version: nextVersion }, timestamp),
    auditContextStatement(db, auditId, actor, reasonCode, incidentId, timestamp, true),
  ])
  await assertIncidentCommandStored(db, actor.adminId, 'link_runbook', idempotencyKey)
  return { incident: await getAdminAppOperationalIncident(db, incidentId), replayed: false }
}

export async function previewAdminAppOperationalSafetyControl(
  db: D1Database,
  controlKeyValue: unknown,
  incidentIdValue: unknown,
) {
  const controlKey = requireControlKey(controlKeyValue)
  const incidentId = requireIncidentId(incidentIdValue)
  const [control, incident] = await Promise.all([
    getAppOperationalControl(db, controlKey),
    requireIncidentRow(db, incidentId),
  ])
  const canPause = control.state === 'available'
    && ['p0', 'p1'].includes(incident.severity)
    && !isTerminalIncident(incident.status)
  const canRestore = control.state === 'paused' && control.incidentId === incidentId
  return {
    control,
    incident: mapIncidentSummary(incident),
    impact: safetyControlImpact(controlKey),
    decision: {
      canPause,
      canRestore,
      blockers: [
        ...(control.state === 'paused' && control.incidentId !== incidentId ? ['CONTROL_LINKED_TO_ANOTHER_INCIDENT'] : []),
        ...(control.state === 'available' && !['p0', 'p1'].includes(incident.severity) ? ['INCIDENT_SEVERITY_TOO_LOW'] : []),
        ...(control.state === 'available' && isTerminalIncident(incident.status) ? ['INCIDENT_ALREADY_CLOSED'] : []),
      ],
    },
  }
}

export async function changeAdminAppOperationalSafetyControl(
  db: D1Database,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  input: AdminAppSafetyControlChangeInput,
  now = new Date(),
) {
  requireOwnerActor(actor)
  const action = input.action === 'pause' || input.action === 'restore'
    ? input.action
    : (() => { throw new AdminAppOperationsError(400, 'CONTROL_ACTION_INVALID', 'action 必须为 pause 或 restore') })()
  const controlKey = requireControlKey(input.controlKey)
  const incidentId = requireIncidentId(input.incidentId)
  const expectedControlVersion = positiveInteger(input.expectedControlVersion, 'expectedControlVersion')
  const expectedIncidentVersion = positiveInteger(input.expectedIncidentVersion, 'expectedIncidentVersion')
  const reasonCode = requireReasonCode(input.reasonCode)
  const reasonSummary = requiredText(input.reasonSummary, 'reasonSummary', 3, 500)
  const evidenceReference = optionalReference(input.evidenceReference, 192)
  if (action === 'restore' && !evidenceReference) {
    throw new AdminAppOperationsError(422, 'CONTROL_RESTORE_EVIDENCE_REQUIRED', '恢复安全控制必须提供验证证据引用')
  }
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({
    action, controlKey, incidentId, expectedControlVersion, expectedIncidentVersion,
    reasonCode, reasonSummary, evidenceReference,
  }))
  const replay = await findAdminCommand(db, actor.adminId, 'change_safety_control', idempotencyKey)
  if (replay) {
    assertCommandReplay(replay, requestHash, 'safety_control')
    return { control: await getAppOperationalControl(db, controlKey), replayed: true }
  }
  const [control, incident] = await Promise.all([
    getAppOperationalControl(db, controlKey),
    requireIncidentRow(db, incidentId),
  ])
  if (control.version !== expectedControlVersion) {
    throw new AdminAppOperationsError(409, 'CONTROL_VERSION_CONFLICT', '安全控制版本已变化，请刷新后重试')
  }
  if (incident.version !== expectedIncidentVersion) throw incidentVersionConflict()
  if (action === 'pause') {
    if (control.state !== 'available') {
      throw new AdminAppOperationsError(409, 'CONTROL_ALREADY_PAUSED', '该安全控制已暂停')
    }
    if (!['p0', 'p1'].includes(incident.severity) || isTerminalIncident(incident.status)) {
      throw new AdminAppOperationsError(422, 'CONTROL_INCIDENT_NOT_ELIGIBLE', '只有未关闭的 P0/P1 事件可以触发安全暂停')
    }
  } else if (control.state !== 'paused' || control.incidentId !== incidentId) {
    throw new AdminAppOperationsError(409, 'CONTROL_RESTORE_INCIDENT_MISMATCH', '该控制未由当前事件暂停，不能执行恢复')
  }
  const timestamp = now.toISOString()
  const nextControlVersion = control.version + 1
  const nextIncidentVersion = incident.version + 1
  const controlToken = crypto.randomUUID()
  const incidentToken = crypto.randomUUID()
  const reasonHash = await sha256Hex(reasonSummary)
  const auditId = generateId('audit')
  await db.batch([
    db.prepare(`
      UPDATE app_operational_safety_controls
      SET state = ?, version = ?, incident_id = ?, reason_code = ?, reason_summary = ?,
          changed_by = ?, changed_at = ?, mutation_token = ?
      WHERE control_key = ? AND version = ? AND state = ?
        AND EXISTS (
          SELECT 1 FROM users actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'owner'
        )
    `).bind(
      action === 'pause' ? 'paused' : 'available',
      nextControlVersion,
      action === 'pause' ? incidentId : null,
      action === 'pause' ? reasonCode : null,
      action === 'pause' ? reasonSummary : null,
      actor.adminId,
      timestamp,
      controlToken,
      controlKey,
      expectedControlVersion,
      action === 'pause' ? 'available' : 'paused',
      actor.adminId,
    ),
    db.prepare(`
      UPDATE app_operational_incidents
      SET version = ?, mutation_token = ?, updated_at = ?
      WHERE id = ? AND version = ?
        AND EXISTS (
          SELECT 1 FROM app_operational_safety_controls control
          WHERE control.control_key = ? AND control.version = ? AND control.mutation_token = ?
        )
    `).bind(
      nextIncidentVersion,
      incidentToken,
      timestamp,
      incidentId,
      expectedIncidentVersion,
      controlKey,
      nextControlVersion,
      controlToken,
    ),
    db.prepare(`
      INSERT INTO app_operational_safety_control_events (
        id, control_key, control_version, action, state_from, state_to,
        incident_id, reason_code, reason_summary, evidence_reference,
        actor_admin_id, created_at
      )
      SELECT ?, control_key, version, ?, ?, state, ?, ?, ?, ?, ?, ?
      FROM app_operational_safety_controls
      WHERE control_key = ? AND version = ? AND mutation_token = ?
    `).bind(
      generateId('opsce'),
      action === 'pause' ? 'paused' : 'restored',
      control.state,
      incidentId,
      reasonCode,
      reasonSummary,
      evidenceReference,
      actor.adminId,
      timestamp,
      controlKey,
      nextControlVersion,
      controlToken,
    ),
    guardedIncidentEvent(db, incidentId, nextIncidentVersion, incidentToken, {
      type: action === 'pause' ? 'control_paused' : 'control_restored',
      actor,
      statusFrom: incident.status,
      statusTo: incident.status,
      reasonCode,
      responseNote: null,
      evidenceReference,
      safeSummary: { controlKey, controlVersion: nextControlVersion, reasonSha256: reasonHash },
      timestamp,
    }),
    db.prepare(`
      INSERT INTO app_operational_admin_commands (
        id, admin_id, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, created_at
      )
      SELECT ?, ?, 'change_safety_control', ?, ?, 'safety_control', control_key, version, ?
      FROM app_operational_safety_controls
      WHERE control_key = ? AND version = ? AND mutation_token = ?
        AND EXISTS (
          SELECT 1 FROM app_operational_incidents incident
          WHERE incident.id = ? AND incident.version = ? AND incident.mutation_token = ?
        )
    `).bind(
      generateId('opcmd'), actor.adminId, idempotencyKey, requestHash, timestamp,
      controlKey, nextControlVersion, controlToken,
      incidentId, nextIncidentVersion, incidentToken,
    ),
    db.prepare(`
      INSERT INTO admin_audit_logs (
        id, admin_id, action, target_type, target_id, before_value, after_value, created_at
      )
      SELECT ?, ?, ?, 'app_operational_safety_control', control_key, ?, ?, ?
      FROM app_operational_safety_controls
      WHERE control_key = ? AND version = ? AND mutation_token = ?
    `).bind(
      auditId,
      actor.adminId,
      action === 'pause' ? 'app.operations.safety_control.pause' : 'app.operations.safety_control.restore',
      JSON.stringify({ state: control.state, version: control.version, incidentId: control.incidentId }),
      JSON.stringify({
        state: action === 'pause' ? 'paused' : 'available',
        version: nextControlVersion,
        incidentId,
        reasonCode,
        reasonSha256: reasonHash,
        hasEvidence: Boolean(evidenceReference),
      }),
      timestamp,
      controlKey,
      nextControlVersion,
      controlToken,
    ),
    auditContextStatement(db, auditId, actor, reasonCode, incidentId, timestamp, true),
  ])
  const stored = await findAdminCommand(db, actor.adminId, 'change_safety_control', idempotencyKey)
  if (!stored) {
    throw new AdminAppOperationsError(409, 'CONTROL_CONFLICT', '安全控制或事件状态已变化，请刷新后重试')
  }
  return { control: await getAppOperationalControl(db, controlKey), replayed: false }
}

type DetectorFinding = {
  detectorKey: string
  incidentKey: string
  type: IncidentType
  domain: IncidentDomain
  severity: IncidentSeverity
  title: string
  summary: string
  sourceReference: string
  impactCount: number
  impactScope: Record<string, unknown>
  runbookId: string
  walletFreeze?: { walletId: string; currentStatus: string }
}

type CloudflareComponentStatus =
  | 'operational'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage'
  | 'under_maintenance'

type CloudflareStatusIndicator = 'none' | 'minor' | 'major' | 'critical'
type CloudflareIncidentImpact = CloudflareStatusIndicator

type CloudflarePlatformHealthEvidence = {
  source: 'cloudflare_status_summary_v2'
  availability: 'available' | 'unavailable'
  observedAt: string
  sourceUpdatedAt?: string
  overallIndicator?: CloudflareStatusIndicator
  relevantComponents?: Array<{ name: string; status: CloudflareComponentStatus }>
  relevantIncidents?: Array<{
    id: string
    status: string
    impact: CloudflareIncidentImpact
    components: string[]
  }>
  unavailableReason?:
    | 'timeout'
    | 'network_error'
    | 'http_error'
    | 'response_too_large'
    | 'invalid_payload'
}

type CloudflarePlatformHealthDetection =
  | { available: true; finding: DetectorFinding | null; evidence: CloudflarePlatformHealthEvidence }
  | { available: false; finding: null; evidence: CloudflarePlatformHealthEvidence }

type CloudflarePlatformHealthReader = (now: Date) => Promise<CloudflarePlatformHealthDetection>

export async function runAdminAppOperationalDetection(
  db: D1Database,
  actor: AdminOperationsActor,
  idempotencyKeyValue: string | null,
  now = new Date(),
  platformHealthReader: CloudflarePlatformHealthReader = readCloudflarePlatformHealth,
) {
  requireOwnerActor(actor)
  const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue)
  const requestHash = await sha256Hex(JSON.stringify({ scope: 'global', version: DETECTOR_VERSION }))
  const replay = await findAdminCommand(db, actor.adminId, 'run_detection', idempotencyKey)
  if (replay) {
    assertCommandReplay(replay, requestHash, 'detection_run')
    return { run: await getDetectionRun(db, replay.result_id), replayed: true }
  }

  const [findings, platformHealth] = await Promise.all([
    collectOperationalFindings(db, now),
    readPlatformHealthSafely(platformHealthReader, now),
  ])
  if (platformHealth.finding) findings.push(platformHealth.finding)
  const existingPairs = await Promise.all(findings.map(async finding => ({
    finding,
    existing: await db.prepare(`${incidentSelect()} WHERE incident.incident_key = ? LIMIT 1`)
      .bind(finding.incidentKey).first<IncidentRow>(),
  })))
  const timestamp = now.toISOString()
  const runId = generateId('opdr')
  const unavailableDetectorCount = platformHealth.available ? 0 : 1
  const evidenceDigest = await sha256Hex(JSON.stringify({
    findings: findings
      .map(item => ({ key: item.incidentKey, count: item.impactCount, severity: item.severity }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    platformHealth: platformHealth.evidence,
  }))
  const createdCount = existingPairs.filter(item => !item.existing).length
  const refreshedCount = existingPairs.length - createdCount
  const auditId = generateId('audit')
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO app_operational_detection_runs (
        id, detector_version, scope_key, status, finding_count,
        incident_created_count, incident_refreshed_count, unavailable_detector_count,
        evidence_digest, started_by, started_at, completed_at
      ) VALUES (?, ?, 'global', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      runId,
      DETECTOR_VERSION,
      unavailableDetectorCount > 0 ? 'partial' : 'completed',
      findings.length,
      createdCount,
      refreshedCount,
      unavailableDetectorCount,
      evidenceDigest,
      actor.adminId,
      timestamp,
      timestamp,
    ),
  ]

  for (const pair of existingPairs) {
    const { finding, existing } = pair
    const evidence = await sha256Hex(JSON.stringify({
      detectorKey: finding.detectorKey,
      incidentKey: finding.incidentKey,
      count: finding.impactCount,
      severity: finding.severity,
      sourceReference: finding.sourceReference,
      impactScope: finding.impactScope,
      observedAt: timestamp,
    }))
    if (!existing) {
      const incidentId = generateId('opinc')
      statements.push(
        db.prepare(`
          INSERT INTO app_operational_incidents (
            id, incident_key, incident_type, domain, severity, title, safe_summary,
            source_type, source_reference, impact_count, impact_scope_json, status,
            runbook_id, version, signal_count, first_seen_at, last_seen_at,
            last_detection_run_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'detector', ?, ?, ?, 'open', ?, 1, 1, ?, ?, ?, ?, ?)
        `).bind(
          incidentId,
          finding.incidentKey,
          finding.type,
          finding.domain,
          finding.severity,
          finding.title,
          finding.summary,
          finding.sourceReference,
          finding.impactCount,
          JSON.stringify(finding.impactScope),
          finding.runbookId,
          timestamp,
          timestamp,
          runId,
          timestamp,
          timestamp,
        ),
        db.prepare(`
          INSERT INTO app_operational_incident_events (
            id, incident_id, sequence, incident_version, event_type, actor_type,
            actor_admin_id, status_from, status_to, reason_code, response_note,
            safe_summary_json, evidence_reference, created_at
          ) VALUES (?, ?, 1, 1, 'detected', 'system', NULL, NULL, 'open',
                    'detector_signal', NULL, ?, ?, ?)
        `).bind(
          generateId('opie'),
          incidentId,
          JSON.stringify({ detectorKey: finding.detectorKey, impactCount: finding.impactCount }),
          `detection:${runId}`,
          timestamp,
        ),
        detectionFindingStatement(db, runId, finding, incidentId, evidence, timestamp),
      )
    } else {
      const nextVersion = existing.version + 1
      const token = crypto.randomUUID()
      const nextStatus = isTerminalIncident(existing.status) ? 'open' : existing.status
      statements.push(
        db.prepare(`
          UPDATE app_operational_incidents
          SET severity = ?, title = ?, safe_summary = ?, source_reference = ?,
              impact_count = ?, impact_scope_json = ?, status = ?,
              version = ?, mutation_token = ?, signal_count = signal_count + 1,
              last_seen_at = ?, resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE resolved_at END,
              resolution_code = CASE WHEN ? = 'open' THEN NULL ELSE resolution_code END,
              resolution_summary = CASE WHEN ? = 'open' THEN NULL ELSE resolution_summary END,
              close_evidence_reference = CASE WHEN ? = 'open' THEN NULL ELSE close_evidence_reference END,
              postmortem_reference = CASE WHEN ? = 'open' THEN NULL ELSE postmortem_reference END,
              last_detection_run_id = ?, updated_at = ?
          WHERE id = ? AND version = ?
        `).bind(
          higherSeverity(existing.severity as IncidentSeverity, finding.severity),
          finding.title,
          finding.summary,
          finding.sourceReference,
          finding.impactCount,
          JSON.stringify(finding.impactScope),
          nextStatus,
          nextVersion,
          token,
          timestamp,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus,
          runId,
          timestamp,
          existing.id,
          existing.version,
        ),
        guardedIncidentEvent(db, existing.id, nextVersion, token, {
          type: isTerminalIncident(existing.status) ? 'reopened' : 'signal_refreshed',
          actor: null,
          statusFrom: existing.status,
          statusTo: nextStatus,
          reasonCode: 'detector_signal',
          responseNote: null,
          evidenceReference: `detection:${runId}`,
          safeSummary: { detectorKey: finding.detectorKey, impactCount: finding.impactCount },
          timestamp,
        }),
        db.prepare(`
          INSERT INTO app_operational_detection_findings (
            id, run_id, detector_key, incident_id, incident_key, observed_count,
            evidence_digest, safe_summary_json, created_at
          )
          SELECT ?, ?, ?, id, incident_key, ?, ?, ?, ?
          FROM app_operational_incidents
          WHERE id = ? AND version = ? AND mutation_token = ?
        `).bind(
          generateId('opdf'),
          runId,
          finding.detectorKey,
          finding.impactCount,
          evidence,
          JSON.stringify({ domain: finding.domain, severity: finding.severity }),
          timestamp,
          existing.id,
          nextVersion,
          token,
        ),
      )
    }
    if (finding.walletFreeze?.currentStatus === 'active') {
      const walletAuditId = generateId('audit')
      statements.push(
        db.prepare(`
          UPDATE app_wallets
          SET status = 'frozen', updated_at = ?
          WHERE id = ? AND status = 'active'
        `).bind(timestamp, finding.walletFreeze.walletId),
        db.prepare(`
          INSERT INTO admin_audit_logs (
            id, admin_id, action, target_type, target_id, before_value, after_value, created_at
          )
          SELECT ?, ?, 'app.operations.wallet.freeze_on_mismatch', 'app_wallet', id, ?, ?, ?
          FROM app_wallets
          WHERE id = ? AND status = 'frozen' AND updated_at = ?
        `).bind(
          walletAuditId,
          actor.adminId,
          JSON.stringify({ status: 'active' }),
          JSON.stringify({ status: 'frozen', reasonCode: 'wallet_integrity_mismatch' }),
          timestamp,
          finding.walletFreeze.walletId,
          timestamp,
        ),
        auditContextStatement(
          db,
          walletAuditId,
          actor,
          'wallet_integrity_mismatch',
          finding.incidentKey,
          timestamp,
          true,
        ),
      )
    }
  }
  statements.push(
    db.prepare(`
      INSERT INTO app_operational_admin_commands (
        id, admin_id, operation, idempotency_key, request_hash,
        result_type, result_id, result_version, created_at
      ) VALUES (?, ?, 'run_detection', ?, ?, 'detection_run', ?, NULL, ?)
    `).bind(generateId('opcmd'), actor.adminId, idempotencyKey, requestHash, runId, timestamp),
    auditStatement(db, auditId, actor, 'app.operations.detection.run', 'app_operational_detection_run', runId, null, {
      detectorVersion: DETECTOR_VERSION,
      findingCount: findings.length,
      incidentCreatedCount: createdCount,
      incidentRefreshedCount: refreshedCount,
      unavailableDetectorCount,
      evidenceDigest,
    }, timestamp),
    auditContextStatement(db, auditId, actor, 'manual_detection', runId, timestamp),
  )
  try {
    await db.batch(statements)
  }
  catch (error) {
    const raced = await findAdminCommand(db, actor.adminId, 'run_detection', idempotencyKey)
    if (raced) {
      assertCommandReplay(raced, requestHash, 'detection_run')
      return { run: await getDetectionRun(db, raced.result_id), replayed: true }
    }
    throw new AdminAppOperationsError(409, 'DETECTION_RUN_CONFLICT', '检测期间运营事实已变化，请使用新幂等键重试')
  }
  return { run: await getDetectionRun(db, runId), replayed: false }
}

async function readPlatformHealthSafely(
  reader: CloudflarePlatformHealthReader,
  now: Date,
): Promise<CloudflarePlatformHealthDetection> {
  try {
    return await reader(now)
  }
  catch {
    return unavailableCloudflarePlatformHealth(now, 'network_error')
  }
}

export async function readCloudflarePlatformHealth(
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<CloudflarePlatformHealthDetection> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLOUDFLARE_STATUS_TIMEOUT_MS)
  let responseText: string
  try {
    const response = await fetcher(CLOUDFLARE_STATUS_SUMMARY_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) return unavailableCloudflarePlatformHealth(now, 'http_error')
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > CLOUDFLARE_STATUS_MAX_RESPONSE_BYTES) {
      return unavailableCloudflarePlatformHealth(now, 'response_too_large')
    }
    responseText = await response.text()
  }
  catch {
    return unavailableCloudflarePlatformHealth(
      now,
      controller.signal.aborted ? 'timeout' : 'network_error',
    )
  }
  finally {
    clearTimeout(timeout)
  }
  if (new TextEncoder().encode(responseText).byteLength > CLOUDFLARE_STATUS_MAX_RESPONSE_BYTES) {
    return unavailableCloudflarePlatformHealth(now, 'response_too_large')
  }

  let payload: unknown
  try {
    payload = JSON.parse(responseText)
  }
  catch {
    return unavailableCloudflarePlatformHealth(now, 'invalid_payload')
  }
  const normalized = normalizeCloudflareStatusPayload(payload)
  if (!normalized) return unavailableCloudflarePlatformHealth(now, 'invalid_payload')

  const evidence: CloudflarePlatformHealthEvidence = {
    source: 'cloudflare_status_summary_v2',
    availability: 'available',
    observedAt: now.toISOString(),
    sourceUpdatedAt: normalized.sourceUpdatedAt,
    overallIndicator: normalized.overallIndicator,
    relevantComponents: normalized.components,
    relevantIncidents: normalized.incidents,
  }
  const degradedComponents = normalized.components.filter(component => component.status !== 'operational')
  const impactedNames = new Set(degradedComponents.map(component => component.name))
  for (const incident of normalized.incidents) {
    for (const component of incident.components) impactedNames.add(component)
  }
  if (impactedNames.size === 0 && normalized.incidents.length === 0) {
    return { available: true, finding: null, evidence }
  }

  const severity = platformHealthSeverity(degradedComponents, normalized.incidents)
  return {
    available: true,
    finding: {
      detectorKey: 'cloudflare.platform_health',
      incidentKey: 'detector:platform_health_anomaly:global',
      type: 'platform_health_anomaly',
      domain: 'platform',
      severity,
      title: 'Cloudflare 相关平台服务状态异常',
      summary: '官方状态显示 MeiGallery 依赖的 Cloudflare 服务存在降级、故障或维护；需结合项目自身症状核对影响。',
      sourceReference: 'cloudflare_status:summary_v2',
      impactCount: Math.max(1, impactedNames.size),
      impactScope: {
        scope: 'cloudflare_public_status',
        overallIndicator: normalized.overallIndicator,
        components: [...impactedNames].sort((a, b) => a.localeCompare(b)),
        componentStatuses: degradedComponents,
        incidentCount: normalized.incidents.length,
      },
      runbookId: 'oprb_cloudflare_platform_health_v1',
    },
    evidence,
  }
}

function unavailableCloudflarePlatformHealth(
  now: Date,
  unavailableReason: NonNullable<CloudflarePlatformHealthEvidence['unavailableReason']>,
): CloudflarePlatformHealthDetection {
  return {
    available: false,
    finding: null,
    evidence: {
      source: 'cloudflare_status_summary_v2',
      availability: 'unavailable',
      observedAt: now.toISOString(),
      unavailableReason,
    },
  }
}

function normalizeCloudflareStatusPayload(payload: unknown): {
  sourceUpdatedAt: string
  overallIndicator: CloudflareStatusIndicator
  components: Array<{ name: string; status: CloudflareComponentStatus }>
  incidents: Array<{
    id: string
    status: string
    impact: CloudflareIncidentImpact
    components: string[]
  }>
} | null {
  if (!isRecord(payload) || !isRecord(payload.page) || !isRecord(payload.status)) return null
  if (!Array.isArray(payload.components) || !Array.isArray(payload.incidents)) return null

  const sourceUpdatedAt = payload.page.updated_at
  const overallIndicator = payload.status.indicator
  if (typeof sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(sourceUpdatedAt))) return null
  if (!isCloudflareStatusIndicator(overallIndicator)) return null

  const relevantNames = new Set<string>(RELEVANT_CLOUDFLARE_COMPONENT_NAMES)
  const relevantComponentIds = new Set<string>()
  const relevantComponentNamesById = new Map<string, string>()
  const components: Array<{ name: string; status: CloudflareComponentStatus }> = []
  for (const component of payload.components) {
    if (!isRecord(component) || typeof component.id !== 'string' || typeof component.name !== 'string') {
      return null
    }
    if (!relevantNames.has(component.name)) continue
    if (!isCloudflareComponentStatus(component.status)) return null
    relevantComponentIds.add(component.id)
    relevantComponentNamesById.set(component.id, component.name)
    components.push({ name: component.name, status: component.status })
  }
  const discoveredNames = new Set(components.map(component => component.name))
  if (RELEVANT_CLOUDFLARE_COMPONENT_NAMES.some(name => !discoveredNames.has(name))) return null
  components.sort((a, b) => a.name.localeCompare(b.name) || a.status.localeCompare(b.status))

  const incidents: Array<{
    id: string
    status: string
    impact: CloudflareIncidentImpact
    components: string[]
  }> = []
  for (const incident of payload.incidents) {
    if (
      !isRecord(incident)
      || typeof incident.id !== 'string'
      || incident.id.length < 1
      || incident.id.length > 96
      || !isCloudflareIncidentStatus(incident.status)
      || !isCloudflareIncidentImpact(incident.impact)
      || !Array.isArray(incident.components)
    ) return null
    if (incident.status === 'resolved' || incident.status === 'postmortem') continue

    const affectedNames = new Set<string>()
    for (const component of incident.components) {
      if (!isRecord(component)) return null
      const id = typeof component.id === 'string' ? component.id : null
      const name = typeof component.name === 'string' ? component.name : null
      if ((!id || !relevantComponentIds.has(id)) && (!name || !relevantNames.has(name))) continue
      if (name && relevantNames.has(name)) affectedNames.add(name)
      else if (id) {
        const matchedName = relevantComponentNamesById.get(id)
        if (matchedName) affectedNames.add(matchedName)
      }
    }
    if (affectedNames.size === 0) continue
    incidents.push({
      id: incident.id.slice(0, 96),
      status: incident.status.slice(0, 40),
      impact: incident.impact,
      components: [...affectedNames].sort((a, b) => a.localeCompare(b)),
    })
  }
  incidents.sort((a, b) => a.id.localeCompare(b.id))
  return { sourceUpdatedAt, overallIndicator, components, incidents }
}

function platformHealthSeverity(
  components: Array<{ status: CloudflareComponentStatus }>,
  incidents: Array<{ impact: CloudflareIncidentImpact }>,
): IncidentSeverity {
  if (
    components.some(component => component.status === 'major_outage')
    || incidents.some(incident => incident.impact === 'critical')
  ) return 'p0'
  if (
    components.some(component => component.status === 'partial_outage')
    || incidents.some(incident => incident.impact === 'major')
  ) return 'p1'
  return 'p2'
}

function isCloudflareComponentStatus(value: unknown): value is CloudflareComponentStatus {
  return value === 'operational'
    || value === 'degraded_performance'
    || value === 'partial_outage'
    || value === 'major_outage'
    || value === 'under_maintenance'
}

function isCloudflareStatusIndicator(value: unknown): value is CloudflareStatusIndicator {
  return value === 'none' || value === 'minor' || value === 'major' || value === 'critical'
}

function isCloudflareIncidentImpact(value: unknown): value is CloudflareIncidentImpact {
  return isCloudflareStatusIndicator(value)
}

function isCloudflareIncidentStatus(value: unknown): value is string {
  return value === 'investigating'
    || value === 'identified'
    || value === 'monitoring'
    || value === 'resolved'
    || value === 'postmortem'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function collectOperationalFindings(db: D1Database, now: Date): Promise<DetectorFinding[]> {
  const nowIso = now.toISOString()
  const backlogBoundary = new Date(now.getTime() - 15 * 60_000).toISOString()
  const [
    unauthorizedPublication,
    operatorIdentity,
    membershipExpiryAccessLeaks,
    duplicateGrants,
    walletRows,
    unreviewedAdjustments,
    latestAuditCheck,
    sensitiveAuditFindings,
    notificationBacklog,
    overdueDataRights,
  ] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM profile_public_projections projection
      LEFT JOIN galleries gallery ON gallery.id = projection.source_gallery_id
      WHERE projection.visibility_status = 'visible'
        AND (
          projection.verification_status <> 'verified'
          OR projection.publication_status <> 'published'
          OR projection.authorization_status <> 'active'
          OR (projection.authorization_valid_from IS NOT NULL AND datetime(projection.authorization_valid_from) > datetime(?))
          OR (projection.authorization_valid_until IS NOT NULL AND datetime(projection.authorization_valid_until) <= datetime(?))
          OR (projection.verification_valid_until IS NOT NULL AND datetime(projection.verification_valid_until) <= datetime(?))
          OR gallery.id IS NULL OR gallery.status <> 'published'
        )
    `).bind(nowIso, nowIso, nowIso).first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_conversation_messages message
      LEFT JOIN app_conversation_operator_message_facts fact ON fact.message_id = message.id
      WHERE message.sender_type = 'platform_operator' AND fact.message_id IS NULL
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT quota.conversation_id || ':create' AS fact_id
        FROM app_conversation_quota_consumptions quota
        JOIN app_membership_grants grant_row ON grant_row.id = quota.membership_grant_id
        WHERE grant_row.expires_at <= quota.consumed_at
          AND NOT EXISTS (
            SELECT 1
            FROM app_membership_grants active_grant
            JOIN app_membership_tier_entitlements create_entitlement
              ON create_entitlement.catalog_version_id = active_grant.catalog_version_id
             AND create_entitlement.tier_id = active_grant.tier_id
             AND create_entitlement.entitlement_key = 'direct_message.create'
            JOIN app_membership_tier_entitlements send_entitlement
              ON send_entitlement.catalog_version_id = active_grant.catalog_version_id
             AND send_entitlement.tier_id = active_grant.tier_id
             AND send_entitlement.entitlement_key = 'direct_message.send'
            JOIN app_membership_tier_entitlements quota_entitlement
              ON quota_entitlement.catalog_version_id = active_grant.catalog_version_id
             AND quota_entitlement.tier_id = active_grant.tier_id
             AND quota_entitlement.entitlement_key = 'direct_message.new_threads_per_day'
            WHERE active_grant.user_id = quota.account_id
              AND active_grant.catalog_version_id = quota.catalog_version_id
              AND active_grant.starts_at <= quota.consumed_at
              AND active_grant.expires_at > quota.consumed_at
              AND create_entitlement.availability = 'available'
              AND json_extract(create_entitlement.value_json, '$') = 1
              AND send_entitlement.availability = 'available'
              AND quota_entitlement.availability = 'available'
              AND CAST(json_extract(quota_entitlement.value_json, '$') AS INTEGER) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM app_membership_grant_revocations revocation
                WHERE revocation.grant_id = active_grant.id
                  AND revocation.revoked_at <= quota.consumed_at
              )
          )

        UNION ALL

        SELECT message.id AS fact_id
        FROM app_conversation_messages message
        JOIN app_conversations conversation ON conversation.id = message.conversation_id
        WHERE message.sender_type = 'viewer'
          AND EXISTS (
            SELECT 1
            FROM app_membership_grants expired_grant
            WHERE expired_grant.user_id = conversation.account_id
              AND expired_grant.expires_at <= message.created_at
              AND NOT EXISTS (
                SELECT 1
                FROM app_membership_grant_revocations early_revocation
                WHERE early_revocation.grant_id = expired_grant.id
                  AND early_revocation.revoked_at < expired_grant.expires_at
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app_membership_grants active_grant
            JOIN app_membership_tier_entitlements send_entitlement
              ON send_entitlement.catalog_version_id = active_grant.catalog_version_id
             AND send_entitlement.tier_id = active_grant.tier_id
             AND send_entitlement.entitlement_key = 'direct_message.send'
            WHERE active_grant.user_id = conversation.account_id
              AND active_grant.starts_at <= message.created_at
              AND active_grant.expires_at > message.created_at
              AND send_entitlement.availability = 'available'
              AND json_extract(send_entitlement.value_json, '$') = 1
              AND NOT EXISTS (
                SELECT 1
                FROM app_membership_grant_revocations revocation
                WHERE revocation.grant_id = active_grant.id
                  AND revocation.revoked_at <= message.created_at
              )
          )
      ) leaked_membership_facts
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT user_id, catalog_version_id, tier_id, starts_at, expires_at, COUNT(*) AS duplicate_count
        FROM app_membership_grants grant_row
        WHERE NOT EXISTS (
          SELECT 1 FROM app_membership_grant_revocations revocation WHERE revocation.grant_id = grant_row.id
        )
        GROUP BY user_id, catalog_version_id, tier_id, starts_at, expires_at
        HAVING COUNT(*) > 1
      ) duplicates
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT wallet.id, wallet.status, wallet.balance, wallet.sequence
      FROM app_wallets wallet
      WHERE wallet.sequence <> COALESCE((
        SELECT MAX(entry.sequence) FROM app_wallet_entries entry WHERE entry.wallet_id = wallet.id
      ), 0)
        OR (wallet.sequence = 0 AND wallet.balance <> 0)
        OR (
          wallet.sequence > 0 AND NOT EXISTS (
            SELECT 1 FROM app_wallet_entries entry
            WHERE entry.wallet_id = wallet.id
              AND entry.sequence = wallet.sequence
              AND entry.balance_after = wallet.balance
              AND entry.status = 'posted'
          )
        )
      ORDER BY wallet.updated_at ASC, wallet.id ASC
      LIMIT 1000
    `).all<{ id: string; status: string; balance: number; sequence: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_wallet_adjustments
      WHERE status = 'applied' AND (reviewed_by IS NULL OR reviewed_by = requested_by)
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT id, status, created_at,
             sequence_gap_count + missing_index_count + malformed_payload_count
             + sensitive_key_count + unregistered_action_count
             + business_without_audit_count AS finding_count
      FROM app_audit_integrity_checks
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).first<{ id: string; status: string; created_at: string; finding_count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_audit_integrity_findings finding
      WHERE finding.finding_type = 'sensitive_key'
        AND finding.check_id = (
          SELECT id FROM app_audit_integrity_checks ORDER BY created_at DESC, id DESC LIMIT 1
        )
    `).first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_notification_outbox
      WHERE status = 'dead_letter'
        OR (status IN ('pending', 'processing') AND datetime(next_attempt_at) < datetime(?))
    `).bind(backlogBoundary).first<{ count: number }>(),
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM app_data_rights_requests
      WHERE deadline_at IS NOT NULL
        AND datetime(deadline_at) < datetime(?)
        AND status NOT IN ('completed', 'cancelled', 'expired')
    `).bind(nowIso).first<{ count: number }>(),
  ])

  const findings: DetectorFinding[] = []
  if (Number(unauthorizedPublication?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'publication.eligibility',
      incidentKey: 'detector:unauthorized_publication:global',
      type: 'unauthorized_publication', domain: 'supply', severity: 'p0',
      title: '公开人物投影不满足发布资格',
      summary: '检测到仍可见但未通过当前授权、认证、发布、有效期或来源图库门禁的人物投影。',
      sourceReference: 'profile_public_projections.eligibility',
      impactCount: Number(unauthorizedPublication!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_publication_safety_v1',
    })
  }
  if (Number(operatorIdentity?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'messaging.operator_identity',
      incidentKey: 'detector:operator_identity_anomaly:global',
      type: 'operator_identity_anomaly', domain: 'messaging', severity: 'p1',
      title: '运营回复缺少实际操作员事实',
      summary: '检测到平台运营消息没有对应的实际操作员、租约与披露版本事实。',
      sourceReference: 'app_conversation_operator_message_facts',
      impactCount: Number(operatorIdentity!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_operator_identity_v1',
    })
  }
  if (Number(membershipExpiryAccessLeaks?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'membership.expiry_access',
      incidentKey: 'detector:membership_expiry_not_revoked:global',
      type: 'membership_expiry_not_revoked', domain: 'membership', severity: 'p1',
      title: '会员到期后仍产生需会员授权的消息事实',
      summary: '检测到话题创建或观看者消息发生时不存在仍有效且允许对应动作的会员 grant；事件只保留聚合数量。',
      sourceReference: 'app_managed_conversations.membership_expiry_access',
      impactCount: Number(membershipExpiryAccessLeaks!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_membership_integrity_v1',
    })
  }
  if (Number(duplicateGrants?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'membership.duplicate_grants',
      incidentKey: 'detector:duplicate_membership_grant:global',
      type: 'duplicate_membership_grant', domain: 'membership', severity: 'p1',
      title: '存在完全重复的会员发放区间',
      summary: '检测到同一账号、目录、等级和起止区间存在多条未撤销 grant，需要人工核对。',
      sourceReference: 'app_membership_grants.duplicate_interval',
      impactCount: Number(duplicateGrants!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_membership_integrity_v1',
    })
  }
  for (const wallet of walletRows.results) {
    findings.push({
      detectorKey: 'wallet.snapshot_integrity',
      incidentKey: `detector:wallet_balance_mismatch:${wallet.id}`,
      type: 'wallet_balance_mismatch', domain: 'wallet', severity: 'p1',
      title: '钱包快照与不可变账本不一致',
      summary: '检测到钱包余额或 sequence 与账本末条不一致；钱包已进入冻结处置范围。',
      sourceReference: `app_wallets:${wallet.id}`,
      impactCount: 1, impactScope: { walletId: wallet.id },
      runbookId: 'oprb_wallet_reconciliation_v1',
      walletFreeze: { walletId: wallet.id, currentStatus: wallet.status },
    })
  }
  if (Number(unreviewedAdjustments?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'wallet.independent_review',
      incidentKey: 'detector:unreviewed_wallet_adjustment:global',
      type: 'unreviewed_wallet_adjustment', domain: 'wallet', severity: 'p1',
      title: '已生效金币调整缺少独立复核',
      summary: '检测到已生效调币记录缺少复核人或由发起人自行复核。',
      sourceReference: 'app_wallet_adjustments.review_integrity',
      impactCount: Number(unreviewedAdjustments!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_wallet_reconciliation_v1',
    })
  }
  if (latestAuditCheck && Number(latestAuditCheck.finding_count) > 0) {
    findings.push({
      detectorKey: 'audit.latest_integrity_check',
      incidentKey: `detector:audit_integrity_gap:${latestAuditCheck.id}`,
      type: 'audit_integrity_gap', domain: 'audit', severity: 'p1',
      title: '审计完整性检查存在发现',
      summary: '最近一次不可变审计清单发现序号、索引、载荷、登记或业务审计对应关系异常。',
      sourceReference: `app_audit_integrity_checks:${latestAuditCheck.id}`,
      impactCount: Number(latestAuditCheck.finding_count), impactScope: { checkId: latestAuditCheck.id },
      runbookId: 'oprb_audit_integrity_v1',
    })
  }
  if (latestAuditCheck && Number(sensitiveAuditFindings?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'audit.sensitive_payload',
      incidentKey: `detector:internal_note_exposure:${latestAuditCheck.id}`,
      type: 'internal_note_exposure', domain: 'audit', severity: 'p1',
      title: '通用审计载荷出现敏感字段',
      summary: '最近一次审计完整性检查发现疑似内部说明、正文、凭据或其他敏感字段。',
      sourceReference: `app_audit_integrity_findings:${latestAuditCheck.id}`,
      impactCount: Number(sensitiveAuditFindings!.count), impactScope: { checkId: latestAuditCheck.id },
      runbookId: 'oprb_audit_integrity_v1',
    })
  }
  if (Number(notificationBacklog?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'notification.delivery_backlog',
      incidentKey: 'detector:notification_backlog:global',
      type: 'notification_backlog', domain: 'notification', severity: 'p2',
      title: '站内通知投递积压',
      summary: '检测到超过恢复窗口仍未处理的通知或 dead letter，需要核对租约、重试与资格重验。',
      sourceReference: 'app_notification_outbox.backlog',
      impactCount: Number(notificationBacklog!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_notification_recovery_v1',
    })
  }
  if (Number(overdueDataRights?.count ?? 0) > 0) {
    findings.push({
      detectorKey: 'privacy.data_rights_deadline',
      incidentKey: 'detector:data_rights_overdue:global',
      type: 'data_rights_overdue', domain: 'safety', severity: 'p1',
      title: '数据权利申请超过处置期限',
      summary: '检测到尚未结束且已超过策略期限的数据导出或账号注销申请；运营事件只保留聚合数量，不展示申请人信息。',
      sourceReference: 'app_data_rights_requests.deadline',
      impactCount: Number(overdueDataRights!.count), impactScope: { scope: 'global' },
      runbookId: 'oprb_privacy_response_v1',
    })
  }
  return findings
}

async function getDetectionRun(db: D1Database, runId: string) {
  const row = await db.prepare(`
    SELECT id, detector_version, scope_key, status, finding_count,
           incident_created_count, incident_refreshed_count, unavailable_detector_count,
           evidence_digest, started_by, started_at, completed_at
    FROM app_operational_detection_runs WHERE id = ? LIMIT 1
  `).bind(runId).first<{
    id: string
    detector_version: string
    scope_key: string
    status: string
    finding_count: number
    incident_created_count: number
    incident_refreshed_count: number
    unavailable_detector_count: number
    evidence_digest: string
    started_by: number
    started_at: string
    completed_at: string
  }>()
  if (!row) throw new AdminAppOperationsError(404, 'DETECTION_RUN_NOT_FOUND', '检测运行不存在')
  return {
    runId: row.id,
    detectorVersion: row.detector_version,
    scope: row.scope_key,
    status: row.status,
    findingCount: Number(row.finding_count),
    incidentCreatedCount: Number(row.incident_created_count),
    incidentRefreshedCount: Number(row.incident_refreshed_count),
    unavailableDetectorCount: Number(row.unavailable_detector_count),
    evidenceDigest: row.evidence_digest,
    startedBy: Number(row.started_by),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function incidentSelect() {
  return `
    SELECT incident.id, incident.incident_key, incident.incident_type, incident.domain,
           incident.severity, incident.title, incident.safe_summary,
           incident.source_type, incident.source_reference, incident.impact_count,
           incident.impact_scope_json, incident.status, incident.owner_admin_id,
           owner.nickname AS owner_nickname, owner.role AS owner_role,
           incident.runbook_id, runbook.title AS runbook_title,
           runbook.runbook_key, runbook.version AS runbook_version,
           runbook.safe_summary AS runbook_summary,
           runbook.document_reference AS runbook_reference,
           incident.version, incident.signal_count, incident.first_seen_at,
           incident.last_seen_at, incident.acknowledged_at, incident.mitigated_at,
           incident.resolved_at, incident.resolution_code, incident.resolution_summary,
           incident.close_evidence_reference, incident.postmortem_reference,
           incident.last_detection_run_id, incident.created_at, incident.updated_at
    FROM app_operational_incidents incident
    LEFT JOIN users owner ON owner.id = incident.owner_admin_id
    LEFT JOIN app_operational_runbook_versions runbook ON runbook.id = incident.runbook_id
  `
}

function mapIncidentSummary(row: IncidentRow) {
  return {
    incidentId: row.id,
    incidentKey: row.incident_key,
    type: row.incident_type as IncidentType,
    domain: row.domain as IncidentDomain,
    severity: row.severity as IncidentSeverity,
    title: row.title,
    summary: row.safe_summary,
    impact: {
      count: row.impact_count === null ? null : Number(row.impact_count),
      scope: safeJsonObject(row.impact_scope_json),
    },
    status: row.status as IncidentStatus,
    owner: row.owner_admin_id === null
      ? null
      : {
          id: Number(row.owner_admin_id),
          label: adminLabel(row.owner_nickname, row.owner_role, Number(row.owner_admin_id)),
          role: row.owner_role,
        },
    runbook: row.runbook_id
      ? {
          id: row.runbook_id,
          key: row.runbook_key,
          version: row.runbook_version === null ? null : Number(row.runbook_version),
          title: row.runbook_title,
          summary: row.runbook_summary,
          documentReference: row.runbook_reference,
        }
      : null,
    version: Number(row.version),
    signalCount: Number(row.signal_count),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  }
}

function mapRunbook(row: RunbookRow) {
  return {
    runbookId: row.id,
    key: row.runbook_key,
    version: Number(row.version),
    title: row.title,
    summary: row.safe_summary,
    documentReference: row.document_reference,
    domains: safeJsonArray(row.domains_json),
    controlKeys: safeJsonArray(row.control_keys_json),
    minimumSeverity: row.minimum_severity,
  }
}

async function requireIncidentRow(db: D1Database, incidentId: string) {
  const row = await db.prepare(`${incidentSelect()} WHERE incident.id = ? LIMIT 1`)
    .bind(incidentId).first<IncidentRow>()
  if (!row) throw new AdminAppOperationsError(404, 'INCIDENT_NOT_FOUND', '运营事件不存在')
  return row
}

async function requireRunbook(db: D1Database, runbookId: string) {
  const row = await db.prepare(`
    SELECT id, runbook_key, version, title, safe_summary, document_reference,
           domains_json, control_keys_json, minimum_severity
    FROM app_operational_current_runbooks
    WHERE id = ? LIMIT 1
  `).bind(runbookId).first<RunbookRow>()
  if (!row) throw new AdminAppOperationsError(404, 'RUNBOOK_NOT_FOUND', 'Runbook 不存在或已停用')
  return row
}

function normalizeIncidentListInput(input: AdminAppIncidentListInput) {
  const status = optionalEnum(input.status, INCIDENT_STATUSES, 'status')
  const severity = optionalEnum(input.severity, INCIDENT_SEVERITIES, 'severity')
  const domain = optionalEnum(input.domain, INCIDENT_DOMAINS, 'domain')
  const type = optionalEnum(input.type, INCIDENT_TYPES, 'type')
  const owner = input.owner === undefined || input.owner === null || input.owner === ''
    ? 'all'
    : requireEnum(input.owner, ['all', 'mine', 'unassigned', 'assigned'] as const, 'owner')
  const limitNumber = input.limit === undefined || input.limit === null || input.limit === ''
    ? DEFAULT_INCIDENT_PAGE_SIZE
    : positiveInteger(input.limit, 'limit')
  if (limitNumber > MAX_INCIDENT_PAGE_SIZE) {
    throw new AdminAppOperationsError(400, 'INCIDENT_LIMIT_INVALID', `limit 不能超过 ${MAX_INCIDENT_PAGE_SIZE}`)
  }
  return {
    status,
    severity,
    domain,
    type,
    owner,
    limit: limitNumber,
    cursor: parseIncidentCursor(input.cursor),
  }
}

function parseIncidentCursor(value: unknown): { lastSeenAt: string; id: string } | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 500) throw invalidIncidentCursor()
  try {
    const parsed = JSON.parse(atob(value)) as { lastSeenAt?: unknown; id?: unknown }
    if (
      typeof parsed.lastSeenAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.lastSeenAt))
      || typeof parsed.id !== 'string'
      || !INCIDENT_ID.test(parsed.id)
    ) throw invalidIncidentCursor()
    return { lastSeenAt: parsed.lastSeenAt, id: parsed.id }
  }
  catch (error) {
    if (error instanceof AdminAppOperationsError) throw error
    throw invalidIncidentCursor()
  }
}

function encodeIncidentCursor(cursor: { lastSeenAt: string; id: string }) {
  return btoa(JSON.stringify(cursor))
}

function invalidIncidentCursor() {
  return new AdminAppOperationsError(400, 'INCIDENT_CURSOR_INVALID', '事件游标无效，请重新加载')
}

function requireIncidentId(value: unknown) {
  if (typeof value !== 'string' || !INCIDENT_ID.test(value)) {
    throw new AdminAppOperationsError(400, 'INCIDENT_ID_INVALID', '事件 ID 无效')
  }
  return value
}

function requireRunbookId(value: unknown) {
  if (typeof value !== 'string' || !RUNBOOK_ID.test(value)) {
    throw new AdminAppOperationsError(400, 'RUNBOOK_ID_INVALID', 'Runbook ID 无效')
  }
  return value
}

function requireControlKey(value: unknown): AppOperationalControlKey {
  if (typeof value !== 'string' || !APP_OPERATIONAL_CONTROL_KEYS.includes(value as AppOperationalControlKey)) {
    throw new AdminAppOperationsError(400, 'CONTROL_KEY_INVALID', '安全控制 key 无效')
  }
  return value as AppOperationalControlKey
}

function requireIdempotencyKey(value: string | null) {
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw new AdminAppOperationsError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要 16–128 位 Idempotency-Key')
  }
  return value
}

function positiveInteger(value: unknown, label: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AdminAppOperationsError(400, 'POSITIVE_INTEGER_REQUIRED', `${label} 必须为正整数`)
  }
  return parsed
}

function requireReasonCode(value: unknown) {
  if (typeof value !== 'string' || !REASON_CODE.test(value)) {
    throw new AdminAppOperationsError(400, 'REASON_CODE_INVALID', 'reasonCode 必须为 3–80 位小写稳定原因码')
  }
  return value
}

function requiredText(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'string') {
    throw new AdminAppOperationsError(400, 'TEXT_REQUIRED', `${label} 为必填文本`)
  }
  const text = value.trim()
  if (text.length < min || text.length > max) {
    throw new AdminAppOperationsError(400, 'TEXT_LENGTH_INVALID', `${label} 长度必须为 ${min}–${max} 个字符`)
  }
  return text
}

function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new AdminAppOperationsError(400, 'TEXT_LENGTH_INVALID', `文本长度不能超过 ${max} 个字符`)
  }
  return value.trim() || null
}

function optionalReference(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new AdminAppOperationsError(400, 'REFERENCE_INVALID', '证据或文档引用格式无效')
  }
  const reference = value.trim()
  if (reference.length > max || !REFERENCE.test(reference)) {
    throw new AdminAppOperationsError(400, 'REFERENCE_INVALID', '证据或文档引用仅允许稳定 ID、内部路径或 HTTPS 引用')
  }
  return reference
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new AdminAppOperationsError(400, 'ENUM_VALUE_INVALID', `${label} 取值无效`)
  }
  return value as T
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | null {
  if (value === undefined || value === null || value === '') return null
  return requireEnum(value, values, label)
}

function assertIncidentMutationAccess(incident: IncidentRow, actor: AdminOperationsActor) {
  if (actor.role !== 'owner' && incident.owner_admin_id !== actor.adminId) {
    throw new AdminAppOperationsError(403, 'INCIDENT_ASSIGNMENT_REQUIRED', '请先领取事件后再执行处置')
  }
}

function assertIncidentTransition(current: IncidentStatus, target: IncidentStatus) {
  if (current === target) {
    throw new AdminAppOperationsError(409, 'INCIDENT_STATUS_UNCHANGED', '目标状态与当前状态相同')
  }
  const allowed: Record<IncidentStatus, IncidentStatus[]> = {
    open: ['acknowledged', 'investigating', 'mitigated', 'resolved', 'false_positive'],
    acknowledged: ['investigating', 'mitigated', 'resolved', 'false_positive'],
    investigating: ['mitigated', 'resolved', 'false_positive'],
    mitigated: ['investigating', 'resolved', 'false_positive'],
    resolved: ['open'],
    false_positive: ['open'],
  }
  if (!allowed[current].includes(target)) {
    throw new AdminAppOperationsError(409, 'INCIDENT_TRANSITION_INVALID', `不能从 ${current} 迁移到 ${target}`)
  }
}

function isTerminalIncident(status: string) {
  return status === 'resolved' || status === 'false_positive'
}

function incidentVersionConflict() {
  return new AdminAppOperationsError(409, 'INCIDENT_VERSION_CONFLICT', '事件版本已变化，请刷新后重试')
}

function requireOwnerActor(actor: AdminOperationsActor) {
  if (actor.role !== 'owner') {
    throw new AdminAppOperationsError(403, 'OWNER_REQUIRED', '该操作需要站长权限')
  }
}

function adminLabel(nickname: string | null, role: string | null, id: number) {
  return nickname?.trim() || `${role === 'owner' ? '站长' : '管理员'} #${id}`
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  }
  catch {
    return {}
  }
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

function incidentSeverityOrder(column: string) {
  return `CASE ${column} WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END`
}

function higherSeverity(current: IncidentSeverity, next: IncidentSeverity) {
  return INCIDENT_SEVERITIES.indexOf(next) < INCIDENT_SEVERITIES.indexOf(current) ? next : current
}

function safetyControlImpact(controlKey: AppOperationalControlKey) {
  return {
    person_publication: {
      blockedOperations: ['提交人物发布复核', '批准人物公开发布'],
      unaffectedOperations: ['暂停或下线公开投影', '认证与授权撤销', '发布退回'],
    },
    recommendation_delivery: {
      blockedOperations: ['激活推荐规则', '激活平台精选', '推荐 Feed 规则与精选投放'],
      unaffectedOperations: ['暂停规则或排期', 'Dry-run', '回滚与调查'],
    },
    operator_messaging: {
      blockedOperations: ['平台运营发送新消息'],
      unaffectedOperations: ['领取、转派、查看历史、内部备注、安全升级、关闭话题'],
    },
    membership_grants: {
      blockedOperations: ['直接会员发放', '批准发放型会员变更'],
      unaffectedOperations: ['拒绝申请', '撤销会员', '查看历史与申请'],
    },
    wallet_adjustments: {
      blockedOperations: ['创建金币调整', '批准金币调整'],
      unaffectedOperations: ['拒绝申请', '查看账本与对账'],
    },
  }[controlKey]
}

async function findAdminCommand(
  db: D1Database,
  adminId: number,
  operation: string,
  idempotencyKey: string,
) {
  return db.prepare(`
    SELECT operation, request_hash, result_type, result_id, result_version
    FROM app_operational_admin_commands
    WHERE admin_id = ? AND operation = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(adminId, operation, idempotencyKey).first<AdminCommandRow>()
}

function assertCommandReplay(command: AdminCommandRow, requestHash: string, resultType: string) {
  if (command.request_hash !== requestHash || command.result_type !== resultType) {
    throw new AdminAppOperationsError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于另一项运营操作')
  }
}

async function incidentCommandReplay(
  db: D1Database,
  command: AdminCommandRow,
  requestHash: string,
  incidentId: string,
) {
  assertCommandReplay(command, requestHash, 'incident')
  if (command.result_id !== incidentId) {
    throw new AdminAppOperationsError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于另一个事件')
  }
  return { incident: await getAdminAppOperationalIncident(db, incidentId), replayed: true }
}

async function assertIncidentCommandStored(
  db: D1Database,
  adminId: number,
  operation: string,
  idempotencyKey: string,
) {
  const command = await findAdminCommand(db, adminId, operation, idempotencyKey)
  if (!command) throw incidentVersionConflict()
}

function guardedIncidentTouch(
  db: D1Database,
  current: IncidentRow,
  actor: AdminOperationsActor,
  nextVersion: number,
  token: string,
  timestamp: string,
) {
  return db.prepare(`
    UPDATE app_operational_incidents
    SET version = ?, mutation_token = ?, updated_at = ?
    WHERE id = ? AND version = ?
      AND EXISTS (
        SELECT 1 FROM users actor
        WHERE actor.id = ? AND actor.status = 'active'
          AND actor.role IN ('admin', 'owner')
          AND (actor.role = 'owner' OR app_operational_incidents.owner_admin_id = actor.id)
      )
  `).bind(nextVersion, token, timestamp, current.id, current.version, actor.adminId)
}

function guardedIncidentEvent(
  db: D1Database,
  incidentId: string,
  incidentVersion: number,
  token: string,
  input: {
    type: string
    actor: AdminOperationsActor | null
    statusFrom: string | null
    statusTo: string | null
    reasonCode: string
    responseNote: string | null
    evidenceReference: string | null
    safeSummary: Record<string, unknown>
    timestamp: string
  },
) {
  return db.prepare(`
    INSERT INTO app_operational_incident_events (
      id, incident_id, sequence, incident_version, event_type, actor_type,
      actor_admin_id, status_from, status_to, reason_code, response_note,
      safe_summary_json, evidence_reference, created_at
    )
    SELECT ?, id,
           COALESCE((SELECT MAX(sequence) FROM app_operational_incident_events WHERE incident_id = ?), 0) + 1,
           version, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM app_operational_incidents
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    generateId('opie'),
    incidentId,
    input.type,
    input.actor ? 'admin' : 'system',
    input.actor?.adminId ?? null,
    input.statusFrom,
    input.statusTo,
    input.reasonCode,
    input.responseNote,
    JSON.stringify(input.safeSummary),
    input.evidenceReference,
    input.timestamp,
    incidentId,
    incidentVersion,
    token,
  )
}

function guardedIncidentCommand(
  db: D1Database,
  incidentId: string,
  incidentVersion: number,
  token: string,
  actor: AdminOperationsActor,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO app_operational_admin_commands (
      id, admin_id, operation, idempotency_key, request_hash,
      result_type, result_id, result_version, created_at
    )
    SELECT ?, ?, ?, ?, ?, 'incident', id, version, ?
    FROM app_operational_incidents
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    generateId('opcmd'),
    actor.adminId,
    operation,
    idempotencyKey,
    requestHash,
    timestamp,
    incidentId,
    incidentVersion,
    token,
  )
}

function guardedIncidentAudit(
  db: D1Database,
  incidentId: string,
  incidentVersion: number,
  token: string,
  auditId: string,
  actor: AdminOperationsActor,
  action: string,
  before: unknown,
  after: unknown,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    )
    SELECT ?, ?, ?, 'app_operational_incident', id, ?, ?, ?
    FROM app_operational_incidents
    WHERE id = ? AND version = ? AND mutation_token = ?
  `).bind(
    auditId,
    actor.adminId,
    action,
    JSON.stringify(before),
    JSON.stringify(after),
    timestamp,
    incidentId,
    incidentVersion,
    token,
  )
}

function auditStatement(
  db: D1Database,
  auditId: string,
  actor: AdminOperationsActor,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    auditId,
    actor.adminId,
    action,
    targetType,
    targetId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    timestamp,
  )
}

function auditContextStatement(
  db: D1Database,
  auditId: string,
  actor: AdminOperationsActor,
  reasonCode: string,
  businessReference: string,
  timestamp: string,
  _guarded = false,
) {
  return db.prepare(`
    INSERT INTO app_audit_event_contexts (
      audit_event_id, request_id, trace_id, reason_code,
      business_reference, scope_summary, result, created_at
    )
    SELECT id, ?, ?, ?, ?, 'App 全局运营范围', 'succeeded', ?
    FROM admin_audit_logs WHERE id = ?
  `).bind(
    actor.requestId,
    actor.traceId,
    reasonCode,
    businessReference,
    timestamp,
    auditId,
  )
}

function detectionFindingStatement(
  db: D1Database,
  runId: string,
  finding: DetectorFinding,
  incidentId: string,
  evidenceDigest: string,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO app_operational_detection_findings (
      id, run_id, detector_key, incident_id, incident_key, observed_count,
      evidence_digest, safe_summary_json, created_at
    )
    SELECT ?, ?, ?, id, incident_key, ?, ?, ?, ?
    FROM app_operational_incidents WHERE id = ?
  `).bind(
    generateId('opdf'),
    runId,
    finding.detectorKey,
    finding.impactCount,
    evidenceDigest,
    JSON.stringify({ domain: finding.domain, severity: finding.severity }),
    timestamp,
    incidentId,
  )
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
