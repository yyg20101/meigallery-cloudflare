import type { D1Usage } from '../utils/analytics-cost'
import { readD1UsageMeta } from '../utils/analytics-cost'

type AnalyticsConversionDb = Pick<D1Database, 'prepare'>

export interface AnalyticsConversionMetric {
  date: string
  source_channel: string
  source_name: string
  route_name: string
  path: string
  session_id: string
  invite_code_id: string
  contact_click_count: number
  register_count: number
}

export interface AnalyticsConversionCounts {
  contact_click_count: number
  register_count: number
}

export interface AnalyticsConversionIndex {
  total: AnalyticsConversionCounts
  byDate: Map<string, AnalyticsConversionCounts>
  byDateSource: Map<string, AnalyticsConversionCounts>
  bySource: Map<string, AnalyticsConversionCounts>
  byPage: Map<string, AnalyticsConversionCounts>
  bySourcePage: Map<string, AnalyticsConversionCounts>
  bySession: Map<string, AnalyticsConversionCounts>
}

export async function readAnalyticsConversionMetrics(
  db: AnalyticsConversionDb,
  range: { from: string; to: string },
): Promise<{ rows: AnalyticsConversionMetric[]; usage: D1Usage }> {
  const result = await db.prepare(`
    WITH normalized AS (
      SELECT
        canonical_event,
        date(datetime(occurred_at, '+8 hours')) AS date,
        CASE
          WHEN json_valid(analytics_dimensions_json) THEN analytics_dimensions_json
          ELSE '{}'
        END AS dimensions
      FROM attribution_conversion_facts
      WHERE occurred_at >= ? AND occurred_at < ?
        AND canonical_event IN ('Contact', 'CompleteRegistration')
    )
    SELECT
      date,
      COALESCE(NULLIF(TRIM(json_extract(dimensions, '$.sourceChannel')), ''), 'unknown') AS source_channel,
      COALESCE(
        NULLIF(TRIM(json_extract(dimensions, '$.trackingSourceSlug')), ''),
        NULLIF(TRIM(json_extract(dimensions, '$.sourceName')), ''),
        ''
      ) AS source_name,
      COALESCE(NULLIF(TRIM(json_extract(dimensions, '$.routeName')), ''), '') AS route_name,
      COALESCE(NULLIF(TRIM(json_extract(dimensions, '$.path')), ''), '') AS path,
      COALESCE(NULLIF(TRIM(json_extract(dimensions, '$.sessionId')), ''), '') AS session_id,
      COALESCE(
        NULLIF(TRIM(json_extract(dimensions, '$.inviteCodeId')), ''),
        NULLIF(TRIM(json_extract(dimensions, '$.metadata.invite_code_id')), ''),
        ''
      ) AS invite_code_id,
      SUM(CASE WHEN canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_click_count,
      SUM(CASE WHEN canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS register_count
    FROM normalized
    GROUP BY date, source_channel, source_name, route_name, path, session_id, invite_code_id
    ORDER BY date ASC
  `).bind(operationDayStart(range.from), operationDayEnd(range.to)).all<{
    date: string
    source_channel: string
    source_name: string
    route_name: string
    path: string
    session_id: string
    invite_code_id: string
    contact_click_count: number | string
    register_count: number | string
  }>()

  return {
    rows: (result.results ?? []).map(row => ({
      date: row.date,
      source_channel: row.source_channel,
      source_name: row.source_name,
      route_name: row.route_name,
      path: row.path,
      session_id: row.session_id,
      invite_code_id: row.invite_code_id,
      contact_click_count: Number(row.contact_click_count ?? 0),
      register_count: Number(row.register_count ?? 0),
    })),
    usage: readD1UsageMeta(result),
  }
}

export async function readAnalyticsSessionConversionCounts(
  db: AnalyticsConversionDb,
  sessionId: string,
): Promise<{ counts: AnalyticsConversionCounts; usage: D1Usage }> {
  const result = await db.prepare(`
    SELECT
      SUM(CASE WHEN canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_click_count,
      SUM(CASE WHEN canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS register_count
    FROM attribution_conversion_facts
    WHERE json_valid(analytics_dimensions_json)
      AND json_extract(analytics_dimensions_json, '$.sessionId') = ?
      AND canonical_event IN ('Contact', 'CompleteRegistration')
  `).bind(sessionId).first<{
    contact_click_count: number | string | null
    register_count: number | string | null
  }>()

  return {
    counts: {
      contact_click_count: Number(result?.contact_click_count ?? 0),
      register_count: Number(result?.register_count ?? 0),
    },
    usage: readD1UsageMeta(result),
  }
}

export function buildAnalyticsConversionIndex(
  rows: AnalyticsConversionMetric[],
): AnalyticsConversionIndex {
  const total = emptyCounts()
  const byDate = new Map<string, AnalyticsConversionCounts>()
  const byDateSource = new Map<string, AnalyticsConversionCounts>()
  const bySource = new Map<string, AnalyticsConversionCounts>()
  const byPage = new Map<string, AnalyticsConversionCounts>()
  const bySourcePage = new Map<string, AnalyticsConversionCounts>()
  const bySession = new Map<string, AnalyticsConversionCounts>()

  for (const row of rows) {
    addCounts(total, row)
    addToIndex(byDate, row.date, row)
    addToIndex(
      byDateSource,
      dateSourceMetricKey(row.date, row.source_channel, row.source_name, row.invite_code_id),
      row,
    )
    addToIndex(bySource, sourceMetricKey(row.source_channel, row.source_name, row.invite_code_id), row)
    addToIndex(byPage, pageMetricKey(row.route_name, row.path), row)
    addToIndex(
      bySourcePage,
      sourcePageMetricKey(
        row.source_channel,
        row.source_name,
        row.invite_code_id,
        row.route_name,
        row.path,
      ),
      row,
    )
    if (row.session_id) addToIndex(bySession, row.session_id, row)
  }

  return { total, byDate, byDateSource, bySource, byPage, bySourcePage, bySession }
}

export function filterAnalyticsConversionMetrics(
  rows: AnalyticsConversionMetric[],
  filters: {
    sourceChannel?: string
    sourceName?: string
    inviteCodeId?: string
    path?: string
  },
) {
  return rows.filter(row => (
    (!filters.sourceChannel || row.source_channel === filters.sourceChannel)
    && (!filters.sourceName || row.source_name === filters.sourceName)
    && (!filters.inviteCodeId || row.invite_code_id === filters.inviteCodeId)
    && (!filters.path || row.path === filters.path)
  ))
}

export function sourceMetricKey(sourceChannel: unknown, sourceName: unknown, inviteCodeId: unknown) {
  return metricKey(sourceChannel, sourceName, inviteCodeId)
}

export function dateSourceMetricKey(
  date: unknown,
  sourceChannel: unknown,
  sourceName: unknown,
  inviteCodeId: unknown,
) {
  return metricKey(date, sourceChannel, sourceName, inviteCodeId)
}

export function pageMetricKey(routeName: unknown, path: unknown) {
  return metricKey(routeName, path)
}

export function sourcePageMetricKey(
  sourceChannel: unknown,
  sourceName: unknown,
  inviteCodeId: unknown,
  routeName: unknown,
  path: unknown,
) {
  return metricKey(sourceChannel, sourceName, inviteCodeId, routeName, path)
}

function operationDayStart(date: string) {
  return new Date(`${date}T00:00:00+08:00`).toISOString()
}

function operationDayEnd(date: string) {
  const end = new Date(`${date}T00:00:00+08:00`)
  end.setUTCDate(end.getUTCDate() + 1)
  return end.toISOString()
}

function addToIndex(
  index: Map<string, AnalyticsConversionCounts>,
  key: string,
  value: AnalyticsConversionCounts,
) {
  const counts = index.get(key) ?? emptyCounts()
  addCounts(counts, value)
  index.set(key, counts)
}

function addCounts(target: AnalyticsConversionCounts, value: AnalyticsConversionCounts) {
  target.contact_click_count += Number(value.contact_click_count ?? 0)
  target.register_count += Number(value.register_count ?? 0)
}

function emptyCounts(): AnalyticsConversionCounts {
  return { contact_click_count: 0, register_count: 0 }
}

function metricKey(...parts: unknown[]) {
  return parts.map(part => String(part ?? '').trim()).join('\u001f')
}
