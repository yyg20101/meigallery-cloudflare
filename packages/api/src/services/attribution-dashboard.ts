import type { AdPlatformProvider } from '@meigallery/shared'
import type { D1Usage } from '../utils/analytics-cost'
import { mergeD1Usage, readD1UsageMeta } from '../utils/analytics-cost'
import type { AnalyticsDateRange } from '../utils/analytics-time'

type Row = Record<string, unknown>
type QueryResult<T extends Row = Row> = { rows: T[]; usage: D1Usage }

export const ATTRIBUTION_BREAKDOWN_DIMENSIONS = [
  'utm_campaign',
  'utm_content',
  'tracking_link',
] as const

export type AttributionBreakdownDimension = typeof ATTRIBUTION_BREAKDOWN_DIMENSIONS[number]
export type AttributionDashboardProvider = Extract<AdPlatformProvider, 'meta' | 'tiktok'>

type DeliveryMetrics = {
  pixelAttempted: number
  serverSent: number
  failed: number
  skipped: number
  pending: number
  retryExhausted: number
}

type MatchMetric = {
  availability: 'available' | 'unavailable'
  numerator: number
  denominator: number
  rate: number | null
}

const EMPTY_USAGE: D1Usage = { rowsRead: 0, rowsWritten: 0, durationMs: 0 }
const ACTIVE_ACTION_SQL = "('contact', 'complete_registration')"
const ACTIVE_EVENT_SQL = "('Contact', 'CompleteRegistration')"
const PLANNED_SERVER_STATUS_SQL = "('pending', 'sent', 'failed', 'duplicate_suppressed')"

export function isAttributionBreakdownDimension(
  value: string | undefined,
): value is AttributionBreakdownDimension {
  return ATTRIBUTION_BREAKDOWN_DIMENSIONS.includes(value as AttributionBreakdownDimension)
}

export function isAttributionDashboardProvider(
  value: string | undefined,
): value is AttributionDashboardProvider {
  return value === 'meta' || value === 'tiktok'
}

export async function queryAttributionSummary(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
) {
  const [business, historical, delivery, retryExhausted, routing] = await Promise.all([
    queryFirst(db, `
      SELECT
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN 1 ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN 1 ELSE 0 END), 0) AS complete_registration_count,
        COUNT(*) AS total_action_count
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND action_type IN ${ACTIVE_ACTION_SQL}
        AND duplicate_of = ''
        AND attribution_provider = ?
    `, [range.from, range.to, provider]),
    queryFirst(db, `
      SELECT COALESCE(SUM(action_count), 0) AS historical_lead_count
      FROM analytics_conversion_daily
      WHERE date BETWEEN ? AND ?
        AND action_type = 'lead'
    `, [range.from, range.to]),
    queryFirst(db, deliveryAggregateSql(), [range.from, range.to, provider]),
    queryFirst(db, `
      SELECT COUNT(*) AS retry_exhausted_count
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE a.date BETWEEN ? AND ?
        AND a.action_type IN ${ACTIVE_ACTION_SQL}
        AND d.provider = ?
        AND d.transport = 'server'
        AND d.status = 'failed'
        AND d.error_code = 'retry_exhausted'
    `, [range.from, range.to, provider]),
    queryFirst(db, `
      SELECT
        COUNT(DISTINCT CASE WHEN a.attribution_provider = '' THEN a.id END) AS unrouted_action_count,
        COUNT(DISTINCT CASE
          WHEN a.attribution_provider <> '' AND a.attribution_provider <> d.provider THEN a.id
        END) AS mismatch_count
      FROM analytics_conversion_actions a
      LEFT JOIN analytics_conversion_deliveries d ON d.conversion_action_id = a.id
      WHERE a.date BETWEEN ? AND ?
        AND a.action_type IN ${ACTIVE_ACTION_SQL}
        AND a.duplicate_of = ''
    `, [range.from, range.to]),
  ])

  const businessRow = business.rows[0] ?? {}
  return {
    usage: mergeUsage(business, historical, delivery, retryExhausted, routing),
    data: {
      provider,
      business: serializeBusiness(businessRow),
      historical: { leadCount: count((historical.rows[0] ?? {}).historical_lead_count) },
      delivery: serializeDelivery(delivery.rows[0] ?? {}, retryExhausted.rows[0] ?? {}),
      routing: {
        mismatchCount: count((routing.rows[0] ?? {}).mismatch_count),
        unroutedActionCount: count((routing.rows[0] ?? {}).unrouted_action_count),
      },
    },
  }
}

export async function queryAttributionTrends(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
) {
  const [business, delivery, retryExhausted] = await Promise.all([
    queryAll(db, `
      SELECT
        date,
        COALESCE(SUM(CASE WHEN action_type = 'contact' THEN 1 ELSE 0 END), 0) AS contact_count,
        COALESCE(SUM(CASE WHEN action_type = 'complete_registration' THEN 1 ELSE 0 END), 0) AS complete_registration_count
      FROM analytics_conversion_actions
      WHERE date BETWEEN ? AND ?
        AND action_type IN ${ACTIVE_ACTION_SQL}
        AND duplicate_of = ''
        AND attribution_provider = ?
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to, provider]),
    queryAll(db, `${deliveryAggregateSql()}
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to, provider]),
    queryAll(db, `
      SELECT a.date, COUNT(*) AS retry_exhausted_count
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE a.date BETWEEN ? AND ?
        AND a.action_type IN ${ACTIVE_ACTION_SQL}
        AND d.provider = ?
        AND d.transport = 'server'
        AND d.status = 'failed'
        AND d.error_code = 'retry_exhausted'
      GROUP BY a.date
      ORDER BY a.date ASC
    `, [range.from, range.to, provider]),
  ])
  const businessByDate = rowsByDate(business.rows)
  const deliveryByDate = rowsByDate(delivery.rows)
  const retryByDate = rowsByDate(retryExhausted.rows)

  return {
    usage: mergeUsage(business, delivery, retryExhausted),
    data: {
      provider,
      granularity: 'day' as const,
      rows: rangeDates(range).map((date) => {
        const businessRow = businessByDate.get(date) ?? {}
        const contactCount = count(businessRow.contact_count)
        const completeRegistrationCount = count(businessRow.complete_registration_count)
        return {
          date,
          business: {
            contactCount,
            completeRegistrationCount,
            actionCount: contactCount + completeRegistrationCount,
          },
          delivery: serializeDelivery(
            deliveryByDate.get(date) ?? {},
            retryByDate.get(date) ?? {},
          ),
        }
      }),
    },
  }
}

export async function queryAttributionQuality(
  db: D1Database,
  range: AnalyticsDateRange,
  environment: 'dev' | 'production',
  provider: AttributionDashboardProvider,
) {
  const identifiers = matchIdentifierContract(provider)
  const [match, platformQualitySnapshots] = await Promise.all([
    queryAll(db, `
      SELECT
        a.date,
        COALESCE(SUM(CASE WHEN ${identifiers.browserColumn} = 1 THEN 1 ELSE 0 END), 0) AS browser_id_numerator,
        COUNT(*) AS browser_id_denominator,
        COALESCE(SUM(CASE WHEN ${identifiers.clickColumn} = 1 THEN 1 ELSE 0 END), 0) AS click_id_numerator,
        COUNT(*) AS click_id_denominator,
        COALESCE(SUM(CASE WHEN d.has_email = 1 THEN 1 ELSE 0 END), 0) AS email_numerator,
        COUNT(*) AS email_denominator,
        COALESCE(SUM(CASE WHEN d.has_external_id = 1 THEN 1 ELSE 0 END), 0) AS external_id_numerator,
        COUNT(*) AS external_id_denominator
      FROM analytics_conversion_deliveries d
      JOIN analytics_conversion_actions a ON a.id = d.conversion_action_id
      WHERE a.date BETWEEN ? AND ?
        AND a.action_type IN ${ACTIVE_ACTION_SQL}
        AND a.attribution_provider = ?
        AND d.provider = ?
        AND d.transport = 'server'
        AND d.status IN ${PLANNED_SERVER_STATUS_SQL}
      GROUP BY a.date
      ORDER BY a.date ASC
    `, [range.from, range.to, provider, provider]),
    provider === 'meta' ? queryAll(db, `
      SELECT
        date(datetime(collected_at, '+8 hours')) AS date,
        event_name,
        metric_key,
        metric_value,
        collection_status,
        error_category,
        collected_at,
        window_start,
        window_end,
        contract_version
      FROM meta_dataset_quality_snapshots
      WHERE environment = ?
        AND date(datetime(collected_at, '+8 hours')) BETWEEN ? AND ?
        AND event_name IN ${ACTIVE_EVENT_SQL}
      ORDER BY collected_at DESC, id DESC
    `, [environment, range.from, range.to]) : Promise.resolve({ rows: [], usage: EMPTY_USAGE }),
  ])
  const matchByDate = rowsByDate(match.rows)
  const matchRows = rangeDates(range).map(date => ({
    date,
    ...serializeMatchRow(matchByDate.get(date) ?? {}),
  }))
  const datasetRows = platformQualitySnapshots.rows.map(serializeDatasetQualityRow)
  const latestDatasetRow = datasetRows[0] ?? null

  return {
    usage: mergeUsage(match, platformQualitySnapshots),
    data: {
      provider,
      match: {
        labels: identifiers.labels,
        summary: summarizeMatch(match.rows),
        rows: matchRows,
      },
      platformQuality: {
        source: provider === 'meta' ? 'meta_dataset_quality' as const : 'not_supported' as const,
        availability: latestDatasetRow?.availability ?? 'unavailable' as const,
        latest: latestDatasetRow,
        rows: datasetRows,
      },
    },
  }
}

export async function queryAttributionBreakdown(
  db: D1Database,
  range: AnalyticsDateRange,
  dimension: AttributionBreakdownDimension,
  limit: number,
  provider: AttributionDashboardProvider,
) {
  const dimensionExpression = breakdownDimensionExpression(dimension)
  const result = await queryAll(db, `
    WITH action_facts AS (
      SELECT
        a.id,
        a.action_type,
        ${dimensionExpression} AS dimension_value
      FROM analytics_conversion_actions a
      WHERE a.date BETWEEN ? AND ?
        AND a.action_type IN ${ACTIVE_ACTION_SQL}
        AND a.duplicate_of = ''
        AND a.attribution_provider = ?
    ),
    delivery_per_action AS (
      SELECT
        d.conversion_action_id,
        MAX(CASE WHEN d.transport = 'browser' AND d.status = 'attempted' THEN 1 ELSE 0 END) AS pixel_attempted,
        MAX(CASE WHEN d.transport = 'server' AND d.status = 'sent' THEN 1 ELSE 0 END) AS server_sent,
        MAX(CASE WHEN d.transport = 'server' AND d.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        MAX(CASE WHEN d.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        MAX(CASE WHEN d.status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM analytics_conversion_deliveries d
      JOIN action_facts af ON af.id = d.conversion_action_id
      WHERE d.provider = ?
      GROUP BY d.conversion_action_id
    )
    SELECT
      af.dimension_value,
      COUNT(*) AS action_count,
      SUM(CASE WHEN af.action_type = 'contact' THEN 1 ELSE 0 END) AS contact_count,
      SUM(CASE WHEN af.action_type = 'complete_registration' THEN 1 ELSE 0 END) AS complete_registration_count,
      COALESCE(SUM(dp.pixel_attempted), 0) AS pixel_attempted_count,
      COALESCE(SUM(dp.server_sent), 0) AS server_sent_count,
      COALESCE(SUM(dp.failed), 0) AS failed_count,
      COALESCE(SUM(dp.skipped), 0) AS skipped_count,
      COALESCE(SUM(dp.pending), 0) AS pending_count
    FROM action_facts af
    LEFT JOIN delivery_per_action dp ON dp.conversion_action_id = af.id
    GROUP BY af.dimension_value
    ORDER BY action_count DESC, af.dimension_value ASC
    LIMIT ?
  `, [range.from, range.to, provider, provider, limit])

  return {
    usage: result.usage,
    data: {
      provider,
      dimension,
      rows: result.rows.map(row => ({
        value: String(row.dimension_value || '未标记'),
        actionCount: count(row.action_count),
        contactCount: count(row.contact_count),
        completeRegistrationCount: count(row.complete_registration_count),
        delivery: serializeDelivery(row, {}),
      })),
    },
  }
}

function deliveryAggregateSql() {
  return `
    SELECT
      date,
      COALESCE(SUM(CASE WHEN transport = 'browser' AND status = 'attempted' THEN delivery_count ELSE 0 END), 0) AS pixel_attempted_count,
      COALESCE(SUM(CASE WHEN transport = 'server' AND status = 'sent' THEN delivery_count ELSE 0 END), 0) AS server_sent_count,
      COALESCE(SUM(CASE WHEN transport = 'server' AND status = 'failed' THEN delivery_count ELSE 0 END), 0) AS failed_count,
      COALESCE(SUM(CASE WHEN status = 'skipped' THEN delivery_count ELSE 0 END), 0) AS skipped_count,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN delivery_count ELSE 0 END), 0) AS pending_count
    FROM analytics_conversion_delivery_daily
    WHERE date BETWEEN ? AND ?
      AND provider = ?
      AND event_name IN ${ACTIVE_EVENT_SQL}`
}

function breakdownDimensionExpression(dimension: AttributionBreakdownDimension) {
  const expressions: Record<AttributionBreakdownDimension, string> = {
    utm_campaign: "COALESCE(NULLIF(trim(a.utm_campaign), ''), '未标记')",
    utm_content: "COALESCE(NULLIF(trim(a.utm_content), ''), '未标记')",
    tracking_link: "COALESCE(NULLIF(trim(a.tracking_source_slug), ''), '未标记')",
  }
  return expressions[dimension]
}

function matchIdentifierContract(provider: AttributionDashboardProvider) {
  if (provider === 'tiktok') {
    return {
      browserColumn: 'd.has_ttp',
      clickColumn: 'd.has_ttclid',
      labels: { browserId: '_ttp', clickId: 'ttclid', email: 'email', externalId: 'external_id' },
    }
  }
  return {
    browserColumn: 'd.has_fbp',
    clickColumn: 'd.has_fbc',
    labels: { browserId: 'fbp', clickId: 'fbc', email: 'email', externalId: 'external_id' },
  }
}

function summarizeMatch(rows: Row[]) {
  return serializeMatchRow(rows.reduce<Row>((total, row) => {
    for (const key of [
      'browser_id_numerator', 'browser_id_denominator', 'click_id_numerator', 'click_id_denominator',
      'email_numerator', 'email_denominator', 'external_id_numerator', 'external_id_denominator',
    ]) {
      total[key] = count(total[key]) + count(row[key])
    }
    return total
  }, {}))
}

function serializeMatchRow(row: Row) {
  return {
    browserId: matchMetric(row.browser_id_numerator, row.browser_id_denominator),
    clickId: matchMetric(row.click_id_numerator, row.click_id_denominator),
    email: matchMetric(row.email_numerator, row.email_denominator),
    externalId: matchMetric(row.external_id_numerator, row.external_id_denominator),
  }
}

function matchMetric(numeratorValue: unknown, denominatorValue: unknown): MatchMetric {
  const numerator = count(numeratorValue)
  const denominator = count(denominatorValue)
  return {
    availability: denominator > 0 ? 'available' : 'unavailable',
    numerator,
    denominator,
    rate: denominator > 0 ? roundRate(numerator / denominator) : null,
  }
}

function serializeDatasetQualityRow(row: Row) {
  const availability = datasetSnapshotAvailability(row)
  return {
    date: String(row.date || ''),
    eventName: String(row.event_name || ''),
    metricKey: String(row.metric_key || ''),
    availability,
    value: availability === 'available'
      ? Number(row.metric_value)
      : null,
    status: String(row.collection_status || 'error'),
    errorCategory: String(row.error_category || ''),
    collectedAt: String(row.collected_at || ''),
    windowStart: row.window_start == null ? null : String(row.window_start),
    windowEnd: row.window_end == null ? null : String(row.window_end),
    contractVersion: count(row.contract_version),
  }
}

function datasetSnapshotAvailability(row: Row): 'available' | 'error' | 'unavailable' {
  if (row.collection_status === 'error') return 'error'
  return row.collection_status === 'success'
    && typeof row.metric_value === 'number'
    && Number.isFinite(row.metric_value)
    ? 'available'
    : 'unavailable'
}

function serializeBusiness(row: Row) {
  return {
    contactCount: count(row.contact_count),
    completeRegistrationCount: count(row.complete_registration_count),
    actionCount: count(row.total_action_count),
  }
}

function serializeDelivery(row: Row, retryRow: Row): DeliveryMetrics {
  return {
    pixelAttempted: count(row.pixel_attempted_count),
    serverSent: count(row.server_sent_count),
    failed: count(row.failed_count),
    skipped: count(row.skipped_count),
    pending: count(row.pending_count),
    retryExhausted: count(retryRow.retry_exhausted_count),
  }
}

function rowsByDate(rows: Row[]) {
  return new Map(rows.map(row => [String(row.date || ''), row]))
}

function rangeDates(range: AnalyticsDateRange) {
  const dates: string[] = []
  const cursor = new Date(`${range.from}T00:00:00.000Z`)
  const end = new Date(`${range.to}T00:00:00.000Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function count(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function roundRate(value: number) {
  return Math.round(value * 10_000) / 10_000
}

async function queryAll<T extends Row>(
  db: Pick<D1Database, 'prepare'>,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const result = await db.prepare(sql).bind(...params).all<T>()
  return { rows: result.results ?? [], usage: readD1UsageMeta(result) }
}

async function queryFirst<T extends Row>(
  db: Pick<D1Database, 'prepare'>,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const result = await queryAll<T>(db, sql, params)
  return { rows: result.rows.slice(0, 1), usage: result.usage }
}

function mergeUsage(...results: QueryResult[]) {
  return mergeD1Usage(EMPTY_USAGE, ...results.map(result => result.usage))
}
