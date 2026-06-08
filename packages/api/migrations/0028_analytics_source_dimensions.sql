-- 数据分析来源维度聚合表。
-- source_name 沿用历史列名，值语义为稳定来源 code；展示文案通过 analytics_tracking_sources 解析。

CREATE TABLE IF NOT EXISTS analytics_source_page_daily (
  date TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  invite_code_id TEXT NOT NULL DEFAULT '',
  route_name TEXT NOT NULL,
  path TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'page',
  entity_id TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  exit_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  active_seconds_total INTEGER NOT NULL DEFAULT 0,
  max_scroll_depth INTEGER NOT NULL DEFAULT 0,
  register_count INTEGER NOT NULL DEFAULT 0,
  contact_click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (max_scroll_depth >= 0 AND max_scroll_depth <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_source_page_daily_unique
  ON analytics_source_page_daily(
    date, source_channel, source_name, invite_code_id,
    route_name, path, entity_type, entity_id
  );

CREATE INDEX IF NOT EXISTS idx_analytics_source_page_daily_source
  ON analytics_source_page_daily(date, source_channel, source_name);

CREATE TABLE IF NOT EXISTS analytics_source_click_daily (
  date TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  invite_code_id TEXT NOT NULL DEFAULT '',
  element_id TEXT NOT NULL,
  element_type TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  raw_click_count INTEGER NOT NULL DEFAULT 0,
  effective_click_count INTEGER NOT NULL DEFAULT 0,
  duplicate_click_count INTEGER NOT NULL DEFAULT 0,
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  user_count INTEGER NOT NULL DEFAULT 0,
  exposure_session_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_source_click_daily_unique
  ON analytics_source_click_daily(
    date, source_channel, source_name, invite_code_id,
    element_id, location, target_type, target_id
  );

CREATE INDEX IF NOT EXISTS idx_analytics_source_click_daily_source
  ON analytics_source_click_daily(date, source_channel, source_name);
