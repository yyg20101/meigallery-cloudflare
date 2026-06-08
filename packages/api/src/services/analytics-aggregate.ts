import { ANALYTICS_RETENTION } from '@meigallery/shared/constants'

type AnalyticsDb = Pick<D1Database, 'prepare'>

export interface AnalyticsAggregateResult {
  date: string
  steps: string[]
}

export async function aggregateAnalyticsDaily(db: AnalyticsDb, date: string): Promise<AnalyticsAggregateResult> {
  assertDate(date)
  await aggregateDailySources(db, date)
  await aggregateDailyPages(db, date)
  await aggregateSourcePages(db, date)
  await aggregateDailyEvents(db, date)
  await aggregateInviteDaily(db, date)
  return { date, steps: ['sources', 'pages', 'source-pages', 'events', 'invites'] }
}

export async function aggregatePathEdges(db: AnalyticsDb, date: string): Promise<AnalyticsAggregateResult> {
  assertDate(date)
  await db.prepare('DELETE FROM analytics_path_edges WHERE date = ?').bind(date).run()
  await db.prepare(`
    INSERT INTO analytics_path_edges (
      date, from_route, to_route, from_path, to_path, transition_count,
      visitor_count, session_count, conversion_count, updated_at
    )
    WITH ordered_pages AS (
      SELECT
        aps.date,
        aps.session_id,
        aps.visitor_id,
        aps.route_name AS from_route,
        aps.path AS from_path,
        LEAD(aps.route_name) OVER (
          PARTITION BY aps.session_id
          ORDER BY aps.first_viewed_at, aps.id
        ) AS to_route,
        LEAD(aps.path) OVER (
          PARTITION BY aps.session_id
          ORDER BY aps.first_viewed_at, aps.id
        ) AS to_path
      FROM analytics_page_summaries aps
      WHERE aps.date = ?
    )
    SELECT
      op.date,
      op.from_route,
      op.to_route,
      MIN(op.from_path) AS from_path,
      MIN(op.to_path) AS to_path,
      COUNT(*) AS transition_count,
      COUNT(DISTINCT op.visitor_id) AS visitor_count,
      COUNT(DISTINCT op.session_id) AS session_count,
      SUM(CASE
        WHEN ss.contact_click_count > 0
          OR ss.register_success_count > 0
          OR ss.membership_grant_count > 0
        THEN 1 ELSE 0
      END) AS conversion_count,
      datetime('now')
    FROM ordered_pages op
    LEFT JOIN analytics_session_summaries ss ON ss.session_id = op.session_id
    WHERE op.to_route IS NOT NULL AND op.to_route != ''
    GROUP BY op.date, op.from_route, op.to_route
  `).bind(date).run()
  return { date, steps: ['paths'] }
}

export async function aggregateClickDaily(db: AnalyticsDb, date: string): Promise<AnalyticsAggregateResult> {
  assertDate(date)
  await db.prepare(`
    UPDATE analytics_click_daily
    SET
      effective_click_count = CASE
        WHEN raw_click_count > duplicate_click_count THEN raw_click_count - duplicate_click_count
        ELSE 0
      END,
      updated_at = datetime('now')
    WHERE date = ?
  `).bind(date).run()
  return { date, steps: ['clicks'] }
}

export async function cleanupAnalyticsRetention(db: AnalyticsDb, now = new Date()) {
  const sampledRawBefore = addDays(toIsoDate(now), -ANALYTICS_RETENTION.SAMPLED_RAW_DAYS)
  const summaryBefore = addDays(toIsoDate(now), -ANALYTICS_RETENTION.SUMMARY_DAYS)
  const aggregateBefore = addDays(toIsoDate(now), -ANALYTICS_RETENTION.AGGREGATE_DAYS)
  const visitorBeforeIso = addDays(now.toISOString().slice(0, 10), -ANALYTICS_RETENTION.VISITOR_TTL_DAYS)

  const sampledEvents = await db.prepare("DELETE FROM analytics_events WHERE sampled = 1 AND substr(occurred_at, 1, 10) < ?").bind(sampledRawBefore).run()
  const pageSummaries = await db.prepare('DELETE FROM analytics_page_summaries WHERE date < ?').bind(summaryBefore).run()
  const sessionSummaries = await db.prepare('DELETE FROM analytics_session_summaries WHERE date < ?').bind(summaryBefore).run()
  const sessions = await db.prepare(`
    DELETE FROM analytics_sessions
    WHERE substr(started_at, 1, 10) < ?
      AND id NOT IN (SELECT DISTINCT session_id FROM analytics_events)
  `).bind(summaryBefore).run()
  const visitors = await db.prepare(`
    DELETE FROM analytics_visitors
    WHERE user_id IS NULL
      AND substr(last_seen_at, 1, 10) < ?
      AND id NOT IN (SELECT DISTINCT visitor_id FROM analytics_sessions)
      AND id NOT IN (SELECT DISTINCT visitor_id FROM analytics_events)
  `).bind(visitorBeforeIso).run()
  const dailySources = await db.prepare('DELETE FROM analytics_daily_sources WHERE date < ?').bind(aggregateBefore).run()
  const dailyPages = await db.prepare('DELETE FROM analytics_daily_pages WHERE date < ?').bind(aggregateBefore).run()
  const dailyEvents = await db.prepare('DELETE FROM analytics_daily_events WHERE date < ?').bind(aggregateBefore).run()
  const pathEdges = await db.prepare('DELETE FROM analytics_path_edges WHERE date < ?').bind(aggregateBefore).run()
  const inviteDaily = await db.prepare('DELETE FROM analytics_invite_daily WHERE date < ?').bind(aggregateBefore).run()
  const clickDaily = await db.prepare('DELETE FROM analytics_click_daily WHERE date < ?').bind(aggregateBefore).run()
  const sourcePageDaily = await db.prepare('DELETE FROM analytics_source_page_daily WHERE date < ?').bind(aggregateBefore).run()
  const sourceClickDaily = await db.prepare('DELETE FROM analytics_source_click_daily WHERE date < ?').bind(aggregateBefore).run()
  const healthDaily = await db.prepare('DELETE FROM analytics_ingest_health_daily WHERE date < ?').bind(aggregateBefore).run()
  const exports = await db.prepare(`
    UPDATE analytics_export_jobs
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'completed'
      AND expires_at IS NOT NULL
      AND datetime(expires_at) < datetime('now')
  `).run()

  return {
    sampledRawBefore,
    summaryBefore,
    aggregateBefore,
    changes: {
      sampledEvents: changes(sampledEvents),
      pageSummaries: changes(pageSummaries),
      sessionSummaries: changes(sessionSummaries),
      sessions: changes(sessions),
      visitors: changes(visitors),
      dailySources: changes(dailySources),
      dailyPages: changes(dailyPages),
      dailyEvents: changes(dailyEvents),
      pathEdges: changes(pathEdges),
      inviteDaily: changes(inviteDaily),
      clickDaily: changes(clickDaily),
      sourcePageDaily: changes(sourcePageDaily),
      sourceClickDaily: changes(sourceClickDaily),
      healthDaily: changes(healthDaily),
      exports: changes(exports),
    },
  }
}

async function aggregateDailySources(db: AnalyticsDb, date: string) {
  await db.prepare('DELETE FROM analytics_daily_sources WHERE date = ?').bind(date).run()
  await db.prepare(`
    INSERT INTO analytics_daily_sources (
      date, source_channel, source_name, invite_code_id, visitor_count,
      session_count, page_view_count, gallery_detail_count, contact_click_count,
      register_count, invite_register_count, membership_grant_count,
      active_seconds_total, updated_at
    )
    WITH source_sessions AS (
      SELECT
        ss.date,
        ss.source_channel,
        ss.source_name,
        ss.invite_code_id,
        COUNT(DISTINCT ss.visitor_id) AS visitor_count,
        COUNT(DISTINCT ss.session_id) AS session_count,
        SUM(ss.page_view_count) AS page_view_count,
        SUM(ss.contact_click_count) AS contact_click_count,
        SUM(ss.register_success_count) AS register_count,
        SUM(CASE WHEN ss.invite_code_id != '' THEN ss.register_success_count ELSE 0 END) AS invite_register_count,
        SUM(ss.membership_grant_count) AS membership_grant_count,
        SUM(ss.active_seconds) AS active_seconds_total
      FROM analytics_session_summaries ss
      WHERE ss.date = ?
      GROUP BY ss.date, ss.source_channel, ss.source_name, ss.invite_code_id
    ),
    gallery_counts AS (
      SELECT
        ss.date,
        ss.source_channel,
        ss.source_name,
        ss.invite_code_id,
        SUM(aps.page_view_count) AS gallery_detail_count
      FROM analytics_session_summaries ss
      JOIN analytics_page_summaries aps
        ON aps.session_id = ss.session_id
       AND aps.date = ss.date
      WHERE ss.date = ? AND aps.route_name = '/gallery/:slug'
      GROUP BY ss.date, ss.source_channel, ss.source_name, ss.invite_code_id
    )
    SELECT
      s.date,
      s.source_channel,
      s.source_name,
      s.invite_code_id,
      s.visitor_count,
      s.session_count,
      COALESCE(s.page_view_count, 0),
      COALESCE(g.gallery_detail_count, 0),
      COALESCE(s.contact_click_count, 0),
      COALESCE(s.register_count, 0),
      COALESCE(s.invite_register_count, 0),
      COALESCE(s.membership_grant_count, 0),
      COALESCE(s.active_seconds_total, 0),
      datetime('now')
    FROM source_sessions s
    LEFT JOIN gallery_counts g
      ON g.date = s.date
     AND g.source_channel = s.source_channel
     AND g.source_name = s.source_name
     AND g.invite_code_id = s.invite_code_id
  `).bind(date, date).run()
}

async function aggregateDailyPages(db: AnalyticsDb, date: string) {
  await db.prepare('DELETE FROM analytics_daily_pages WHERE date = ?').bind(date).run()
  await db.prepare(`
    INSERT INTO analytics_daily_pages (
      date, route_name, path, entity_type, entity_id, page_title, page_view_count,
      visitor_count, session_count, entry_count, exit_count, bounce_count,
      active_seconds_total, max_scroll_depth, register_count, contact_click_count,
      updated_at
    )
    SELECT
      date,
      route_name,
      path,
      entity_type,
      entity_id,
      MAX(page_title) AS page_title,
      SUM(page_view_count) AS page_view_count,
      COUNT(DISTINCT visitor_id) AS visitor_count,
      COUNT(DISTINCT session_id) AS session_count,
      SUM(is_entry) AS entry_count,
      SUM(is_exit) AS exit_count,
      SUM(is_bounce) AS bounce_count,
      SUM(active_seconds) AS active_seconds_total,
      MAX(max_scroll_depth) AS max_scroll_depth,
      0 AS register_count,
      0 AS contact_click_count,
      datetime('now')
    FROM analytics_page_summaries
    WHERE date = ?
    GROUP BY date, route_name, path, entity_type, entity_id
  `).bind(date).run()
}

async function aggregateDailyEvents(db: AnalyticsDb, date: string) {
  await db.prepare('DELETE FROM analytics_daily_events WHERE date = ?').bind(date).run()
  await db.prepare(`
    INSERT INTO analytics_daily_events (
      date, event_name, entity_type, entity_id, event_count, visitor_count,
      session_count, user_count, value_total, updated_at
    )
    SELECT
      ? AS date,
      event_name,
      entity_type,
      entity_id,
      COUNT(*) AS event_count,
      COUNT(DISTINCT visitor_id) AS visitor_count,
      COUNT(DISTINCT session_id) AS session_count,
      COUNT(DISTINCT user_id) AS user_count,
      COALESCE(SUM(value), 0) AS value_total,
      datetime('now')
    FROM analytics_events
    WHERE substr(occurred_at, 1, 10) = ?
    GROUP BY event_name, entity_type, entity_id
  `).bind(date, date).run()
}

async function aggregateSourcePages(db: AnalyticsDb, date: string) {
  await db.prepare('DELETE FROM analytics_source_page_daily WHERE date = ?').bind(date).run()
  await db.prepare(`
    INSERT INTO analytics_source_page_daily (
      date, source_channel, source_name, invite_code_id,
      route_name, path, entity_type, entity_id, page_title,
      visitor_count, session_count, page_view_count, entry_count, exit_count,
      bounce_count, active_seconds_total, max_scroll_depth, register_count,
      contact_click_count, updated_at
    )
    SELECT
      aps.date,
      ss.source_channel,
      ss.source_name,
      ss.invite_code_id,
      aps.route_name,
      aps.path,
      aps.entity_type,
      aps.entity_id,
      MAX(aps.page_title) AS page_title,
      COUNT(DISTINCT aps.visitor_id) AS visitor_count,
      COUNT(DISTINCT aps.session_id) AS session_count,
      SUM(aps.page_view_count) AS page_view_count,
      SUM(aps.is_entry) AS entry_count,
      SUM(aps.is_exit) AS exit_count,
      SUM(aps.is_bounce) AS bounce_count,
      SUM(aps.active_seconds) AS active_seconds_total,
      MAX(aps.max_scroll_depth) AS max_scroll_depth,
      0 AS register_count,
      0 AS contact_click_count,
      datetime('now')
    FROM analytics_page_summaries aps
    JOIN analytics_session_summaries ss
      ON ss.session_id = aps.session_id
     AND ss.date = aps.date
    WHERE aps.date = ?
    GROUP BY
      aps.date, ss.source_channel, ss.source_name, ss.invite_code_id,
      aps.route_name, aps.path, aps.entity_type, aps.entity_id
  `).bind(date).run()
}

async function aggregateInviteDaily(db: AnalyticsDb, date: string) {
  await db.prepare('DELETE FROM analytics_invite_daily WHERE date = ?').bind(date).run()
  await db.prepare(`
    INSERT INTO analytics_invite_daily (
      date, invite_code_id, channel, landing_count, visitor_count, session_count,
      register_count, contact_click_count, membership_grant_count, updated_at
    )
    WITH invite_sessions AS (
      SELECT
        invite_code_id,
        COUNT(DISTINCT visitor_id) AS visitor_count,
        COUNT(DISTINCT session_id) AS session_count,
        SUM(contact_click_count) AS contact_click_count
      FROM analytics_session_summaries
      WHERE date = ? AND invite_code_id != ''
      GROUP BY invite_code_id
    ),
    invite_registers AS (
      SELECT
        invite_code_id,
        COUNT(*) AS register_count
      FROM invite_registrations
      WHERE substr(registered_at, 1, 10) = ?
      GROUP BY invite_code_id
    ),
    invite_memberships AS (
      SELECT
        invite_code_id,
        COUNT(*) AS membership_grant_count
      FROM invite_registrations
      WHERE first_membership_granted_at IS NOT NULL
        AND substr(first_membership_granted_at, 1, 10) = ?
      GROUP BY invite_code_id
    ),
    ids AS (
      SELECT invite_code_id FROM invite_sessions
      UNION
      SELECT invite_code_id FROM invite_registers
      UNION
      SELECT invite_code_id FROM invite_memberships
    )
    SELECT
      ? AS date,
      ids.invite_code_id,
      COALESCE(ic.channel, '') AS channel,
      COALESCE(invite_sessions.session_count, 0) AS landing_count,
      COALESCE(invite_sessions.visitor_count, 0) AS visitor_count,
      COALESCE(invite_sessions.session_count, 0) AS session_count,
      COALESCE(invite_registers.register_count, 0) AS register_count,
      COALESCE(invite_sessions.contact_click_count, 0) AS contact_click_count,
      COALESCE(invite_memberships.membership_grant_count, 0) AS membership_grant_count,
      datetime('now')
    FROM ids
    LEFT JOIN invite_codes ic ON ic.id = ids.invite_code_id
    LEFT JOIN invite_sessions ON invite_sessions.invite_code_id = ids.invite_code_id
    LEFT JOIN invite_registers ON invite_registers.invite_code_id = ids.invite_code_id
    LEFT JOIN invite_memberships ON invite_memberships.invite_code_id = ids.invite_code_id
  `).bind(date, date, date, date).run()
}

function assertDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('分析日期格式必须为 YYYY-MM-DD')
  }
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function addDays(date: string, delta: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + delta)
  return parsed.toISOString().slice(0, 10)
}

function changes(result: D1Result<unknown>) {
  return result.meta?.changes ?? 0
}
