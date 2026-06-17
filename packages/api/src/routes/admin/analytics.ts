import { Hono, type Context } from 'hono'
import type { AnalyticsRangeQuery } from '@meigallery/shared'
import type { Bindings, Variables } from '../../index'
import { createAnalyticsExportJob, readAnalyticsExportJob } from '../../services/analytics-export'
import { listTrackingSourcesWithMetrics } from '../../services/tracking-sources'
import { errorJson } from '../../utils/api-error'
import { readD1UsageMeta, mergeD1Usage, type D1Usage } from '../../utils/analytics-cost'
import { enrichAnalyticsDisplayRow } from '../../utils/analytics-display'
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

  const [totals, contactClicks, trend, topSources, topPages, topClicks, clickTotals, health] = await Promise.all([
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
      SELECT ads.source_channel, ads.source_name, ads.invite_code_id,
             COALESCE(ats.name, '') AS tracking_source_label,
             CASE WHEN ats.id IS NULL THEN 0 ELSE 1 END AS source_matched,
             SUM(session_count) AS session_count,
             SUM(register_count) AS register_count,
             SUM(contact_click_count) AS contact_click_count,
             SUM(membership_grant_count) AS membership_grant_count
      FROM analytics_daily_sources ads
      LEFT JOIN analytics_tracking_sources ats ON ats.slug = ads.source_name
      WHERE ads.date BETWEEN ? AND ?
      GROUP BY ads.source_channel, ads.source_name, ads.invite_code_id, ats.name, ats.id
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
      SELECT
             element_id,
             MAX(element_type) AS element_type,
             CASE WHEN element_id = 'contact_method_click' THEN 'contact_panel' ELSE MIN(location) END AS location,
             CASE WHEN element_id = 'contact_method_click' THEN 'contact' ELSE MIN(target_type) END AS target_type,
             CASE WHEN element_id = 'contact_method_click' THEN 'all_contact_methods' ELSE MIN(target_id) END AS target_id,
             SUM(raw_click_count) AS raw_click_count,
             SUM(effective_click_count) AS effective_click_count
      FROM analytics_click_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY
             element_id,
             CASE WHEN element_id = 'contact_method_click' THEN 'contact_panel' ELSE location END,
             CASE WHEN element_id = 'contact_method_click' THEN 'contact' ELSE target_type END,
             CASE WHEN element_id = 'contact_method_click' THEN 'all_contact_methods' ELSE target_id END
      ORDER BY effective_click_count DESC, raw_click_count DESC
      LIMIT 5
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(effective_click_count), 0) AS key_click_count
      FROM analytics_click_daily
      WHERE date BETWEEN ? AND ?
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

  const usage = mergeQueryUsage(totals, contactClicks, trend, topSources, topPages, topClicks, clickTotals, health)
  const totalRow = totals.rows[0] ?? {}
  const contactClickRow = contactClicks.rows[0] ?? {}
  const sessionCount = Number((totalRow as Record<string, unknown>).session_count ?? 0)
  const activeSeconds = Number((totalRow as Record<string, unknown>).active_seconds_total ?? 0)
  const enrichedTotals = {
    ...totalRow,
    ...contactClickRow,
    key_click_count: Number((clickTotals.rows[0] as Record<string, unknown> | undefined)?.key_click_count ?? 0),
    average_active_seconds: sessionCount > 0 ? Math.round(activeSeconds / sessionCount) : 0,
  }
  const aggregateTotal = [
    'session_count',
    'page_view_count',
    'register_count',
    'contact_click_count',
    'membership_grant_count',
    'gallery_detail_count',
  ].reduce((total, key) => total + Number((totalRow as Record<string, unknown>)[key] ?? 0), 0)
  const healthRow = health.rows[0] as Record<string, unknown> | undefined
  const acceptedCount = Number(healthRow?.accepted_count ?? 0)

  return c.json({
    range,
    usage,
    data: {
      totals: enrichedTotals,
      trend: trend.rows,
      topSources: topSources.rows.map(enrichAnalyticsDisplayRow),
      topPages: topPages.rows.map(enrichAnalyticsDisplayRow),
      topClicks: topClicks.rows.map(enrichAnalyticsDisplayRow),
      health: health.rows[0] ?? null,
      funnel: buildFunnel(enrichedTotals),
      diagnostics: {
        aggregateMissing: acceptedCount > 0 && aggregateTotal === 0,
        acceptedCount,
        aggregateTotal,
      },
    },
  })
})

adminAnalyticsRoutes.get('/seo', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const [totals, landingTotals, overallTotals, trend, referrers, landingPages] = await Promise.all([
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(visitor_count), 0) AS visitor_count,
        COALESCE(SUM(session_count), 0) AS session_count,
        COALESCE(SUM(page_view_count), 0) AS page_view_count,
        COALESCE(SUM(gallery_detail_count), 0) AS gallery_detail_count,
        COALESCE(SUM(register_count), 0) AS register_count,
        COALESCE(SUM(contact_click_count), 0) AS contact_click_count,
        COALESCE(SUM(membership_grant_count), 0) AS membership_grant_count,
        COALESCE(SUM(active_seconds_total), 0) AS active_seconds_total
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
        AND source_channel = 'search'
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(entry_count), 0) AS landing_count,
        COALESCE(SUM(bounce_count), 0) AS bounce_count,
        COALESCE(SUM(active_seconds_total), 0) AS landing_active_seconds_total,
        COALESCE(MAX(max_scroll_depth), 0) AS max_scroll_depth
      FROM analytics_source_page_daily
      WHERE date BETWEEN ? AND ?
        AND source_channel = 'search'
    `, [range.from, range.to]),
    queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(session_count), 0) AS total_session_count,
        COALESCE(SUM(page_view_count), 0) AS total_page_view_count
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        date,
        SUM(visitor_count) AS visitor_count,
        SUM(session_count) AS session_count,
        SUM(page_view_count) AS page_view_count,
        SUM(gallery_detail_count) AS gallery_detail_count,
        SUM(register_count) AS register_count,
        SUM(contact_click_count) AS contact_click_count,
        SUM(membership_grant_count) AS membership_grant_count
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
        AND source_channel = 'search'
      GROUP BY date
      ORDER BY date ASC
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        source_channel,
        source_name,
        '' AS invite_code_id,
        SUM(visitor_count) AS visitor_count,
        SUM(session_count) AS session_count,
        SUM(page_view_count) AS page_view_count,
        SUM(gallery_detail_count) AS gallery_detail_count,
        SUM(register_count) AS register_count,
        SUM(contact_click_count) AS contact_click_count,
        SUM(membership_grant_count) AS membership_grant_count,
        SUM(active_seconds_total) AS active_seconds_total,
        CASE
          WHEN SUM(session_count) > 0 THEN ROUND(SUM(active_seconds_total) * 1.0 / SUM(session_count), 2)
          ELSE 0
        END AS average_active_seconds,
        CASE
          WHEN SUM(session_count) > 0 THEN ROUND(SUM(contact_click_count) * 1.0 / SUM(session_count), 4)
          ELSE 0
        END AS contact_rate,
        CASE
          WHEN SUM(session_count) > 0 THEN ROUND(SUM(register_count) * 1.0 / SUM(session_count), 4)
          ELSE 0
        END AS register_rate
      FROM analytics_daily_sources
      WHERE date BETWEEN ? AND ?
        AND source_channel = 'search'
      GROUP BY source_channel, source_name
      ORDER BY session_count DESC, page_view_count DESC
      LIMIT 20
    `, [range.from, range.to]),
    queryAll(c.env.DB, `
      SELECT
        route_name,
        path,
        entity_type,
        entity_id,
        page_title,
        SUM(visitor_count) AS visitor_count,
        SUM(session_count) AS session_count,
        SUM(page_view_count) AS page_view_count,
        SUM(entry_count) AS entry_count,
        SUM(exit_count) AS exit_count,
        SUM(bounce_count) AS bounce_count,
        SUM(active_seconds_total) AS active_seconds_total,
        MAX(max_scroll_depth) AS max_scroll_depth,
        SUM(register_count) AS register_count,
        SUM(contact_click_count) AS contact_click_count,
        CASE
          WHEN SUM(entry_count) > 0 THEN ROUND(SUM(bounce_count) * 1.0 / SUM(entry_count), 4)
          ELSE 0
        END AS bounce_rate,
        CASE
          WHEN SUM(page_view_count) > 0 THEN ROUND(SUM(active_seconds_total) * 1.0 / SUM(page_view_count), 2)
          ELSE 0
        END AS average_active_seconds,
        CASE
          WHEN SUM(session_count) > 0 THEN ROUND(SUM(contact_click_count) * 1.0 / SUM(session_count), 4)
          ELSE 0
        END AS contact_rate,
        CASE
          WHEN SUM(session_count) > 0 THEN ROUND(SUM(register_count) * 1.0 / SUM(session_count), 4)
          ELSE 0
        END AS register_rate
      FROM analytics_source_page_daily
      WHERE date BETWEEN ? AND ?
        AND source_channel = 'search'
      GROUP BY route_name, path, entity_type, entity_id, page_title
      ORDER BY entry_count DESC, page_view_count DESC
      LIMIT 30
    `, [range.from, range.to]),
  ])

  const totalRow = totals.rows[0] ?? {}
  const landingRow = landingTotals.rows[0] ?? {}
  const overallRow = overallTotals.rows[0] ?? {}
  const sessionCount = Number((totalRow as Record<string, unknown>).session_count ?? 0)
  const pageViewCount = Number((totalRow as Record<string, unknown>).page_view_count ?? 0)
  const activeSeconds = Number((totalRow as Record<string, unknown>).active_seconds_total ?? 0)
  const landingCount = Number((landingRow as Record<string, unknown>).landing_count ?? 0)
  const bounceCount = Number((landingRow as Record<string, unknown>).bounce_count ?? 0)
  const totalSessions = Number((overallRow as Record<string, unknown>).total_session_count ?? 0)
  const totalPageViews = Number((overallRow as Record<string, unknown>).total_page_view_count ?? 0)

  return c.json({
    range,
    usage: mergeQueryUsage(totals, landingTotals, overallTotals, trend, referrers, landingPages),
    data: {
      totals: {
        ...totalRow,
        ...landingRow,
        total_session_count: totalSessions,
        total_page_view_count: totalPageViews,
        average_active_seconds: sessionCount > 0 ? Math.round(activeSeconds / sessionCount) : 0,
        search_session_share: totalSessions > 0 ? roundRate(sessionCount / totalSessions) : 0,
        search_page_view_share: totalPageViews > 0 ? roundRate(pageViewCount / totalPageViews) : 0,
        landing_bounce_rate: landingCount > 0 ? roundRate(bounceCount / landingCount) : 0,
        contact_rate: sessionCount > 0 ? roundRate(Number((totalRow as Record<string, unknown>).contact_click_count ?? 0) / sessionCount) : 0,
        register_rate: sessionCount > 0 ? roundRate(Number((totalRow as Record<string, unknown>).register_count ?? 0) / sessionCount) : 0,
      },
      trend: trend.rows,
      referrers: referrers.rows.map(enrichAnalyticsDisplayRow),
      landingPages: landingPages.rows.map(enrichAnalyticsDisplayRow),
      notes: {
        source: 'SEO 数据来自站内一方埋点识别到的自然搜索 referrer 或 utm_medium=seo/search/organic_search。',
        limitation: '当前不读取 Google Search Console 或搜索广告后台，因此不包含关键词排名、展现量和搜索词明细。',
      },
    },
  })
})

adminAnalyticsRoutes.get('/sources', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const { where, params } = analyticsWhere(c, range, 'ads', { sourceName: true })
  const [result, trackingSources] = await Promise.all([
    queryAll(c.env.DB, `
    SELECT ads.source_channel, ads.source_name, ads.invite_code_id,
           COALESCE(ats.name, '') AS tracking_source_label,
           CASE WHEN ats.id IS NULL THEN 0 ELSE 1 END AS source_matched,
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
    LEFT JOIN analytics_tracking_sources ats ON ats.slug = ads.source_name
    WHERE ${where}
    GROUP BY ads.source_channel, ads.source_name, ads.invite_code_id, ats.name, ats.id
    ORDER BY session_count DESC
  `, params),
    listTrackingSourcesWithMetrics(c.env.DB, range),
  ])
  const rows = result.rows.map(enrichAnalyticsDisplayRow)
  const unmatchedSourceCount = rows.filter(row => {
    const sourceName = String(row.source_name ?? '').trim()
    const channel = String(row.source_channel ?? '').trim()
    return sourceName && !row.source_matched && !['direct', 'invite', 'unknown'].includes(channel)
  }).length
  return c.json({
    range,
    usage: result.usage,
    data: rows,
    trackingSources,
    diagnostics: { unmatchedSourceCount },
  })
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
  return c.json({ range, usage: result.usage, data: result.rows.map(enrichAnalyticsDisplayRow) })
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
  return c.json({ range, usage: result.usage, data: result.rows.map(enrichAnalyticsDisplayRow) })
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
  return c.json({ range, usage: result.usage, data: result.rows.map(enrichAnalyticsDisplayRow) })
})

adminAnalyticsRoutes.get('/source-pages', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const { where, params } = analyticsWhere(c, range, 'aspd', { sourceName: true, path: true })
  const result = await queryAll(c.env.DB, `
    SELECT aspd.source_channel, aspd.source_name, aspd.invite_code_id,
           COALESCE(ats.name, '') AS tracking_source_label,
           CASE WHEN ats.id IS NULL THEN 0 ELSE 1 END AS source_matched,
           aspd.route_name, aspd.path, aspd.entity_type, aspd.entity_id, aspd.page_title,
           SUM(aspd.page_view_count) AS page_view_count,
           SUM(aspd.visitor_count) AS visitor_count,
           SUM(aspd.session_count) AS session_count,
           SUM(aspd.entry_count) AS entry_count,
           SUM(aspd.exit_count) AS exit_count,
           SUM(aspd.bounce_count) AS bounce_count,
           SUM(aspd.active_seconds_total) AS active_seconds_total,
           MAX(aspd.max_scroll_depth) AS max_scroll_depth,
           SUM(aspd.register_count) AS register_count,
           SUM(aspd.contact_click_count) AS contact_click_count
    FROM analytics_source_page_daily aspd
    LEFT JOIN analytics_tracking_sources ats ON ats.slug = aspd.source_name
    WHERE ${where}
    GROUP BY aspd.source_channel, aspd.source_name, aspd.invite_code_id,
             ats.name, ats.id, aspd.route_name, aspd.path, aspd.entity_type,
             aspd.entity_id, aspd.page_title
    ORDER BY page_view_count DESC
  `, params)
  return c.json({ range, usage: result.usage, data: result.rows.map(enrichAnalyticsDisplayRow) })
})

adminAnalyticsRoutes.get('/source-clicks', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const { where, params } = analyticsWhere(c, range, 'ascd', { sourceName: true })
  const result = await queryAll(c.env.DB, `
    SELECT ascd.source_channel, ascd.source_name, ascd.invite_code_id,
           COALESCE(ats.name, '') AS tracking_source_label,
           CASE WHEN ats.id IS NULL THEN 0 ELSE 1 END AS source_matched,
           ascd.element_id, ascd.element_type, ascd.location, ascd.target_type, ascd.target_id,
           SUM(ascd.raw_click_count) AS raw_click_count,
           SUM(ascd.effective_click_count) AS effective_click_count,
           SUM(ascd.duplicate_click_count) AS duplicate_click_count,
           SUM(ascd.visitor_count) AS visitor_count,
           SUM(ascd.session_count) AS session_count,
           SUM(ascd.user_count) AS user_count,
           SUM(ascd.exposure_session_count) AS exposure_session_count
    FROM analytics_source_click_daily ascd
    LEFT JOIN analytics_tracking_sources ats ON ats.slug = ascd.source_name
    WHERE ${where}
    GROUP BY ascd.source_channel, ascd.source_name, ascd.invite_code_id,
             ats.name, ats.id, ascd.element_id, ascd.element_type, ascd.location,
             ascd.target_type, ascd.target_id
    ORDER BY raw_click_count DESC
  `, params)
  return c.json({ range, usage: result.usage, data: result.rows.map(enrichAnalyticsDisplayRow) })
})

adminAnalyticsRoutes.get('/funnel', async (c) => {
  const range = parseRangeOrError(c)
  if (range instanceof Response) return range

  const hasSourceFilters = hasAnalyticsSourceFilters(c)
  const path = normalizedQueryValue(c.req.query('path'))

  const sourceTotalsWhere = analyticsWhere(c, range, 'ads', { sourceName: true })
  const sourceTotals = await queryFirst(c.env.DB, `
    SELECT
      COALESCE(SUM(session_count), 0) AS session_count,
      COALESCE(SUM(page_view_count), 0) AS page_view_count,
      COALESCE(SUM(gallery_detail_count), 0) AS gallery_detail_count,
      COALESCE(SUM(contact_click_count), 0) AS contact_click_count,
      COALESCE(SUM(register_count), 0) AS register_count,
      COALESCE(SUM(membership_grant_count), 0) AS membership_grant_count
    FROM analytics_daily_sources ads
    WHERE ${sourceTotalsWhere.where}
  `, sourceTotalsWhere.params)

  const pageTotals = hasSourceFilters || path
    ? await queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(session_count), 0) AS filtered_session_count,
        COALESCE(SUM(page_view_count), 0) AS filtered_page_view_count,
        COALESCE(SUM(CASE WHEN entity_type = 'gallery' OR route_name = '/gallery/:slug' THEN page_view_count ELSE 0 END), 0) AS filtered_gallery_detail_count,
        COALESCE(SUM(contact_click_count), 0) AS filtered_contact_click_count,
        COALESCE(SUM(register_count), 0) AS filtered_register_count
      FROM analytics_source_page_daily aspd
      WHERE ${analyticsWhere(c, range, 'aspd', { sourceName: true, path: true }).where}
    `, analyticsWhere(c, range, 'aspd', { sourceName: true, path: true }).params)
    : await queryFirst(c.env.DB, `
      SELECT
        COALESCE(SUM(session_count), 0) AS filtered_session_count,
        COALESCE(SUM(page_view_count), 0) AS filtered_page_view_count,
        COALESCE(SUM(CASE WHEN entity_type = 'gallery' OR route_name = '/gallery/:slug' THEN page_view_count ELSE 0 END), 0) AS filtered_gallery_detail_count,
        COALESCE(SUM(contact_click_count), 0) AS filtered_contact_click_count,
        COALESCE(SUM(register_count), 0) AS filtered_register_count
      FROM analytics_daily_pages adp
      WHERE adp.date BETWEEN ? AND ?
    `, [range.from, range.to])

  const clickTotals = hasSourceFilters
    ? await queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(effective_click_count), 0) AS key_click_count
      FROM analytics_source_click_daily ascd
      WHERE ${analyticsWhere(c, range, 'ascd', { sourceName: true }).where}
    `, analyticsWhere(c, range, 'ascd', { sourceName: true }).params)
    : await queryFirst(c.env.DB, `
      SELECT COALESCE(SUM(effective_click_count), 0) AS key_click_count
      FROM analytics_click_daily
      WHERE date BETWEEN ? AND ?
    `, [range.from, range.to])

  const sourceRow = sourceTotals.rows[0] ?? {}
  const pageRow = pageTotals.rows[0] ?? {}
  const clickRow = clickTotals.rows[0] ?? {}
  const data = buildFunnel({
    session_count: path ? pageRow.filtered_session_count : sourceRow.session_count,
    page_view_count: pageRow.filtered_page_view_count ?? sourceRow.page_view_count,
    gallery_detail_count: pageRow.filtered_gallery_detail_count ?? sourceRow.gallery_detail_count,
    key_click_count: clickRow.key_click_count,
    contact_click_count: path ? pageRow.filtered_contact_click_count : sourceRow.contact_click_count,
    register_count: path ? pageRow.filtered_register_count : sourceRow.register_count,
    membership_grant_count: sourceRow.membership_grant_count,
  })

  return c.json({
    range,
    usage: mergeQueryUsage(sourceTotals, pageTotals, clickTotals),
    data,
    filters: await readFunnelFilters(c),
  })
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
  return c.json({ range, usage: result.usage, data: result.rows.map(enrichAnalyticsDisplayRow) })
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
      summary: summary.rows[0] ? enrichAnalyticsDisplayRow(summary.rows[0]) : null,
      events: events.rows.map(row => ({
        ...enrichAnalyticsDisplayRow(row),
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

function analyticsWhere(
  c: AdminAnalyticsContext,
  range: AnalyticsDateRange,
  alias: string,
  options: { sourceName?: boolean; path?: boolean } = {},
) {
  const conditions = [`${alias}.date BETWEEN ? AND ?`]
  const params: unknown[] = [range.from, range.to]
  const sourceChannel = c.req.query('sourceChannel')
  const inviteCodeId = normalizedQueryValue(c.req.query('inviteCodeId'))
  const sourceCode = normalizedQueryValue(c.req.query('sourceCode')) || normalizedQueryValue(c.req.query('sourceName'))
  const path = normalizedQueryValue(c.req.query('path'))

  if (sourceChannel && sourceChannel !== 'all') {
    conditions.push(`${alias}.source_channel = ?`)
    params.push(sourceChannel)
  }
  if (options.sourceName && sourceCode) {
    conditions.push(`${alias}.source_name = ?`)
    params.push(sourceCode)
  }
  if (inviteCodeId) {
    conditions.push(`${alias}.invite_code_id = ?`)
    params.push(inviteCodeId)
  }
  if (options.path && path) {
    conditions.push(`${alias}.path = ?`)
    params.push(path)
  }

  return { where: conditions.join(' AND '), params }
}

function normalizedQueryValue(value: string | undefined) {
  const text = String(value ?? '').trim()
  return text && text !== 'all' ? text : ''
}

function hasAnalyticsSourceFilters(c: AdminAnalyticsContext) {
  return Boolean(
    normalizedQueryValue(c.req.query('sourceChannel')) ||
    normalizedQueryValue(c.req.query('sourceCode')) ||
    normalizedQueryValue(c.req.query('sourceName')) ||
    normalizedQueryValue(c.req.query('inviteCodeId')),
  )
}

function buildFunnel(input: Record<string, unknown>) {
  const contactOrRegisters = Number(input.contact_click_count ?? 0) + Number(input.register_count ?? 0)
  const stages = [
    { key: 'sessions', label: 'Session', value: Number(input.session_count ?? 0), detailTo: '/admin/analytics/sources' },
    { key: 'page_views', label: '页面访问', value: Number(input.page_view_count ?? 0), detailTo: '/admin/analytics/source-pages' },
    { key: 'gallery_details', label: '详情浏览', value: Number(input.gallery_detail_count ?? 0), detailTo: '/admin/analytics/pages' },
    { key: 'key_clicks', label: '关键点击', value: Number(input.key_click_count ?? 0), detailTo: '/admin/analytics/source-clicks' },
    { key: 'contacts_or_registers', label: '联系/注册', value: contactOrRegisters, detailTo: '/admin/analytics/sources' },
    { key: 'membership_grants', label: '会员发放', value: Number(input.membership_grant_count ?? 0), detailTo: '/admin/memberships' },
  ].map((stage, index, all) => {
    const previous = index === 0 ? stage.value : all[index - 1]?.value ?? 0
    const entry = all[0]?.value ?? 0
    return {
      ...stage,
      rateFromPrevious: previous > 0 ? roundRate(stage.value / previous) : 0,
      rateFromEntry: entry > 0 ? roundRate(stage.value / entry) : 0,
    }
  })

  const dropOffs = stages.slice(1).map((stage, index) => {
    const previous = stages[index]
    const lost = Math.max(0, (previous?.value ?? 0) - stage.value)
    return {
      from: previous?.key ?? '',
      fromLabel: previous?.label ?? '',
      to: stage.key,
      toLabel: stage.label,
      lost,
      lossRate: previous && previous.value > 0 ? roundRate(lost / previous.value) : 0,
    }
  }).sort((a, b) => b.lossRate - a.lossRate)

  return { stages, dropOffs }
}

function roundRate(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10000) / 10000
}

async function readFunnelFilters(c: AdminAnalyticsContext) {
  const sourceCode = normalizedQueryValue(c.req.query('sourceCode')) || normalizedQueryValue(c.req.query('sourceName'))
  const sourceChannel = normalizedQueryValue(c.req.query('sourceChannel'))
  const inviteCodeId = normalizedQueryValue(c.req.query('inviteCodeId'))
  const path = normalizedQueryValue(c.req.query('path'))
  const label = sourceCode
    ? await c.env.DB.prepare('SELECT name FROM analytics_tracking_sources WHERE slug = ? LIMIT 1').bind(sourceCode).first<{ name: string }>()
    : null
  return {
    sourceChannel,
    sourceCode,
    sourceName: sourceCode,
    sourceLabel: label?.name ?? '',
    inviteCodeId,
    path,
  }
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
