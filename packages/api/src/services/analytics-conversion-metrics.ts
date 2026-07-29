import type { D1Usage } from '../utils/analytics-cost'
import { readD1UsageMeta } from '../utils/analytics-cost'

type AnalyticsConversionDb = Pick<D1Database, 'prepare'>

export interface AnalyticsConversionMetric {
  date: string
  source_channel: string
  source_name: string
  tracking_source_label: string
  source_matched: number
  route_name: string
  path: string
  visitor_id: string
  session_id: string
  user_id: string
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
  byInvite: Map<string, AnalyticsConversionCounts>
}

export interface AnalyticsContactClickRow extends Record<string, unknown> {
  source_channel?: string
  source_name?: string
  tracking_source_label?: string
  source_matched?: number
  invite_code_id?: string
  element_id: 'contact_conversion'
  element_type: 'contact'
  location: 'contact_panel'
  target_type: 'contact'
  target_id: 'all_contact_methods'
  raw_click_count: number
  effective_click_count: number
  duplicate_click_count: 0
  visitor_count: number
  session_count: number
  user_count: number
  exposure_session_count: 0
  is_effective_contact_click: 1
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
    ),
    grouped AS (
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
      COALESCE(NULLIF(TRIM(json_extract(dimensions, '$.visitorId')), ''), '') AS visitor_id,
      COALESCE(NULLIF(TRIM(json_extract(dimensions, '$.sessionId')), ''), '') AS session_id,
      COALESCE(CAST(json_extract(dimensions, '$.userId') AS TEXT), '') AS user_id,
      COALESCE(
        NULLIF(TRIM(json_extract(dimensions, '$.inviteCodeId')), ''),
        NULLIF(TRIM(json_extract(dimensions, '$.metadata.invite_code_id')), ''),
        ''
      ) AS invite_code_id,
      SUM(CASE WHEN canonical_event = 'Contact' THEN 1 ELSE 0 END) AS contact_click_count,
      SUM(CASE WHEN canonical_event = 'CompleteRegistration' THEN 1 ELSE 0 END) AS register_count
    FROM normalized
    GROUP BY
      date, source_channel, source_name, route_name, path,
      visitor_id, session_id, user_id, invite_code_id
    )
    SELECT
      grouped.*,
      COALESCE(source.name, '') AS tracking_source_label,
      CASE WHEN source.id IS NULL THEN 0 ELSE 1 END AS source_matched
    FROM grouped
    LEFT JOIN analytics_tracking_sources source ON source.slug = grouped.source_name
    ORDER BY date ASC
  `).bind(operationDayStart(range.from), operationDayEnd(range.to)).all<{
    date: string
    source_channel: string
    source_name: string
    tracking_source_label?: string
    source_matched?: number | string
    route_name: string
    path: string
    visitor_id: string
    session_id: string
    user_id: string
    invite_code_id: string
    contact_click_count: number | string
    register_count: number | string
  }>()

  return {
    rows: (result.results ?? []).map(row => ({
      date: row.date,
      source_channel: row.source_channel,
      source_name: row.source_name,
      tracking_source_label: row.tracking_source_label ?? '',
      source_matched: Number(row.source_matched ?? 0),
      route_name: row.route_name,
      path: row.path,
      visitor_id: row.visitor_id,
      session_id: row.session_id,
      user_id: row.user_id,
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
  const byInvite = new Map<string, AnalyticsConversionCounts>()

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
    if (row.invite_code_id) addToIndex(byInvite, row.invite_code_id, row)
  }

  return { total, byDate, byDateSource, bySource, byPage, bySourcePage, bySession, byInvite }
}

export function buildAnalyticsContactClickRows(
  rows: AnalyticsConversionMetric[],
  options: { bySource?: boolean } = {},
): AnalyticsContactClickRow[] {
  type ContactGroup = {
    row: AnalyticsContactClickRow
    visitors: Set<string>
    sessions: Set<string>
    users: Set<string>
  }
  const groups = new Map<string, ContactGroup>()

  for (const metric of rows) {
    const count = Number(metric.contact_click_count ?? 0)
    if (count <= 0) continue
    const key = options.bySource
      ? sourceMetricKey(metric.source_channel, metric.source_name, metric.invite_code_id)
      : 'all'
    const group = groups.get(key) ?? {
      row: {
        ...(options.bySource
          ? {
              source_channel: metric.source_channel,
              source_name: metric.source_name,
              tracking_source_label: metric.tracking_source_label,
              source_matched: metric.source_matched,
              invite_code_id: metric.invite_code_id,
            }
          : {}),
        element_id: 'contact_conversion',
        element_type: 'contact',
        location: 'contact_panel',
        target_type: 'contact',
        target_id: 'all_contact_methods',
        raw_click_count: 0,
        effective_click_count: 0,
        duplicate_click_count: 0,
        visitor_count: 0,
        session_count: 0,
        user_count: 0,
        exposure_session_count: 0,
        is_effective_contact_click: 1,
      },
      visitors: new Set<string>(),
      sessions: new Set<string>(),
      users: new Set<string>(),
    }
    group.row.raw_click_count += count
    group.row.effective_click_count += count
    if (metric.visitor_id) group.visitors.add(metric.visitor_id)
    if (metric.session_id) group.sessions.add(metric.session_id)
    if (metric.user_id && metric.user_id !== 'null') group.users.add(metric.user_id)
    groups.set(key, group)
  }

  return [...groups.values()].map((group) => ({
    ...group.row,
    visitor_count: group.visitors.size,
    session_count: group.sessions.size,
    user_count: group.users.size,
  }))
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
