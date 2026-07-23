PRAGMA defer_foreign_keys = true;

-- 投放来源平台约束与统一归因平台保持一致，不再由旧 Meta/TikTok 架构限制 Google。
CREATE TABLE analytics_tracking_sources_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'referral',
  slug TEXT NOT NULL UNIQUE,
  link_proof TEXT NOT NULL UNIQUE,
  target_path TEXT NOT NULL DEFAULT '/',
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL DEFAULT 'referral',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  ad_provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('direct', 'search', 'social', 'referral', 'ad', 'internal', 'unknown')),
  CHECK (length(link_proof) = 64 AND link_proof NOT GLOB '*[^0-9a-f]*'),
  CHECK (ad_provider IN ('', 'meta', 'tiktok', 'google')),
  CHECK (status IN ('active', 'disabled'))
);

INSERT INTO analytics_tracking_sources_v2 (
  id, name, channel, slug, link_proof, target_path, utm_source, utm_medium, utm_campaign,
  utm_content, ad_provider, status, note, created_by, created_at, updated_at
)
SELECT
  id, name, channel, slug, lower(hex(randomblob(32))), target_path, utm_source, utm_medium, utm_campaign,
  utm_content, ad_provider, status, note, created_by, created_at, updated_at
FROM analytics_tracking_sources;

DROP TABLE analytics_tracking_sources;
ALTER TABLE analytics_tracking_sources_v2 RENAME TO analytics_tracking_sources;

CREATE INDEX idx_analytics_tracking_sources_status
  ON analytics_tracking_sources(status, created_at);
CREATE UNIQUE INDEX idx_analytics_tracking_sources_utm_source
  ON analytics_tracking_sources(utm_source);
CREATE INDEX idx_tracking_sources_ad_provider
  ON analytics_tracking_sources(ad_provider, status, created_at);

-- 管理后台创建的广告链接是可信来源。修正浏览器早期未识别 paid_social
-- 导致的 referral 历史记录，不猜测普通 UTM 或自然流量。
UPDATE analytics_sessions
SET source_channel = 'ad', updated_at = datetime('now')
WHERE source_channel != 'ad'
  AND EXISTS (
    SELECT 1
    FROM analytics_tracking_sources AS source
    WHERE source.channel = 'ad'
      AND (
        source.slug = analytics_sessions.source_name
        OR source.utm_source = analytics_sessions.source_name
        OR source.utm_source = analytics_sessions.utm_source
      )
  );

UPDATE analytics_session_summaries
SET source_channel = 'ad', updated_at = datetime('now')
WHERE source_channel != 'ad'
  AND EXISTS (
    SELECT 1
    FROM analytics_sessions AS session
    WHERE session.id = analytics_session_summaries.session_id
      AND session.source_channel = 'ad'
  );

UPDATE analytics_events
SET source_channel = 'ad'
WHERE source_channel != 'ad'
  AND EXISTS (
    SELECT 1
    FROM analytics_sessions AS session
    WHERE session.id = analytics_events.session_id
      AND session.source_channel = 'ad'
  );

UPDATE analytics_visitors
SET first_source_channel = 'ad', updated_at = datetime('now')
WHERE first_source_channel != 'ad'
  AND EXISTS (
    SELECT 1
    FROM analytics_tracking_sources AS source
    WHERE source.channel = 'ad'
      AND (
        source.slug = analytics_visitors.first_source_name
        OR source.utm_source = analytics_visitors.first_source_name
      )
  );

UPDATE attribution_conversion_facts
SET analytics_dimensions_json = json_set(
  analytics_dimensions_json,
  '$.sourceChannel',
  'ad',
  '$.trackingSourceSlug',
  COALESCE(
    NULLIF(json_extract(analytics_dimensions_json, '$.trackingSourceSlug'), ''),
    (
      SELECT source.slug
      FROM analytics_tracking_sources AS source
      WHERE source.channel = 'ad'
        AND (
          source.slug = json_extract(attribution_conversion_facts.analytics_dimensions_json, '$.sourceName')
          OR source.utm_source = json_extract(attribution_conversion_facts.analytics_dimensions_json, '$.sourceName')
        )
      LIMIT 1
    )
  )
)
WHERE json_valid(analytics_dimensions_json)
  AND EXISTS (
    SELECT 1
    FROM analytics_tracking_sources AS source
    WHERE source.channel = 'ad'
      AND (
        source.slug = json_extract(attribution_conversion_facts.analytics_dimensions_json, '$.trackingSourceSlug')
        OR source.utm_source = json_extract(attribution_conversion_facts.analytics_dimensions_json, '$.trackingSourceSlug')
        OR source.slug = json_extract(attribution_conversion_facts.analytics_dimensions_json, '$.sourceName')
        OR source.utm_source = json_extract(attribution_conversion_facts.analytics_dimensions_json, '$.sourceName')
      )
  );

-- 有效联系只认具体联系方式成功动作，打开联系面板不再计入转化。
UPDATE analytics_session_summaries
SET
  contact_click_count = (
    SELECT COUNT(*)
    FROM analytics_events AS event
    WHERE event.session_id = analytics_session_summaries.session_id
      AND event.event_name = 'contact_method_click'
  ),
  updated_at = datetime('now');

DELETE FROM analytics_daily_sources;

INSERT INTO analytics_daily_sources (
  date, source_channel, source_name, invite_code_id,
  visitor_count, session_count, page_view_count, gallery_detail_count,
  contact_click_count, register_count, invite_register_count,
  membership_grant_count, active_seconds_total, updated_at
)
WITH source_sessions AS (
  SELECT
    date,
    source_channel,
    source_name,
    invite_code_id,
    COUNT(DISTINCT visitor_id) AS visitor_count,
    COUNT(DISTINCT session_id) AS session_count,
    SUM(page_view_count) AS page_view_count,
    SUM(active_seconds) AS active_seconds_total
  FROM analytics_session_summaries
  GROUP BY date, source_channel, source_name, invite_code_id
),
conversion_counts AS (
  SELECT
    date(datetime(event.occurred_at, '+8 hours')) AS date,
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id,
    SUM(CASE WHEN event.event_name = 'contact_method_click' THEN 1 ELSE 0 END) AS contact_click_count,
    SUM(CASE WHEN event.event_name = 'register_success' THEN 1 ELSE 0 END) AS register_count,
    SUM(CASE
      WHEN event.event_name = 'register_success' AND summary.invite_code_id != '' THEN 1
      ELSE 0
    END) AS invite_register_count,
    SUM(CASE WHEN event.event_name = 'membership_granted_conversion' THEN 1 ELSE 0 END) AS membership_grant_count
  FROM analytics_events AS event
  JOIN analytics_session_summaries AS summary
    ON summary.session_id = event.session_id
  WHERE event.event_name IN (
    'contact_method_click',
    'register_success',
    'membership_granted_conversion'
  )
  GROUP BY
    date(datetime(event.occurred_at, '+8 hours')),
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id
),
gallery_counts AS (
  SELECT
    date(datetime(event.occurred_at, '+8 hours')) AS date,
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id,
    COUNT(*) AS gallery_detail_count
  FROM analytics_events AS event
  JOIN analytics_session_summaries AS summary
    ON summary.session_id = event.session_id
  WHERE event.event_name = 'gallery_detail_view'
  GROUP BY
    date(datetime(event.occurred_at, '+8 hours')),
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id
),
dimensions AS (
  SELECT date, source_channel, source_name, invite_code_id FROM source_sessions
  UNION
  SELECT date, source_channel, source_name, invite_code_id FROM conversion_counts
  UNION
  SELECT date, source_channel, source_name, invite_code_id FROM gallery_counts
)
SELECT
  dimensions.date,
  dimensions.source_channel,
  dimensions.source_name,
  dimensions.invite_code_id,
  COALESCE(sessions.visitor_count, 0),
  COALESCE(sessions.session_count, 0),
  COALESCE(sessions.page_view_count, 0),
  COALESCE(gallery.gallery_detail_count, 0),
  COALESCE(conversions.contact_click_count, 0),
  COALESCE(conversions.register_count, 0),
  COALESCE(conversions.invite_register_count, 0),
  COALESCE(conversions.membership_grant_count, 0),
  COALESCE(sessions.active_seconds_total, 0),
  datetime('now')
FROM dimensions
LEFT JOIN source_sessions AS sessions
  ON sessions.date = dimensions.date
 AND sessions.source_channel = dimensions.source_channel
 AND sessions.source_name = dimensions.source_name
 AND sessions.invite_code_id = dimensions.invite_code_id
LEFT JOIN gallery_counts AS gallery
  ON gallery.date = dimensions.date
 AND gallery.source_channel = dimensions.source_channel
 AND gallery.source_name = dimensions.source_name
 AND gallery.invite_code_id = dimensions.invite_code_id
LEFT JOIN conversion_counts AS conversions
  ON conversions.date = dimensions.date
 AND conversions.source_channel = dimensions.source_channel
 AND conversions.source_name = dimensions.source_name
 AND conversions.invite_code_id = dimensions.invite_code_id;

DELETE FROM analytics_daily_pages;

INSERT INTO analytics_daily_pages (
  date, route_name, path, entity_type, entity_id, page_title,
  page_view_count, visitor_count, session_count, entry_count, exit_count,
  bounce_count, active_seconds_total, max_scroll_depth, register_count,
  contact_click_count, updated_at
)
WITH page_rows AS (
  SELECT
    date, route_name, path, entity_type, entity_id,
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
    0 AS contact_click_count
  FROM analytics_page_summaries
  GROUP BY date, route_name, path, entity_type, entity_id
),
conversion_rows AS (
  SELECT
    date(datetime(occurred_at, '+8 hours')) AS date,
    route_name, path, entity_type, entity_id,
    MAX(page_title) AS page_title,
    0 AS page_view_count,
    0 AS visitor_count,
    0 AS session_count,
    0 AS entry_count,
    0 AS exit_count,
    0 AS bounce_count,
    0 AS active_seconds_total,
    0 AS max_scroll_depth,
    SUM(CASE WHEN event_name = 'register_success' THEN 1 ELSE 0 END) AS register_count,
    SUM(CASE WHEN event_name = 'contact_method_click' THEN 1 ELSE 0 END) AS contact_click_count
  FROM analytics_events
  WHERE event_name IN ('contact_method_click', 'register_success')
  GROUP BY date, route_name, path, entity_type, entity_id
),
combined AS (
  SELECT * FROM page_rows
  UNION ALL
  SELECT * FROM conversion_rows
)
SELECT
  date, route_name, path, entity_type, entity_id,
  MAX(page_title),
  SUM(page_view_count),
  SUM(visitor_count),
  SUM(session_count),
  SUM(entry_count),
  SUM(exit_count),
  SUM(bounce_count),
  SUM(active_seconds_total),
  MAX(max_scroll_depth),
  SUM(register_count),
  SUM(contact_click_count),
  datetime('now')
FROM combined
GROUP BY date, route_name, path, entity_type, entity_id;

DELETE FROM analytics_source_page_daily;

INSERT INTO analytics_source_page_daily (
  date, source_channel, source_name, invite_code_id,
  route_name, path, entity_type, entity_id, page_title,
  visitor_count, session_count, page_view_count, entry_count, exit_count,
  bounce_count, active_seconds_total, max_scroll_depth, register_count,
  contact_click_count, updated_at
)
WITH page_rows AS (
  SELECT
    page.date,
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id,
    page.route_name,
    page.path,
    page.entity_type,
    page.entity_id,
    MAX(page.page_title) AS page_title,
    COUNT(DISTINCT page.visitor_id) AS visitor_count,
    COUNT(DISTINCT page.session_id) AS session_count,
    SUM(page.page_view_count) AS page_view_count,
    SUM(page.is_entry) AS entry_count,
    SUM(page.is_exit) AS exit_count,
    SUM(page.is_bounce) AS bounce_count,
    SUM(page.active_seconds) AS active_seconds_total,
    MAX(page.max_scroll_depth) AS max_scroll_depth,
    0 AS register_count,
    0 AS contact_click_count
  FROM analytics_page_summaries AS page
  JOIN analytics_session_summaries AS summary
    ON summary.session_id = page.session_id
   AND summary.date = page.date
  GROUP BY
    page.date, summary.source_channel, summary.source_name, summary.invite_code_id,
    page.route_name, page.path, page.entity_type, page.entity_id
),
conversion_rows AS (
  SELECT
    date(datetime(event.occurred_at, '+8 hours')) AS date,
    summary.source_channel,
    summary.source_name,
    summary.invite_code_id,
    event.route_name,
    event.path,
    event.entity_type,
    event.entity_id,
    MAX(event.page_title) AS page_title,
    0 AS visitor_count,
    0 AS session_count,
    0 AS page_view_count,
    0 AS entry_count,
    0 AS exit_count,
    0 AS bounce_count,
    0 AS active_seconds_total,
    0 AS max_scroll_depth,
    SUM(CASE WHEN event.event_name = 'register_success' THEN 1 ELSE 0 END) AS register_count,
    SUM(CASE WHEN event.event_name = 'contact_method_click' THEN 1 ELSE 0 END) AS contact_click_count
  FROM analytics_events AS event
  JOIN analytics_session_summaries AS summary
    ON summary.session_id = event.session_id
  WHERE event.event_name IN ('contact_method_click', 'register_success')
  GROUP BY
    date(datetime(event.occurred_at, '+8 hours')),
    summary.source_channel, summary.source_name, summary.invite_code_id,
    event.route_name, event.path, event.entity_type, event.entity_id
),
combined AS (
  SELECT * FROM page_rows
  UNION ALL
  SELECT * FROM conversion_rows
)
SELECT
  date, source_channel, source_name, invite_code_id,
  route_name, path, entity_type, entity_id,
  MAX(page_title),
  SUM(visitor_count),
  SUM(session_count),
  SUM(page_view_count),
  SUM(entry_count),
  SUM(exit_count),
  SUM(bounce_count),
  SUM(active_seconds_total),
  MAX(max_scroll_depth),
  SUM(register_count),
  SUM(contact_click_count),
  datetime('now')
FROM combined
GROUP BY
  date, source_channel, source_name, invite_code_id,
  route_name, path, entity_type, entity_id;

-- 点击维度没有原始来源名称副本，因此只合并可信管理链接的旧渠道行。
INSERT INTO analytics_source_click_daily (
  date, source_channel, source_name, invite_code_id,
  element_id, element_type, location, target_type, target_id,
  raw_click_count, effective_click_count, duplicate_click_count,
  visitor_count, session_count, user_count, exposure_session_count, updated_at
)
SELECT
  click.date,
  'ad',
  click.source_name,
  click.invite_code_id,
  click.element_id,
  click.element_type,
  click.location,
  click.target_type,
  click.target_id,
  SUM(click.raw_click_count),
  SUM(click.effective_click_count),
  SUM(click.duplicate_click_count),
  SUM(click.visitor_count),
  SUM(click.session_count),
  SUM(click.user_count),
  SUM(click.exposure_session_count),
  datetime('now')
FROM analytics_source_click_daily AS click
WHERE click.source_channel != 'ad'
  AND EXISTS (
    SELECT 1
    FROM analytics_tracking_sources AS source
    WHERE source.channel = 'ad'
      AND (source.slug = click.source_name OR source.utm_source = click.source_name)
  )
GROUP BY
  click.date, click.source_name, click.invite_code_id,
  click.element_id, click.element_type, click.location, click.target_type, click.target_id
ON CONFLICT (
  date, source_channel, source_name, invite_code_id,
  element_id, location, target_type, target_id
) DO UPDATE SET
  raw_click_count = analytics_source_click_daily.raw_click_count + excluded.raw_click_count,
  effective_click_count = analytics_source_click_daily.effective_click_count + excluded.effective_click_count,
  duplicate_click_count = analytics_source_click_daily.duplicate_click_count + excluded.duplicate_click_count,
  visitor_count = analytics_source_click_daily.visitor_count + excluded.visitor_count,
  session_count = analytics_source_click_daily.session_count + excluded.session_count,
  user_count = analytics_source_click_daily.user_count + excluded.user_count,
  exposure_session_count = analytics_source_click_daily.exposure_session_count + excluded.exposure_session_count,
  updated_at = datetime('now');

DELETE FROM analytics_source_click_daily
WHERE source_channel != 'ad'
  AND EXISTS (
    SELECT 1
    FROM analytics_tracking_sources AS source
    WHERE source.channel = 'ad'
      AND (source.slug = analytics_source_click_daily.source_name OR source.utm_source = analytics_source_click_daily.source_name)
  );

DELETE FROM analytics_invite_daily;

INSERT INTO analytics_invite_daily (
  date, invite_code_id, channel, landing_count, visitor_count, session_count,
  register_count, contact_click_count, membership_grant_count, created_at, updated_at
)
WITH invite_sessions AS (
  SELECT
    date,
    invite_code_id,
    COUNT(DISTINCT visitor_id) AS visitor_count,
    COUNT(DISTINCT session_id) AS session_count
  FROM analytics_session_summaries
  WHERE invite_code_id != ''
  GROUP BY date, invite_code_id
),
invite_contacts AS (
  SELECT
    date(datetime(event.occurred_at, '+8 hours')) AS date,
    summary.invite_code_id,
    COUNT(*) AS contact_click_count
  FROM analytics_events AS event
  JOIN analytics_session_summaries AS summary
    ON summary.session_id = event.session_id
  WHERE event.event_name = 'contact_method_click'
    AND summary.invite_code_id != ''
  GROUP BY date(datetime(event.occurred_at, '+8 hours')), summary.invite_code_id
),
invite_registers AS (
  SELECT
    date(datetime(registered_at, '+8 hours')) AS date,
    invite_code_id,
    COUNT(*) AS register_count
  FROM invite_registrations
  GROUP BY date, invite_code_id
),
invite_memberships AS (
  SELECT
    date(datetime(first_membership_granted_at, '+8 hours')) AS date,
    invite_code_id,
    COUNT(*) AS membership_grant_count
  FROM invite_registrations
  WHERE first_membership_granted_at IS NOT NULL
  GROUP BY date, invite_code_id
),
ids AS (
  SELECT date, invite_code_id FROM invite_sessions
  UNION
  SELECT date, invite_code_id FROM invite_contacts
  UNION
  SELECT date, invite_code_id FROM invite_registers
  UNION
  SELECT date, invite_code_id FROM invite_memberships
)
SELECT
  ids.date,
  ids.invite_code_id,
  COALESCE(code.channel, ''),
  COALESCE(sessions.session_count, 0),
  COALESCE(sessions.visitor_count, 0),
  COALESCE(sessions.session_count, 0),
  COALESCE(registers.register_count, 0),
  COALESCE(contacts.contact_click_count, 0),
  COALESCE(memberships.membership_grant_count, 0),
  datetime('now'),
  datetime('now')
FROM ids
LEFT JOIN invite_codes AS code
  ON code.id = ids.invite_code_id
LEFT JOIN invite_sessions AS sessions
  ON sessions.date = ids.date
 AND sessions.invite_code_id = ids.invite_code_id
LEFT JOIN invite_registers AS registers
  ON registers.date = ids.date
 AND registers.invite_code_id = ids.invite_code_id
LEFT JOIN invite_contacts AS contacts
  ON contacts.date = ids.date
 AND contacts.invite_code_id = ids.invite_code_id
LEFT JOIN invite_memberships AS memberships
  ON memberships.date = ids.date
 AND memberships.invite_code_id = ids.invite_code_id;

PRAGMA defer_foreign_keys = false;
