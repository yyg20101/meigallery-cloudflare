-- 数据分析日报聚合表。
-- 所有主要维度使用 NOT NULL 默认空字符串，确保唯一索引可用于幂等 upsert。

CREATE TABLE IF NOT EXISTS analytics_daily_sources (
  date TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  invite_code_id TEXT NOT NULL DEFAULT '',
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  gallery_detail_count INTEGER NOT NULL DEFAULT 0,
  contact_click_count INTEGER NOT NULL DEFAULT 0,
  register_count INTEGER NOT NULL DEFAULT 0,
  invite_register_count INTEGER NOT NULL DEFAULT 0,
  membership_grant_count INTEGER NOT NULL DEFAULT 0,
  active_seconds_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_daily_sources_unique
  ON analytics_daily_sources(date, source_channel, source_name, invite_code_id);

CREATE TABLE IF NOT EXISTS analytics_daily_pages (
  date TEXT NOT NULL,
  route_name TEXT NOT NULL,
  path TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'page',
  entity_id TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  page_view_count INTEGER NOT NULL DEFAULT 0,
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  exit_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  active_seconds_total INTEGER NOT NULL DEFAULT 0,
  max_scroll_depth INTEGER NOT NULL DEFAULT 0,
  register_count INTEGER NOT NULL DEFAULT 0,
  contact_click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (max_scroll_depth >= 0 AND max_scroll_depth <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_daily_pages_unique
  ON analytics_daily_pages(date, route_name, path, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS analytics_daily_events (
  date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'system',
  entity_id TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL DEFAULT 0,
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  user_count INTEGER NOT NULL DEFAULT 0,
  value_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_daily_events_unique
  ON analytics_daily_events(date, event_name, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS analytics_path_edges (
  date TEXT NOT NULL,
  from_route TEXT NOT NULL,
  to_route TEXT NOT NULL,
  from_path TEXT NOT NULL DEFAULT '',
  to_path TEXT NOT NULL DEFAULT '',
  transition_count INTEGER NOT NULL DEFAULT 0,
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  conversion_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_path_edges_unique
  ON analytics_path_edges(date, from_route, to_route);

CREATE TABLE IF NOT EXISTS analytics_invite_daily (
  date TEXT NOT NULL,
  invite_code_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  landing_count INTEGER NOT NULL DEFAULT 0,
  visitor_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  register_count INTEGER NOT NULL DEFAULT 0,
  contact_click_count INTEGER NOT NULL DEFAULT 0,
  membership_grant_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_invite_daily_unique
  ON analytics_invite_daily(date, invite_code_id);

CREATE TABLE IF NOT EXISTS analytics_click_daily (
  date TEXT NOT NULL,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_click_daily_unique
  ON analytics_click_daily(date, element_id, location, target_type, target_id);
