import type { AdAttributionProvider } from '@meigallery/shared'
import type { D1Usage } from '../utils/analytics-cost'
import { mergeD1Usage, readD1UsageMeta } from '../utils/analytics-cost'
import type { AnalyticsDateRange } from '../utils/analytics-time'
import { estimateAttributionUsage, type AttributionUsageInputs } from './ad-platform/usage-estimator'
import { queryTrackingSourcesWithMetrics } from './tracking-sources'

type Row = Record<string, unknown>
type QueryResult<T extends Row = Row> = { rows: T[]; usage: D1Usage }

export const ATTRIBUTION_BREAKDOWN_DIMENSIONS = [
  'utm_campaign',
  'utm_content',
  'tracking_link',
] as const

export type AttributionBreakdownDimension = typeof ATTRIBUTION_BREAKDOWN_DIMENSIONS[number]
export type AttributionDashboardProvider = AdAttributionProvider

type DeliveryMetrics = {
  browserPlanned: number
  server: {
    planned: number
    queued: number
    accepted: number
    processed: number
    retrying: number
    rejected: number
    deadLetter: number
    cancelled: number
  }
  queueRetryCount: number
  queueEnqueueCount: number
}

type MatchMetric = {
  availability: 'available' | 'unavailable'
  numerator: number
  denominator: number
  rate: number | null
}

const EMPTY_USAGE: D1Usage = { rowsRead: 0, rowsWritten: 0, durationMs: 0 }
const ACTIVE_EVENT_SQL = "('Contact', 'CompleteRegistration')"
const SERVER_STATUS_KEYS = [
  'planned', 'queued', 'accepted', 'processed', 'retrying', 'rejected', 'dead_letter', 'cancelled',
] as const
type ServerStatusKey = typeof SERVER_STATUS_KEYS[number]

export function isAttributionBreakdownDimension(
  value: string | undefined,
): value is AttributionBreakdownDimension {
  return ATTRIBUTION_BREAKDOWN_DIMENSIONS.includes(value as AttributionBreakdownDimension)
}

export function isAttributionDashboardProvider(
  value: string | undefined,
): value is AttributionDashboardProvider {
  return value === 'meta' || value === 'tiktok' || value === 'google'
}

export async function queryAttributionSummary(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
) {
  const [business, routing, delivery] = await Promise.all([
    queryFirst(db, `
      SELECT
        SUM(CASE WHEN canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_count,
        SUM(CASE WHEN canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS complete_registration_count,
        COUNT(*) AS fact_count
      FROM attribution_conversion_facts
      WHERE ${businessDateSql('occurred_at')} BETWEEN ? AND ?
        AND canonical_event IN ${ACTIVE_EVENT_SQL}
        AND attribution_provider = ?
    `, [range.from, range.to, provider]),
    queryFirst(db, `
      SELECT
        COUNT(*) AS total_fact_count,
        SUM(CASE WHEN attribution_provider IN ('meta', 'tiktok', 'google') THEN 1 ELSE 0 END) AS attributed_fact_count,
        SUM(CASE WHEN attribution_source = 'none' THEN 1 ELSE 0 END) AS unattributed_fact_count,
        SUM(CASE WHEN attribution_source = 'conflict' THEN 1 ELSE 0 END) AS conflict_fact_count,
        SUM(CASE WHEN attribution_provider = 'meta' THEN 1 ELSE 0 END) AS meta_count,
        SUM(CASE WHEN attribution_provider = 'tiktok' THEN 1 ELSE 0 END) AS tiktok_count,
        SUM(CASE WHEN attribution_provider = 'google' THEN 1 ELSE 0 END) AS google_count
      FROM attribution_conversion_facts
      WHERE ${businessDateSql('occurred_at')} BETWEEN ? AND ?
        AND canonical_event IN ${ACTIVE_EVENT_SQL}
    `, [range.from, range.to]),
    queryFirst(db, deliveryAggregateSql(), [range.from, range.to, provider]),
  ])

  return {
    usage: mergeUsage(business, routing, delivery),
    data: {
      provider,
      business: serializeBusiness(business.rows[0] ?? {}),
      routing: serializeRouting(routing.rows[0] ?? {}),
      delivery: serializeDelivery(delivery.rows[0] ?? {}),
    },
  }
}

export async function queryAttributionConversions(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
  sourceFilter = '',
) {
  const factWhere = sourceFilter
    ? `${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
      AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
      AND fact.attribution_provider = ?
      AND (
        json_extract(fact.analytics_dimensions_json, '$.sourceName') = ?
        OR json_extract(fact.analytics_dimensions_json, '$.trackingSourceSlug') = ?
      )`
    : `${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
      AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
      AND fact.attribution_provider = ?`
  const factParams = sourceFilter
    ? [range.from, range.to, provider, sourceFilter, sourceFilter]
    : [range.from, range.to, provider]

  const [byEvent, bySource, samples] = await Promise.all([
    queryAll(db, `
      SELECT
        fact.canonical_event,
        COUNT(*) AS fact_count,
        COUNT(DISTINCT json_extract(fact.analytics_dimensions_json, '$.sessionId')) AS unique_session_count
      FROM attribution_conversion_facts AS fact
      WHERE ${factWhere}
      GROUP BY fact.canonical_event
      ORDER BY fact_count DESC, fact.canonical_event ASC
    `, factParams),
    queryAll(db, `
      SELECT
        COALESCE(NULLIF(json_extract(fact.analytics_dimensions_json, '$.sourceChannel'), ''), 'unknown') AS source_channel,
        COALESCE(NULLIF(json_extract(fact.analytics_dimensions_json, '$.sourceName'), ''), '未标记') AS source_name,
        COALESCE(NULLIF(json_extract(fact.analytics_dimensions_json, '$.utmCampaign'), ''), '未标记') AS utm_campaign,
        COALESCE(NULLIF(json_extract(fact.analytics_dimensions_json, '$.utmContent'), ''), '未标记') AS utm_content,
        SUM(CASE WHEN fact.canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_count,
        SUM(CASE WHEN fact.canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS complete_registration_count,
        COUNT(*) AS fact_count
      FROM attribution_conversion_facts AS fact
      WHERE ${factWhere}
      GROUP BY source_channel, source_name, utm_campaign, utm_content
      ORDER BY contact_count DESC, complete_registration_count DESC
      LIMIT 50
    `, factParams),
    queryAll(db, `
      SELECT
        fact.id,
        fact.canonical_event,
        fact.external_event_id,
        fact.occurred_at,
        fact.attribution_provider,
        fact.attribution_source,
        json_extract(fact.analytics_dimensions_json, '$.sourceChannel') AS source_channel,
        json_extract(fact.analytics_dimensions_json, '$.sourceName') AS source_name,
        json_extract(fact.analytics_dimensions_json, '$.trackingSourceSlug') AS tracking_source_slug,
        json_extract(fact.analytics_dimensions_json, '$.utmCampaign') AS utm_campaign,
        json_extract(fact.analytics_dimensions_json, '$.utmContent') AS utm_content,
        json_extract(fact.analytics_dimensions_json, '$.methodType') AS method_type,
        json_extract(fact.analytics_dimensions_json, '$.actionTarget') AS action_target,
        json_extract(fact.analytics_dimensions_json, '$.path') AS path,
        MAX(CASE WHEN delivery.transport = 'browser' THEN 1 ELSE 0 END) AS browser_planned,
        MAX(CASE WHEN delivery.transport = 'server' THEN delivery.status ELSE '' END) AS server_status,
        SUM(CASE WHEN delivery.transport = 'server' THEN MAX(delivery.attempt_count - 1, 0) ELSE 0 END) AS retry_count
      FROM attribution_conversion_facts AS fact
      LEFT JOIN attribution_deliveries AS delivery ON delivery.fact_id = fact.id AND delivery.provider = ?
      WHERE ${factWhere}
      GROUP BY fact.id
      ORDER BY fact.occurred_at DESC
      LIMIT 100
    `, [provider, ...factParams]),
  ])

  return {
    usage: mergeUsage(byEvent, bySource, samples),
    data: {
      provider,
      byEvent: byEvent.rows,
      bySource: bySource.rows,
      samples: samples.rows,
    },
  }
}

export async function queryAttributionLinks(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
) {
  const [trackingSources, conversions] = await Promise.all([
    queryTrackingSourcesWithMetrics(db, range),
    queryAll(db, `
      SELECT
        NULLIF(json_extract(analytics_dimensions_json, '$.trackingSourceSlug'), '') AS source_code,
        SUM(CASE WHEN canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_count,
        SUM(CASE WHEN canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS complete_registration_count
      FROM attribution_conversion_facts
      WHERE ${businessDateSql('occurred_at')} BETWEEN ? AND ?
        AND canonical_event IN ${ACTIVE_EVENT_SQL}
        AND attribution_provider = ?
      GROUP BY source_code
    `, [range.from, range.to, provider]),
  ])
  const conversionsBySource = new Map(conversions.rows.map(row => [
    String(row.source_code || ''),
    {
      contactCount: count(row.contact_count),
      completeRegistrationCount: count(row.complete_registration_count),
    },
  ]))

  return {
    usage: mergeD1Usage(trackingSources.usage, conversions.usage),
    data: {
      provider,
      links: trackingSources.items
        .filter(item => item.channel === 'ad' && item.adProvider === provider)
        .map(item => ({
          ...item,
          contactCount: conversionsBySource.get(item.slug)?.contactCount ?? 0,
          completeRegistrationCount: conversionsBySource.get(item.slug)?.completeRegistrationCount ?? 0,
        })),
    },
  }
}

export async function queryAttributionTrends(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
) {
  const [business, delivery] = await Promise.all([
    queryAll(db, `
      SELECT
        ${businessDateSql('occurred_at')} AS date,
        SUM(CASE WHEN canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_count,
        SUM(CASE WHEN canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS complete_registration_count,
        COUNT(*) AS fact_count
      FROM attribution_conversion_facts
      WHERE ${businessDateSql('occurred_at')} BETWEEN ? AND ?
        AND canonical_event IN ${ACTIVE_EVENT_SQL}
        AND attribution_provider = ?
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to, provider]),
    queryAll(db, `${deliveryAggregateSql()}
      GROUP BY ${businessDateSql('fact.occurred_at')}
      ORDER BY date ASC
    `, [range.from, range.to, provider]),
  ])
  const businessByDate = rowsByDate(business.rows)
  const deliveryByDate = rowsByDate(delivery.rows)

  return {
    usage: mergeUsage(business, delivery),
    data: {
      provider,
      granularity: 'day' as const,
      rows: rangeDates(range).map(date => ({
        date,
        business: serializeBusiness(businessByDate.get(date) ?? {}),
        delivery: serializeDelivery(deliveryByDate.get(date) ?? {}),
      })),
    },
  }
}

export async function queryAttributionQuality(
  db: D1Database,
  range: AnalyticsDateRange,
  provider: AttributionDashboardProvider,
) {
  const [pairingRows, matchRows, signalRows, platformQuality] = await Promise.all([
    queryAll(db, pairingSql(), [provider, range.from, range.to, provider, provider]),
    queryAll(db, matchSql(), [range.from, range.to, provider]),
    queryAll(db, matchSignalSql(), [range.from, range.to, provider]),
    queryAll(db, `
      SELECT
        ${businessDateSql('collected_at')} AS date,
        canonical_event,
        metric_key,
        metric_value,
        collection_status,
        error_category,
        collected_at
      FROM attribution_quality_snapshots
      WHERE provider = ?
        AND ${businessDateSql('collected_at')} BETWEEN ? AND ?
        AND canonical_event IN ${ACTIVE_EVENT_SQL}
      ORDER BY collected_at DESC, id DESC
    `, [provider, range.from, range.to]),
  ])
  const pairingByDate = rowsByDate(pairingRows.rows)
  const matchByDate = rowsByDate(matchRows.rows)
  const pairingSeries = rangeDates(range).map(date => ({
    date,
    ...metricFromRow(pairingByDate.get(date) ?? {}, 'numerator', 'denominator'),
  }))
  const matchSeries = rangeDates(range).map(date => ({
    date,
    ...metricFromRow(matchByDate.get(date) ?? {}, 'numerator', 'denominator'),
  }))
  const platformRows = platformQuality.rows.map(serializePlatformQualityRow)

  return {
    usage: mergeUsage(pairingRows, matchRows, signalRows, platformQuality),
    data: {
      provider,
      pairing: {
        summary: summarizeMetric(pairingRows.rows),
        rows: pairingSeries,
      },
      match: {
        summary: summarizeMetric(matchRows.rows),
        signals: signalRows.rows.map(row => ({
          key: String(row.signal_key || ''),
          ...matchMetric(row.numerator, row.denominator),
        })),
        rows: matchSeries,
      },
      platformQuality: {
        availability: platformRows[0]?.availability ?? 'unavailable' as const,
        latest: platformRows[0] ?? null,
        rows: platformRows,
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
    WITH selected_facts AS (
      SELECT
        fact.id,
        fact.canonical_event,
        ${dimensionExpression} AS dimension_value
      FROM attribution_conversion_facts AS fact
      WHERE ${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
        AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
        AND fact.attribution_provider = ?
    ),
    delivery_per_fact AS (
      SELECT
        delivery.fact_id,
        MAX(CASE WHEN delivery.transport = 'browser' THEN 1 ELSE 0 END) AS browser_planned_count,
        SUM(CASE WHEN delivery.transport = 'server' THEN MAX(delivery.attempt_count - 1, 0) ELSE 0 END) AS queue_retry_count,
        ${serverStatusColumns('delivery')}
      FROM attribution_deliveries AS delivery
      JOIN selected_facts AS fact ON fact.id = delivery.fact_id
      WHERE delivery.provider = ?
      GROUP BY delivery.fact_id
    )
    SELECT
      fact.dimension_value,
      COUNT(*) AS fact_count,
      SUM(CASE WHEN fact.canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_count,
      SUM(CASE WHEN fact.canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS complete_registration_count,
      COALESCE(SUM(delivery.browser_planned_count), 0) AS browser_planned_count,
      COALESCE(SUM(delivery.queue_retry_count), 0) AS queue_retry_count,
      ${serverStatusSumColumns('delivery')}
    FROM selected_facts AS fact
    LEFT JOIN delivery_per_fact AS delivery ON delivery.fact_id = fact.id
    GROUP BY fact.dimension_value
    ORDER BY fact_count DESC, fact.dimension_value ASC
    LIMIT ?
  `, [range.from, range.to, provider, provider, limit])

  return {
    usage: result.usage,
    data: {
      provider,
      dimension,
      rows: result.rows.map(row => ({
        value: String(row.dimension_value || '未标记'),
        factCount: count(row.fact_count),
        contactCount: count(row.contact_count),
        completeRegistrationCount: count(row.complete_registration_count),
        delivery: serializeDelivery(row),
      })),
    },
  }
}

export async function queryAttributionCapacity(db: D1Database, date: string) {
  const [facts, deliveries, receipts] = await Promise.all([
    queryFirst(db, `
      SELECT COUNT(*) AS fact_count
      FROM attribution_conversion_facts
      WHERE ${businessDateSql('occurred_at')} = ?
        AND canonical_event IN ${ACTIVE_EVENT_SQL}
    `, [date]),
    queryFirst(db, `
      SELECT
        COUNT(*) AS delivery_count,
        SUM(CASE WHEN transport = 'browser' THEN 1 ELSE 0 END) AS browser_delivery_count,
        SUM(CASE WHEN transport = 'server' THEN 1 ELSE 0 END) AS server_delivery_count,
        SUM(CASE WHEN transport = 'server' THEN attempt_count ELSE 0 END) AS adapter_attempt_count,
        SUM(CASE WHEN transport = 'server' THEN queue_attempt_count ELSE 0 END) AS queue_attempt_count,
        SUM(CASE WHEN transport = 'server' AND status IN ('accepted', 'processed', 'rejected', 'dead_letter', 'cancelled') THEN 1 ELSE 0 END) AS terminal_server_delivery_count
      FROM attribution_deliveries
      WHERE ${businessDateSql('created_at')} = ?
    `, [date]),
    queryFirst(db, `
      SELECT
        COUNT(*) AS provider_receipt_count
      FROM attribution_provider_receipts
      WHERE ${businessDateSql('received_at')} = ?
    `, [date]),
  ])
  const factRow = facts.rows[0] ?? {}
  const deliveryRow = deliveries.rows[0] ?? {}
  const receiptRow = receipts.rows[0] ?? {}
  const inputs: AttributionUsageInputs = {
    factCount: count(factRow.fact_count),
    deliveryCount: count(deliveryRow.delivery_count),
    browserDeliveryCount: count(deliveryRow.browser_delivery_count),
    serverDeliveryCount: count(deliveryRow.server_delivery_count),
    adapterAttemptCount: count(deliveryRow.adapter_attempt_count),
    queueAttemptCount: count(deliveryRow.queue_attempt_count),
    terminalServerDeliveryCount: count(deliveryRow.terminal_server_delivery_count),
    providerReceiptCount: count(receiptRow.provider_receipt_count),
    workflowStepCount: 0,
  }
  const estimate = estimateAttributionUsage(inputs)

  return {
    usage: mergeUsage(facts, deliveries, receipts),
    data: {
      date,
      timeZone: 'Asia/Shanghai' as const,
      inputs,
      ...estimate,
    },
  }
}

function deliveryAggregateSql() {
  return `
    SELECT
      ${businessDateSql('fact.occurred_at')} AS date,
      COUNT(DISTINCT CASE WHEN delivery.transport = 'browser' THEN delivery.id END) AS browser_planned_count,
      SUM(CASE WHEN delivery.transport = 'server' THEN MAX(delivery.attempt_count - 1, 0) ELSE 0 END) AS queue_retry_count,
      SUM(CASE WHEN delivery.transport = 'server' THEN delivery.queue_attempt_count ELSE 0 END) AS queue_enqueue_count,
      ${serverStatusColumns('delivery')}
    FROM attribution_deliveries AS delivery
    JOIN attribution_conversion_facts AS fact ON fact.id = delivery.fact_id
    WHERE ${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
      AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
      AND delivery.provider = ?`
}

function pairingSql() {
  return `
    SELECT
      ${businessDateSql('fact.occurred_at')} AS date,
      SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM attribution_deliveries AS browser_delivery
        WHERE browser_delivery.fact_id = fact.id
          AND browser_delivery.provider = ?
          AND browser_delivery.transport = 'browser'
      ) THEN 1 ELSE 0 END) AS numerator,
      COUNT(*) AS denominator
    FROM attribution_conversion_facts AS fact
    WHERE ${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
      AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
      AND fact.attribution_provider = ?
      AND EXISTS (
        SELECT 1 FROM attribution_deliveries AS server_delivery
        WHERE server_delivery.fact_id = fact.id
          AND server_delivery.provider = ?
          AND server_delivery.transport = 'server'
      )
    GROUP BY date
    ORDER BY date ASC
  `
}

function matchSql() {
  return `
    SELECT
      ${businessDateSql('fact.occurred_at')} AS date,
      SUM(CASE WHEN json_array_length(delivery.match_signals_json) > 0 THEN 1 ELSE 0 END) AS numerator,
      COUNT(*) AS denominator
    FROM attribution_deliveries AS delivery
    JOIN attribution_conversion_facts AS fact ON fact.id = delivery.fact_id
    WHERE ${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
      AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
      AND delivery.provider = ?
      AND delivery.transport = 'server'
    GROUP BY date
    ORDER BY date ASC
  `
}

function matchSignalSql() {
  return `
    WITH server_deliveries AS (
      SELECT delivery.id, delivery.match_signals_json
      FROM attribution_deliveries AS delivery
      JOIN attribution_conversion_facts AS fact ON fact.id = delivery.fact_id
      WHERE ${businessDateSql('fact.occurred_at')} BETWEEN ? AND ?
        AND fact.canonical_event IN ${ACTIVE_EVENT_SQL}
        AND delivery.provider = ?
        AND delivery.transport = 'server'
    ), totals AS (
      SELECT COUNT(*) AS denominator FROM server_deliveries
    )
    SELECT signal.value AS signal_key, COUNT(DISTINCT delivery.id) AS numerator, totals.denominator
    FROM server_deliveries AS delivery
    JOIN json_each(delivery.match_signals_json) AS signal
    CROSS JOIN totals
    GROUP BY signal.value, totals.denominator
    ORDER BY signal.value ASC
  `
}

function serverStatusColumns(alias: string) {
  return SERVER_STATUS_KEYS.map(status => (
    `SUM(CASE WHEN ${alias}.transport = 'server' AND ${alias}.status = '${status}' THEN 1 ELSE 0 END) AS server_${status}_count`
  )).join(',\n      ')
}

function serverStatusSumColumns(alias: string) {
  return SERVER_STATUS_KEYS.map(status => (
    `COALESCE(SUM(${alias}.server_${status}_count), 0) AS server_${status}_count`
  )).join(',\n      ')
}

function breakdownDimensionExpression(dimension: AttributionBreakdownDimension) {
  const paths: Record<AttributionBreakdownDimension, string> = {
    utm_campaign: '$.utmCampaign',
    utm_content: '$.utmContent',
    tracking_link: '$.trackingSourceSlug',
  }
  return `COALESCE(NULLIF(trim(json_extract(fact.analytics_dimensions_json, '${paths[dimension]}')), ''), '未标记')`
}

function businessDateSql(column: string) {
  return `date(datetime(${column}, '+8 hours'))`
}

function serializeBusiness(row: Row) {
  return {
    contactCount: count(row.contact_count),
    completeRegistrationCount: count(row.complete_registration_count),
    factCount: count(row.fact_count),
  }
}

function serializeRouting(row: Row) {
  return {
    totalFactCount: count(row.total_fact_count),
    attributedFactCount: count(row.attributed_fact_count),
    unattributedFactCount: count(row.unattributed_fact_count),
    conflictFactCount: count(row.conflict_fact_count),
    byProvider: {
      meta: count(row.meta_count),
      tiktok: count(row.tiktok_count),
      google: count(row.google_count),
    },
  }
}

function serializeDelivery(row: Row): DeliveryMetrics {
  const server = Object.fromEntries(SERVER_STATUS_KEYS.map(status => [
    toCamelStatus(status),
    count(row[`server_${status}_count`]),
  ])) as DeliveryMetrics['server']
  return {
    browserPlanned: count(row.browser_planned_count),
    server,
    queueRetryCount: count(row.queue_retry_count),
    queueEnqueueCount: count(row.queue_enqueue_count),
  }
}

function toCamelStatus(status: ServerStatusKey) {
  return status === 'dead_letter' ? 'deadLetter' : status
}

function summarizeMetric(rows: Row[]) {
  const total = rows.reduce<{ numerator: number; denominator: number }>((summary, row) => ({
    numerator: summary.numerator + count(row.numerator),
    denominator: summary.denominator + count(row.denominator),
  }), { numerator: 0, denominator: 0 })
  return matchMetric(total.numerator, total.denominator)
}

function metricFromRow(row: Row, numeratorKey: string, denominatorKey: string) {
  return matchMetric(row[numeratorKey], row[denominatorKey])
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

function serializePlatformQualityRow(row: Row) {
  const value = row.metric_value == null ? null : Number(row.metric_value)
  const normalizedValue = Number.isFinite(value) ? value : null
  const status = String(row.collection_status || '')
  const availability = status === 'error'
    ? 'error' as const
    : status === 'success' && normalizedValue !== null
      ? 'available' as const
      : 'unavailable' as const
  return {
    date: String(row.date || ''),
    canonicalEvent: String(row.canonical_event || ''),
    metricKey: String(row.metric_key || ''),
    value: normalizedValue,
    availability,
    status,
    errorCategory: String(row.error_category || ''),
    collectedAt: String(row.collected_at || ''),
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
