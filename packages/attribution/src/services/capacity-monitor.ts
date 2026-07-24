export const CLOUDFLARE_FREE_DAILY_LIMITS = {
  workerRequests: 100_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  queueOperations: 10_000,
} as const

export type CapacityResource = keyof typeof CLOUDFLARE_FREE_DAILY_LIMITS
export type CapacityLevel = 'ok' | 'warning' | 'high' | 'critical'

export interface ActualCapacityUsage {
  schemaVersion: 1
  date: string
  measuredAt: string
  source: 'cloudflare-account-analytics'
  workerRequests: number
  d1RowsRead: number
  d1RowsWritten: number
  /**
   * Cloudflare 账户下全部 Queue 的实际 operations。
   * 不接受按 provider 拆分后重复套用 Free 额度，也不接受消息数估算。
   */
  queueOperations: number
}

export interface CapacityMetric {
  used: number
  limit: number
  ratio: number
  level: CapacityLevel
}

export interface CapacityAssessment {
  usage: ActualCapacityUsage
  metrics: Record<CapacityResource, CapacityMetric>
  level: CapacityLevel
  allowNonEssential: boolean
  allowServerEnqueue: boolean
}

export interface CapacityGate {
  observed: boolean
  level: CapacityLevel | 'unavailable'
  allowNonEssential: boolean
  allowServerEnqueue: boolean
}

const LEVEL_ORDER: Record<CapacityLevel, number> = {
  ok: 0,
  warning: 1,
  high: 2,
  critical: 3,
}

const USAGE_KEYS = [
  'schemaVersion',
  'date',
  'measuredAt',
  'source',
  'workerRequests',
  'd1RowsRead',
  'd1RowsWritten',
  'queueOperations',
] as const

export function capacityLevel(ratio: number): CapacityLevel {
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new Error('ATTRIBUTION_CAPACITY_RATIO_INVALID')
  }
  if (ratio >= 0.95) return 'critical'
  if (ratio >= 0.85) return 'high'
  if (ratio >= 0.7) return 'warning'
  return 'ok'
}

export function assessCapacity(
  input: ActualCapacityUsage,
): CapacityAssessment {
  assertActualUsage(input)
  const metrics = Object.fromEntries(
    (Object.keys(CLOUDFLARE_FREE_DAILY_LIMITS) as CapacityResource[])
      .map(resource => [
        resource,
        capacityMetric(
          input[resource],
          CLOUDFLARE_FREE_DAILY_LIMITS[resource],
        ),
      ]),
  ) as Record<CapacityResource, CapacityMetric>
  const level = Object.values(metrics).reduce<CapacityLevel>(
    (highest, metric) =>
      LEVEL_ORDER[metric.level] > LEVEL_ORDER[highest]
        ? metric.level
        : highest,
    'ok',
  )
  return {
    usage: { ...input },
    metrics,
    level,
    allowNonEssential: LEVEL_ORDER[level] < LEVEL_ORDER.high,
    allowServerEnqueue: LEVEL_ORDER[level] < LEVEL_ORDER.critical,
  }
}

export async function recordCapacityUsage(
  db: D1Database,
  input: ActualCapacityUsage,
): Promise<CapacityAssessment> {
  const assessment = assessCapacity(input)
  await db.prepare(`
    INSERT INTO attribution_capacity_daily (
      date,
      worker_requests,
      d1_rows_read,
      d1_rows_written,
      queue_operations,
      measured_at,
      source,
      overall_level,
      allow_nonessential,
      allow_server_enqueue
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      worker_requests = excluded.worker_requests,
      d1_rows_read = excluded.d1_rows_read,
      d1_rows_written = excluded.d1_rows_written,
      queue_operations = excluded.queue_operations,
      measured_at = excluded.measured_at,
      source = excluded.source,
      overall_level = excluded.overall_level,
      allow_nonessential = excluded.allow_nonessential,
      allow_server_enqueue = excluded.allow_server_enqueue
  `).bind(
    input.date,
    input.workerRequests,
    input.d1RowsRead,
    input.d1RowsWritten,
    input.queueOperations,
    input.measuredAt,
    input.source,
    assessment.level,
    assessment.allowNonEssential ? 1 : 0,
    assessment.allowServerEnqueue ? 1 : 0,
  ).run()
  await synchronizeCapacityIncidents(db, assessment)
  return assessment
}

export async function readCapacityGate(
  db: D1Database,
  date: string,
): Promise<CapacityGate> {
  if (!isDate(date)) throw new Error('ATTRIBUTION_CAPACITY_DATE_INVALID')
  const row = await db.prepare(`
    SELECT
      overall_level,
      allow_nonessential,
      allow_server_enqueue
    FROM attribution_capacity_daily
    WHERE date = ?
    LIMIT 1
  `).bind(date).first<{
    overall_level: string
    allow_nonessential: number
    allow_server_enqueue: number
  }>()
  if (!row) {
    return {
      observed: false,
      level: 'unavailable',
      allowNonEssential: false,
      allowServerEnqueue: true,
    }
  }
  if (
    !isCapacityLevel(row.overall_level)
    || !isBooleanInteger(row.allow_nonessential)
    || !isBooleanInteger(row.allow_server_enqueue)
  ) {
    throw new Error('ATTRIBUTION_CAPACITY_STATE_INVALID')
  }
  return {
    observed: true,
    level: row.overall_level,
    allowNonEssential: row.allow_nonessential === 1,
    allowServerEnqueue: row.allow_server_enqueue === 1,
  }
}

function capacityMetric(used: number, limit: number): CapacityMetric {
  const ratio = used / limit
  return {
    used,
    limit,
    ratio,
    level: capacityLevel(ratio),
  }
}

async function synchronizeCapacityIncidents(
  db: D1Database,
  assessment: CapacityAssessment,
): Promise<void> {
  const detectedAt = assessment.usage.measuredAt
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE attribution_incidents
      SET status = 'resolved',
          resolved_at = ?,
          resolution = 'capacity_recovered'
      WHERE provider = 'cloudflare'
        AND status = 'open'
        AND code LIKE 'capacity_%'
    `).bind(detectedAt),
  ]
  for (const [resource, metric] of Object.entries(assessment.metrics) as [
    CapacityResource,
    CapacityMetric,
  ][]) {
    if (metric.level === 'ok') continue
    statements.push(db.prepare(`
      INSERT INTO attribution_incidents (
        id,
        provider,
        connection_id,
        severity,
        status,
        code,
        affected_transport,
        detected_at
      ) VALUES (?, 'cloudflare', NULL, ?, 'open', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        severity = excluded.severity,
        status = 'open',
        code = excluded.code,
        affected_transport = excluded.affected_transport,
        detected_at = excluded.detected_at,
        resolved_at = NULL,
        resolution = ''
    `).bind(
      `capacity:${assessment.usage.date}:${resource}`,
      metric.level === 'critical' ? 'critical' : 'warning',
      `capacity_${resource}_${metric.level}`,
      resource === 'queueOperations' ? 'server' : 'all',
      detectedAt,
    ))
  }
  await db.batch(statements)
}

function assertActualUsage(
  value: ActualCapacityUsage,
): asserts value is ActualCapacityUsage {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, USAGE_KEYS)
    || value.schemaVersion !== 1
    || value.source !== 'cloudflare-account-analytics'
    || !isDate(value.date)
    || !isTimestamp(value.measuredAt)
    || !isNonNegativeInteger(value.workerRequests)
    || !isNonNegativeInteger(value.d1RowsRead)
    || !isNonNegativeInteger(value.d1RowsWritten)
    || !isNonNegativeInteger(value.queueOperations)
  ) {
    throw new Error('ATTRIBUTION_CAPACITY_USAGE_INVALID')
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function isDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isCapacityLevel(value: unknown): value is CapacityLevel {
  return value === 'ok'
    || value === 'warning'
    || value === 'high'
    || value === 'critical'
}

function isBooleanInteger(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1
}
