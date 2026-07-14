import type { AdPlatformRolloutPercentage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { loadMetaCapiCryptoKeys } from '../utils/meta-capi-crypto'
import { generateId } from '../utils/db'
import {
  META_CAPI_INCIDENT_DEFINITIONS,
  sanitizeMetaCapiIncidentEvidence,
  type MetaCapiIncidentEvidence,
  type MetaIncidentTriggerCode,
} from './meta-capi-incident-evidence'
import { normalizeMetaCapiRollout } from './meta-capi-rollout'

export interface MetaCircuitSnapshot {
  totalAttempts: number
  permanentFailures: number
  retryExhausted: number
  stalePending: number
  duplicateSuppressed: number
  duplicateDeliveryGroups: number
}

export type { MetaIncidentTriggerCode } from './meta-capi-incident-evidence'

export interface MetaIncidentTrigger {
  code: MetaIncidentTriggerCode
  severity: 'critical' | 'warning'
  summary: string
  evidence: MetaCapiIncidentEvidence
}

export type CircuitEnv = Pick<
  Bindings,
  | 'DB'
  | 'APP_ENV'
  | 'META_CAPI_ACCESS_TOKEN'
  | 'META_CAPI_DATA_KEY_CURRENT'
  | 'META_CAPI_DATA_KEY_PREVIOUS'
  | 'META_CAPI_QUEUE'
  | 'RELEASE_COMMIT'
>

type IncidentRow = {
  id: string
  environment: string
  status: string
  severity: string
  trigger_code: string
  trigger_summary: string
  target_rollout_percentage: number
  effective_rollout_percentage: number
  evidence: string
  opened_at: string
  last_observed_at: string
}

type AttemptSnapshotRow = {
  total_attempt_count: number
  permanent_failure_count: number
  retry_exhausted_count: number
}

type PendingSnapshotRow = {
  stale_pending_count: number
}

type DuplicateSnapshotRow = {
  duplicate_suppressed_count: number
}

type DuplicateGroupSnapshotRow = {
  duplicate_delivery_group_count: number
}

export class MetaCapiCircuitError extends Error {
  readonly code: string
  readonly httpStatus: 403 | 409
  readonly blockers: string[]

  constructor(code: string, httpStatus: 403 | 409, blockers: string[] = []) {
    super(code)
    this.name = 'MetaCapiCircuitError'
    this.code = code
    this.httpStatus = httpStatus
    this.blockers = [...blockers]
  }
}

export function createMetaIncidentTrigger(
  code: MetaIncidentTriggerCode,
  evidence: MetaCapiIncidentEvidence = {},
): MetaIncidentTrigger {
  const definition = META_CAPI_INCIDENT_DEFINITIONS[code]
  return {
    code,
    severity: definition.severity,
    summary: definition.summary,
    evidence: sanitizeMetaCapiIncidentEvidence(code, {
      ...evidence,
      errorCategory: definition.category,
    }),
  }
}

export function evaluateMetaCircuit(snapshot: MetaCircuitSnapshot): {
  criticalTriggers: MetaIncidentTrigger[]
  warnings: MetaIncidentTrigger[]
} {
  const normalized = normalizeSnapshot(snapshot)
  const criticalTriggers: MetaIncidentTrigger[] = []
  const warnings: MetaIncidentTrigger[] = []

  if (normalized.totalAttempts >= 10
    && normalized.permanentFailures * 100 >= normalized.totalAttempts * 5) {
    criticalTriggers.push(createMetaIncidentTrigger('permanent_failure_rate', {
      totalCount: normalized.totalAttempts,
      failedCount: normalized.permanentFailures,
      failedRate: roundRate(normalized.permanentFailures / normalized.totalAttempts),
    }))
  }
  if (normalized.retryExhausted >= 3) {
    criticalTriggers.push(createMetaIncidentTrigger('retry_exhausted', {
      retryExhaustedCount: normalized.retryExhausted,
    }))
  }
  if (normalized.stalePending >= 5) {
    criticalTriggers.push(createMetaIncidentTrigger('stale_pending', {
      stalePendingCount: normalized.stalePending,
    }))
  }
  if (normalized.duplicateDeliveryGroups >= 1) {
    criticalTriggers.push(createMetaIncidentTrigger('duplicate_delivery', {
      duplicateGroupCount: normalized.duplicateDeliveryGroups,
    }))
  }
  if (normalized.totalAttempts >= 20
    && normalized.duplicateSuppressed * 100 >= normalized.totalAttempts * 10) {
    warnings.push(createMetaIncidentTrigger('duplicate_suppressed_rate', {
      totalCount: normalized.totalAttempts,
      duplicateCount: normalized.duplicateSuppressed,
      duplicateRate: roundRate(normalized.duplicateSuppressed / normalized.totalAttempts),
    }))
  }

  return { criticalTriggers, warnings }
}

// Q5 Dataset Quality contract 未完成前，不接收任何可推断 identity 的输入。
export function evaluateDatasetPixelMismatch(): null {
  return null
}

export async function readMetaCircuitSnapshot(db: D1Database): Promise<MetaCircuitSnapshot> {
  const [attempts, pending, duplicates, duplicateGroups] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) AS total_attempt_count,
      COALESCE(SUM(CASE
        WHEN status = 'failed'
          AND (
            error_code IN ('meta_events_not_received', 'secure_context_authentication_failed')
            OR (error_code GLOB 'meta_http_4[0-9][0-9]' AND error_code <> 'meta_http_429')
          )
        THEN 1 ELSE 0 END), 0) AS permanent_failure_count,
      COALESCE(SUM(CASE
        WHEN status = 'failed'
          AND error_code = 'retry_exhausted'
        THEN 1 ELSE 0 END), 0) AS retry_exhausted_count
      FROM analytics_conversion_deliveries
      WHERE provider = 'meta'
        AND transport = 'server'
        AND status IN ('sent', 'failed')
        AND last_attempt_at >= datetime('now', '-15 minutes')
        AND last_attempt_at <= datetime('now')
    `).first<AttemptSnapshotRow>(),
    db.prepare(`
      SELECT COUNT(*) AS stale_pending_count
      FROM analytics_conversion_deliveries
      WHERE provider = 'meta'
        AND transport = 'server'
        AND status = 'pending'
        AND created_at >= datetime('now', '-15 minutes')
        AND created_at < datetime('now', '-10 minutes')
    `).first<PendingSnapshotRow>(),
    db.prepare(`
      SELECT COUNT(*) AS duplicate_suppressed_count
      FROM analytics_conversion_deliveries
      WHERE provider = 'meta'
        AND transport = 'server'
        AND duplicate_suppressed_at >= datetime('now', '-15 minutes')
        AND duplicate_suppressed_at <= datetime('now')
    `).first<DuplicateSnapshotRow>(),
    db.prepare(`
      SELECT COUNT(*) AS duplicate_delivery_group_count
      FROM (
        SELECT conversion_action_id
        FROM analytics_conversion_deliveries
        WHERE provider = 'meta'
          AND transport = 'server'
          AND created_at >= datetime('now', '-15 minutes')
          AND created_at <= datetime('now')
        GROUP BY conversion_action_id
        HAVING COUNT(*) > 1
      ) duplicate_delivery_groups
    `).first<DuplicateGroupSnapshotRow>(),
  ])

  return normalizeSnapshot({
    totalAttempts: count(attempts?.total_attempt_count),
    permanentFailures: count(attempts?.permanent_failure_count),
    retryExhausted: count(attempts?.retry_exhausted_count),
    stalePending: count(pending?.stale_pending_count),
    duplicateSuppressed: count(duplicates?.duplicate_suppressed_count),
    duplicateDeliveryGroups: count(duplicateGroups?.duplicate_delivery_group_count),
  })
}

export async function runMetaCapiCircuitEvaluation(env: CircuitEnv) {
  const snapshot = await readMetaCircuitSnapshot(env.DB)
  const evaluated = evaluateMetaCircuit(snapshot)
  const incidents = []
  for (const trigger of [...evaluated.criticalTriggers, ...evaluated.warnings]) {
    incidents.push(await openMetaCapiIncident(env, trigger))
  }
  return { snapshot, ...evaluated, incidents }
}

export async function openMetaCapiIncident(
  env: CircuitEnv,
  trigger: MetaIncidentTrigger,
): Promise<{ id: string; created: boolean }> {
  const environment = runtimeEnvironment(env.APP_ENV)
  const definition = META_CAPI_INCIDENT_DEFINITIONS[trigger.code]
  if (!definition
    || trigger.severity !== definition.severity
    || trigger.summary !== definition.summary) {
    throw new Error('Meta CAPI incident trigger 非法')
  }
  const observedAt = new Date().toISOString()
  const windowEnd = observedAt
  const windowStart = new Date(Date.parse(observedAt) - 15 * 60 * 1000).toISOString()
  const evidence = JSON.stringify(sanitizeMetaCapiIncidentEvidence(trigger.code, {
    ...trigger.evidence,
    windowStart,
    windowEnd,
    observedAt,
  }))
  const targetPercentage = await readTargetRollout(env.DB)
  const effectivePercentage = trigger.severity === 'critical' ? 0 : targetPercentage
  const candidateId = generateId('incident')
  const insert = env.DB.prepare(`
    INSERT OR IGNORE INTO meta_capi_incidents (
      id, environment, status, severity, trigger_code, trigger_summary,
      target_rollout_percentage, effective_rollout_percentage, evidence,
      opened_at, last_observed_at, created_at, updated_at
    ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    candidateId,
    environment,
    trigger.severity,
    trigger.code,
    definition.summary,
    targetPercentage,
    effectivePercentage,
    evidence,
    observedAt,
    observedAt,
    observedAt,
    observedAt,
  )
  const update = env.DB.prepare(`
    UPDATE meta_capi_incidents
    SET trigger_summary = ?,
        target_rollout_percentage = ?,
        effective_rollout_percentage = ?,
        evidence = ?,
        last_observed_at = ?,
        updated_at = ?
    WHERE environment = ?
      AND trigger_code = ?
      AND status = 'open'
      AND id <> ?
      AND last_observed_at < ?
  `).bind(
    definition.summary,
    targetPercentage,
    effectivePercentage,
    evidence,
    observedAt,
    observedAt,
    environment,
    trigger.code,
    candidateId,
    observedAt,
  )
  const results = await env.DB.batch([insert, update])
  const created = d1ChangedOnce(results[0])
  const row = await env.DB.prepare(`
    SELECT id
    FROM meta_capi_incidents
    WHERE environment = ? AND trigger_code = ? AND status = 'open'
    LIMIT 1
  `).bind(environment, trigger.code).first<{ id: string }>()
  if (!row?.id) throw new Error('Meta CAPI incident 写入失败')
  return { id: row.id, created }
}

export async function openMetaCapiIncidentSafely(env: CircuitEnv, trigger: MetaIncidentTrigger) {
  try {
    return await openMetaCapiIncident(env, trigger)
  }
  catch {
    console.error('[meta-capi.incident] incident 副作用失败', {
      errorCode: 'meta_incident_write_failed',
      triggerCode: trigger.code,
    })
    return null
  }
}

export async function closeMetaCapiIncident(
  env: CircuitEnv,
  input: { incidentId: string; ownerUserId: number; resolution: string },
): Promise<void> {
  const environment = runtimeEnvironment(env.APP_ENV)
  const owner = await env.DB.prepare(`
    SELECT id FROM users WHERE id = ? AND role = 'owner' LIMIT 1
  `).bind(input.ownerUserId).first<{ id: number }>()
  if (!owner) throw new MetaCapiCircuitError('OWNER_REQUIRED', 403)

  const incident = await env.DB.prepare(`
    SELECT id, environment, status, severity, trigger_code, trigger_summary,
      target_rollout_percentage, effective_rollout_percentage, evidence,
      opened_at, last_observed_at
    FROM meta_capi_incidents
    WHERE id = ? AND environment = ? AND status = 'open'
    LIMIT 1
  `).bind(input.incidentId, environment).first<IncidentRow>()
  const resolution = typeof input.resolution === 'string' ? input.resolution.trim() : ''
  const blockers: string[] = []
  if ([...resolution].length < 20) blockers.push('resolution_too_short')
  if (!incident) blockers.push('incident_not_open')

  let connection: { revision: string } | null = null
  try {
    const module = await import('./meta-connection')
    connection = await module.requireVerifiedMetaConnection(env)
  }
  catch {
    blockers.push('connection_unverified')
  }

  if (incident && connection) {
    const verification = await env.DB.prepare(`
      SELECT environment
      FROM meta_connection_verifications
      WHERE environment = ?
        AND revision = ?
        AND invalidated_at IS NULL
        AND datetime(verified_at) > datetime(?)
      LIMIT 1
    `).bind(
      environment,
      connection.revision,
      incident.opened_at,
    ).first<{ environment: string }>()
    if (!verification) blockers.push('test_event_after_incident_missing')
  }
  else if (incident) {
    blockers.push('test_event_after_incident_missing')
  }

  try {
    const snapshot = await readMetaCircuitSnapshot(env.DB)
    if (evaluateMetaCircuit(snapshot).criticalTriggers.length > 0) {
      blockers.push('critical_trigger_present')
    }
  }
  catch {
    blockers.push('circuit_snapshot_unavailable')
  }

  try {
    await loadMetaCapiCryptoKeys(env)
  }
  catch {
    blockers.push('data_key_unavailable')
  }
  if (!env.META_CAPI_QUEUE || typeof env.META_CAPI_QUEUE.send !== 'function') {
    blockers.push('queue_binding_missing')
  }

  const resourcesVerified = await env.DB.prepare(`
        SELECT id
        FROM analytics_release_verifications
        WHERE environment = ?
          AND verification_type = 'meta_resources'
          AND status = 'passed'
          AND datetime(expires_at) > datetime('now')
        ORDER BY verified_at DESC
        LIMIT 1
      `).bind(environment).first<{ id: string }>()
    .then(Boolean)
    .catch(() => false)
  if (!resourcesVerified) blockers.push('meta_resources_verification_missing')

  if (blockers.length > 0 || !incident) {
    throw new MetaCapiCircuitError('META_CAPI_INCIDENT_CLOSE_BLOCKED', 409, unique(blockers))
  }

  const closedAt = new Date().toISOString()
  const update = env.DB.prepare(`
    UPDATE meta_capi_incidents
    SET status = 'closed',
        closed_at = ?,
        closed_by_user_id = ?,
        resolution = ?,
        updated_at = ?
    WHERE id = ?
      AND environment = ?
      AND status = 'open'
      AND severity = ?
      AND trigger_code = ?
      AND target_rollout_percentage = ?
      AND effective_rollout_percentage = ?
      AND evidence = ?
      AND opened_at = ?
      AND last_observed_at = ?
  `).bind(
    closedAt,
    input.ownerUserId,
    resolution,
    closedAt,
    incident.id,
    environment,
    incident.severity,
    incident.trigger_code,
    incident.target_rollout_percentage,
    incident.effective_rollout_percentage,
    incident.evidence,
    incident.opened_at,
    incident.last_observed_at,
  )
  const audit = env.DB.prepare(`
    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    )
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE changes() = 1
  `).bind(
    generateId('log'),
    input.ownerUserId,
    'attribution.meta_incident_close',
    'attribution',
    incident.id,
    '{}',
    JSON.stringify({
      incidentId: incident.id,
      trigger: incident.trigger_code,
      resolution,
      environment,
      closedAt,
    }),
  )
  const results = await env.DB.batch([update, audit])
  if (!d1ChangedOnce(results[0])) {
    throw new MetaCapiCircuitError('META_CAPI_INCIDENT_CLOSE_CONFLICT', 409, ['incident_changed'])
  }
}

function runtimeEnvironment(value: unknown): 'dev' | 'production' {
  if (value === 'dev' || value === 'production') return value
  throw new Error('Meta CAPI incident 环境无效')
}

async function readTargetRollout(db: D1Database): Promise<AdPlatformRolloutPercentage> {
  const row = await db.prepare(
    "SELECT rollout_percentage FROM ad_platform_connections WHERE provider = 'meta' LIMIT 1",
  ).first<{ rollout_percentage: number }>()
  return normalizeMetaCapiRollout(row?.rollout_percentage)
}

function normalizeSnapshot(snapshot: MetaCircuitSnapshot): MetaCircuitSnapshot {
  return {
    totalAttempts: count(snapshot.totalAttempts),
    permanentFailures: count(snapshot.permanentFailures),
    retryExhausted: count(snapshot.retryExhausted),
    stalePending: count(snapshot.stalePending),
    duplicateSuppressed: count(snapshot.duplicateSuppressed),
    duplicateDeliveryGroups: count(snapshot.duplicateDeliveryGroups),
  }
}

function count(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function roundRate(value: number) {
  return Math.round(value * 10_000) / 10_000
}

function d1ChangedOnce(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0) === 1
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}
