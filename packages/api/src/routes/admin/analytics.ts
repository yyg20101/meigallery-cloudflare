import { Hono, type Context } from 'hono'
import type { AnalyticsRangeQuery } from '@meigallery/shared'
import type { Bindings, Variables } from '../../index'
import { createAnalyticsExportJob, readAnalyticsExportJob } from '../../services/analytics-export'
import { listTrackingSourcesWithMetrics } from '../../services/tracking-sources'
import { errorJson } from '../../utils/api-error'
import { readD1UsageMeta, mergeD1Usage, type D1Usage } from '../../utils/analytics-cost'
import { parseAnalyticsRange, type AnalyticsDateRange } from '../../utils/analytics-time'
import { writeAuditLog } from '../../utils/permission'

export const adminAnalyticsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type AdminAnalyticsContext = Context<{ Bindings: Bindings; Variables: Variables }>
type QueryResult<T> = { rows: T[]; usage: D1Usage }

const EMPTY_USAGE: D1Usage = { rowsRead: 0, rowsWritten: 0, durationMs: 0 }
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,120}$/

adminAnalyticsRoutes.get('/overview', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [totals, contactClicks, trend, topSources, topPages, topClicks, health] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(visitor_count), 0) AS visitor_count,
        COALESCE(SUM(session_count), 0) AS session_count,
        COALESCE(SUM(page_view_count), 0) AS page_view_count,
        COALESCE(SUM(gallery_detail_count), 0) AS gallery_detail_count,
        COALESCE(SUM(register_count), 0) AS register_count,
        COALESCE(SUM(invite_register_count), 0) AS invite_register_count,
        COALESCE(SUM(contact_click_count), 0) AS contact_click_count,
        COALESCE(SUM(membership_grant_count), 0) AS membership_grant_count,
        COALESCE(SUM(active_seconds_total), 0) AS active_seconds_total
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(raw_click_count), 0) AS raw_contact_click_count,
        COALESCE(SUM(effective_click_count), 0) AS effective_contact_click_count,
        COALESCE(SUM(duplicate_click_count), 0) AS duplicate_contact_click_count
      FROM analytics_click_daily
      WHERE date BETWEEN ? AND ?
        AND element_id = 'contact_method_click'
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      WITH contact_clicks AS (
        SELECT
          date,
          SUM(raw_click_count) AS raw_contact_click_count,
          SUM(effective_click_count) AS effective_contact_click_count,
          SUM(duplicate_click_count) AS duplicate_contact_click_count
        FROM analytics_click_daily
        WHERE date BETWEEN ? AND ?
          AND element_id = 'contact_method_click'
        GROUP BY date
      )
      SELECT
        ads.date,
        SUM(ads.visitor_count) AS visitor_count,
        SUM(ads.session_count) AS session_count,
        SUM(ads.page_view_count) AS page_view_count,
        SUM(ads.register_count) AS register_count,
        SUM(ads.contact_click_count) AS contact_click_count,
        COALESCE(MAX(contact_clicks.effective_contact_click_count), 0) AS effective_contact_click_count,
        COALESCE(MAX(contact_clicks.raw_contact_click_count), 0) AS raw_contact_click_count,
        COALESCE(MAX(contact_clicks.duplicate_contact_click_count), 0) AS duplicate_contact_click_count,
        SUM(ads.membership_grant_count) AS membership_grant_count
      FROM analytics_daily_sources ads
      LEFT JOIN contact_clicks ON contact_clicks.date = ads.date
      WHERE ads.date BETWEEN ? AND ?
      GROUP BY ads.date
      ORDER BY ads.date ASC
    `, [range.from, range.to, range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT source_channel, source_name, invite_code_id,
             SUM(session_count) AS session_count,
             SUM(register_count) AS register_count,
             SUM(contact_click_count) AS contact_click_count,
             SUM(membership_grant_count) AS membership_grant_count
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
      GROUP BY source_channel, source_name, invite_code_id
      ORDER BY session_count DESC
      LIMIT 5
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT route_name, path, entity_type, entity_id, page_title,
             SUM(page_view_count) AS page_view_count,
             SUM(active_seconds_total) AS active_seconds_total
      FROM analytics_daily_pages
      WHERE date BETWEEN ? AND ?
      GROUP BY route_name, path, entity_type, entity_id, page_title
      ORDER BY page_view_count DESC
      LIMIT 5
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT element_id, element_type, location, target_type, target_id,
             SUM(raw_click_count) AS raw_click_count,
             SUM(effective_click_count) AS effective_click_count
      FROM analytics_click_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY element_id, element_type, location, target_type, target_id
      ORDER BY effective_click_count DESC, raw_click_count DESC
      LIMIT 5
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(accepted_count), 0) AS accepted_count,
        COALESCE(SUM(rejected_count), 0) AS rejected_count,
        COALESCE(SUM(duplicate_count), 0) AS duplicate_count,
        COALESCE(SUM(sensitive_blocked_count), 0) AS sensitive_blocked_count,
        COALESCE(SUM(estimated_rows_read), 0) AS estimated_rows_read,
        COALESCE(SUM(estimated_rows_written), 0) AS estimated_rows_written,
        MAX(last_ingested_at) AS last_ingested_at
      FROM analytics_ingest_health_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
  ])

  const usage = mergeQueryUsage(totals, contactClicks, trend, topSources, topPages, topClicks, health)
  const totalRow = totals.rows[0] ?? {}
  const contactClickRow = contactClicks.rows[0] ?? {}
  const sessionCount = Number((totalRow as Record<string, unknown>).session_count ?? 0)
  const activeSeconds = Number((totalRow as Record<string, unknown>).active_seconds_total ?? 0)

  return c.json({
    range,
    usage,
    data: {
      totals: {
        ...totalRow,
        ...contactClickRow,
        average_active_seconds: sessionCount > 0 ? Math.round(activeSeconds / sessionCount) : 0,
      },
      trend: trend.rows,
      topSources: topSources.rows,
      topPages: topPages.rows,
      topClicks: topClicks.rows,
      health: health.rows[0] ?? null,
    },
  })
})

adminAnalyticsRoutes.get('/sources', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const { where, params } = analyticsWhere(c, range, 'ads')
  const [result, trackingSources] = await Promise.all([
    queryAll(c.env.DB, `
    SELECT source_channel, source_name, invite_code_id,
           SUM(visitor_count) AS visitor_count,
           SUM(session_count) AS session_count,
           SUM(page_view_count) AS page_view_count,
           SUM(gallery_detail_count) AS gallery_detail_count,
           SUM(contact_click_count) AS contact_click_count,
           SUM(register_count) AS register_count,
           SUM(invite_register_count) AS invite_register_count,
           SUM(membership_grant_count) AS membership_grant_count,
           SUM(active_seconds_total) AS active_seconds_total
    FROM analytics_daily_sources ads
    WHERE ${where}
    GROUP BY source_channel, source_name, invite_code_id
    ORDER BY session_count DESC
  `, params),
    listTrackingSourcesWithMetrics(c.env.DB, range),
  ])
  return c.json({ range, usage: result.usage, data: result.rows, trackingSources })
})

adminAnalyticsRoutes.get('/pages', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const result = await queryAll(c.env.DB, `
    SELECT route_name, path, entity_type, entity_id, page_title,
           SUM(page_view_count) AS page_view_count,
           SUM(visitor_count) AS visitor_count,
           SUM(session_count) AS session_count,
           SUM(entry_count) AS entry_count,
           SUM(exit_count) AS exit_count,
           SUM(bounce_count) AS bounce_count,
           SUM(active_seconds_total) AS active_seconds_total,
           MAX(max_scroll_depth) AS max_scroll_depth,
           SUM(register_count) AS register_count,
           SUM(contact_click_count) AS contact_click_count
    FROM analytics_daily_pages
    WHERE date BETWEEN ? AND ?
    GROUP BY route_name, path, entity_type, entity_id, page_title
    ORDER BY page_view_count DESC
  `, [range.from, range.to])
  return c.json({ range, usage: result.usage, data: result.rows })
})

adminAnalyticsRoutes.get('/paths', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const result = await queryAll(c.env.DB, `
    SELECT from_route, to_route, from_path, to_path,
           SUM(transition_count) AS transition_count,
           SUM(visitor_count) AS visitor_count,
           SUM(session_count) AS session_count,
           SUM(conversion_count) AS conversion_count
    FROM analytics_path_edges
    WHERE date BETWEEN ? AND ?
    GROUP BY from_route, to_route, from_path, to_path
    ORDER BY transition_count DESC
  `, [range.from, range.to])
  return c.json({ range, usage: result.usage, data: result.rows })
})

adminAnalyticsRoutes.get('/clicks', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const result = await queryAll(c.env.DB, `
    SELECT element_id, element_type, location, target_type, target_id,
           SUM(raw_click_count) AS raw_click_count,
           SUM(effective_click_count) AS effective_click_count,
           SUM(duplicate_click_count) AS duplicate_click_count,
           SUM(visitor_count) AS visitor_count,
           SUM(session_count) AS session_count,
           SUM(user_count) AS user_count,
           SUM(exposure_session_count) AS exposure_session_count,
           CASE WHEN element_id = 'contact_method_click' THEN 1 ELSE 0 END AS is_effective_contact_click
    FROM analytics_click_daily
    WHERE date BETWEEN ? AND ?
    GROUP BY element_id, element_type, location, target_type, target_id
    ORDER BY effective_click_count DESC, raw_click_count DESC
  `, [range.from, range.to])
  return c.json({ range, usage: result.usage, data: result.rows })
})

adminAnalyticsRoutes.get('/durations', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const result = await queryAll(c.env.DB, `
    SELECT route_name, path, entity_type, entity_id, page_title,
           SUM(page_view_count) AS page_view_count,
           SUM(session_count) AS session_count,
           SUM(active_seconds_total) AS active_seconds_total,
           CASE
             WHEN SUM(page_view_count) > 0 THEN ROUND(SUM(active_seconds_total) * 1.0 / SUM(page_view_count), 2)
             ELSE 0
           END AS average_active_seconds,
           CASE
             WHEN SUM(page_view_count) > 0 THEN ROUND(SUM(bounce_count) * 1.0 / SUM(page_view_count), 4)
             ELSE 0
           END AS bounce_rate,
           MAX(max_scroll_depth) AS max_scroll_depth
    FROM analytics_daily_pages
    WHERE date BETWEEN ? AND ?
    GROUP BY route_name, path, entity_type, entity_id, page_title
    ORDER BY average_active_seconds DESC
  `, [range.from, range.to])
  return c.json({ range, usage: result.usage, data: result.rows })
})

adminAnalyticsRoutes.get('/invites', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const result = await queryAll(c.env.DB, `
    SELECT aid.invite_code_id,
           COALESCE(ic.name, '') AS invite_name,
           aid.channel,
           COALESCE(ic.status, '') AS status,
           SUM(aid.landing_count) AS landing_count,
           SUM(aid.visitor_count) AS visitor_count,
           SUM(aid.session_count) AS session_count,
           SUM(aid.register_count) AS register_count,
           SUM(aid.contact_click_count) AS contact_click_count,
           SUM(aid.membership_grant_count) AS membership_grant_count
    FROM analytics_invite_daily aid
    LEFT JOIN invite_codes ic ON ic.id = aid.invite_code_id
    WHERE aid.date BETWEEN ? AND ?
    GROUP BY aid.invite_code_id, ic.name, aid.channel, ic.status
    ORDER BY register_count DESC
  `, [range.from, range.to])
  return c.json({ range, usage: result.usage, data: result.rows })
})

adminAnalyticsRoutes.get('/health', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [daily, totals] = await Promise.all([
    queryAll(c.env.DB, `
      SELECT date, accepted_count, rejected_count, duplicate_count,
             sensitive_blocked_count, sampled_count, dropped_count,
             estimated_rows_read, estimated_rows_written, max_duration_ms,
             last_ingested_at
      FROM analytics_ingest_health_daily
      WHERE date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(accepted_count), 0) AS accepted_count,
        COALESCE(SUM(rejected_count), 0) AS rejected_count,
        COALESCE(SUM(duplicate_count), 0) AS duplicate_count,
        COALESCE(SUM(sensitive_blocked_count), 0) AS sensitive_blocked_count,
        COALESCE(SUM(sampled_count), 0) AS sampled_count,
        COALESCE(SUM(dropped_count), 0) AS dropped_count,
        COALESCE(SUM(estimated_rows_read), 0) AS estimated_rows_read,
        COALESCE(SUM(estimated_rows_written), 0) AS estimated_rows_written,
        MAX(max_duration_ms) AS max_duration_ms,
        MAX(last_ingested_at) AS last_ingested_at
      FROM analytics_ingest_health_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
  ])

  return c.json({
    range,
    usage: mergeQueryUsage(daily, totals),
    data: {
      totals: totals.rows[0] ?? null,
      daily: daily.rows,
    },
  })
})

adminAnalyticsRoutes.get('/sessions/:id', async (c) => {
  const ownerError = requireOwner(c)
  if (ownerError) return ownerError

  const sessionId = c.req.param('id')
  if (!SESSION_ID_RE.test(sessionId)) {
    return errorJson(c, 400, 'session ID 格式无效', { code: 'ANALYTICS_SESSION_ID_INVALID' })
  }

  const [summary, events] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT session_id, date, started_at, ended_at, source_channel, source_name,
             invite_code_id, device_type, country, entry_path, exit_path,
             page_view_count, active_seconds, click_count, contact_click_count,
             register_success_count, membership_grant_count, is_bounce
      FROM analytics_session_summaries
      WHERE session_id = ?
    `, [sessionId]),
    queryAll(c.env.DB, `
      SELECT id, event_name, occurred_at, route_name, path, page_title,
             entity_type, entity_id, event_props, value, sampled
      FROM analytics_events
      WHERE session_id = ?
      ORDER BY occurred_at ASC
      LIMIT 200
    `, [sessionId]),
  ])

  await writeAuditLog(c.env.DB, {
    adminId: c.get('userId')!,
    action: 'analytics.session.view',
    targetType: 'analytics_session',
    targetId: sessionId,
  })

  return c.json({
    usage: mergeQueryUsage(summary, events),
    data: {
      summary: summary.rows[0] ?? null,
      events: events.rows.map(row => ({
        ...row,
        event_props: safeJsonObject(String((row as Record<string, unknown>).event_props ?? '{}')),
      })),
    },
  })
})

adminAnalyticsRoutes.post('/exports', async (c) => {
  const ownerError = requireOwner(c)
  if (ownerError) return ownerError

  try {
    const body = await c.req.json<{
      kind?: string
      range?: AnalyticsRangeQuery['range']
      from?: string
      to?: string
      filters?: Record<string, unknown>
    }>()
    const job = await createAnalyticsExportJob(c.env, {
      kind: body.kind ?? 'overview',
      rangeQuery: { range: body.range, from: body.from, to: body.to },
      filters: body.filters,
      createdBy: c.get('userId')!,
    })
    await writeAuditLog(c.env.DB, {
      adminId: c.get('userId')!,
      action: 'analytics.export.create',
      targetType: 'analytics_export',
      targetId: job.id,
      afterValue: { kind: job.kind, rangeFrom: job.rangeFrom, rangeTo: job.rangeTo },
    })
    return c.json({ data: job }, 201)
  } catch (error) {
    return errorJson(c, 400, error instanceof Error ? error.message : '导出任务创建失败', {
      code: 'ANALYTICS_EXPORT_INVALID',
    })
  }
})

adminAnalyticsRoutes.get('/exports/:id', async (c) => {
  const ownerError = requireOwner(c)
  if (ownerError) return ownerError

  try {
    return c.json({ data: await readAnalyticsExportJob(c.env.DB, c.req.param('id')) })
  } catch (error) {
    return errorJson(c, 404, error instanceof Error ? error.message : '导出任务不存在', {
      code: 'ANALYTICS_EXPORT_NOT_FOUND',
    })
  }
})

function parseRangeOrError(c: AdminAnalyticsContext): AnalyticsDateRange | Response {
  try {
    return parseAnalyticsRange({
      range: c.req.query('range') as AnalyticsRangeQuery['range'] | undefined,
      from: c.req.query('from'),
      to: c.req.query('to'),
    })
  } catch (error) {
    return errorJson(c, 400, error instanceof Error ? error.message : '分析日期范围无效', {
      code: 'ANALYTICS_RANGE_INVALID',
    })
  }
}

function analyticsWhere(c: AdminAnalyticsContext, range: AnalyticsDateRange, alias: string) {
  const conditions = [`${alias}.date BETWEEN ? AND ?`]
  const params: unknown[] = [range.from, range.to]
  const sourceChannel = c.req.query('sourceChannel')
  const inviteCodeId = c.req.query('inviteCodeId')

  if (sourceChannel && sourceChannel !== 'all') {
    conditions.push(`${alias}.source_channel = ?`)
    params.push(sourceChannel)
  }
  if (inviteCodeId) {
    conditions.push(`${alias}.invite_code_id = ?`)
    params.push(inviteCodeId)
  }

  return { where: conditions.join(' AND '), params }
}

async function queryAll<T extends Record<string, unknown>>(
  db: Pick<D1Database, 'prepare'>,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const result = await db.prepare(sql).bind(...params).all<T>()
  return {
    rows: result.results ?? [],
    usage: readD1UsageMeta(result),
  }
}

async function queryFirst<T extends Record<string, unknown>>(
  db: Pick<D1Database, 'prepare'>,
  sql: string,
  params: unknown[],
): Promise<QueryResult<T>> {
  const result = await db.prepare(sql).bind(...params).first<T>()
  return {
    rows: result ? [result] : [],
    usage: readD1UsageMeta(result),
  }
}

function mergeQueryUsage(...items: Array<QueryResult<Record<string, unknown>>>) {
  return mergeD1Usage(EMPTY_USAGE, ...items.map(item => item.usage))
}

function requireOwner(c: AdminAnalyticsContext): Response | null {
  if (c.get('userRole') === 'owner') return null
  return errorJson(c, 403, '需要站长权限', { code: 'OWNER_REQUIRED' })
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
