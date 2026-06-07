-- 数据分析核心表：匿名访客、会话、页面摘要、session 摘要、采样事件和采集健康。
-- 默认只保存低成本事实与摘要，高频曝光/心跳后续由服务层归并后写入。

CREATE TABLE IF NOT EXISTS analytics_visitors (
  id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_source_channel TEXT NOT NULL DEFAULT 'unknown',
  first_source_name TEXT NOT NULL DEFAULT '',
  first_landing_path TEXT NOT NULL DEFAULT '/',
  first_invite_code_id TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  consent_state TEXT NOT NULL DEFAULT 'limited',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (consent_state IN ('granted', 'limited', 'denied'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_visitors_user ON analytics_visitors(user_id);

CREATE TABLE IF NOT EXISTS analytics_sessions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  entry_path TEXT NOT NULL DEFAULT '/',
  exit_path TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  invite_code_id TEXT,
  device_type TEXT NOT NULL DEFAULT 'unknown',
  country TEXT NOT NULL DEFAULT '',
  active_seconds INTEGER NOT NULL DEFAULT 0,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (device_type IN ('desktop', 'tablet', 'mobile', 'unknown')),
  CHECK (active_seconds >= 0),
  CHECK (page_view_count >= 0),
  CHECK (event_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_started_source ON analytics_sessions(started_at, source_channel);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_visitor_started ON analytics_sessions(visitor_id, started_at);

CREATE TABLE IF NOT EXISTS analytics_page_summaries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  route_name TEXT NOT NULL,
  path TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT 'page',
  entity_id TEXT NOT NULL DEFAULT '',
  first_viewed_at TEXT NOT NULL,
  last_left_at TEXT,
  page_view_count INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  max_scroll_depth INTEGER NOT NULL DEFAULT 0,
  is_entry INTEGER NOT NULL DEFAULT 0,
  is_exit INTEGER NOT NULL DEFAULT 0,
  is_bounce INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (page_view_count >= 0),
  CHECK (active_seconds >= 0),
  CHECK (max_scroll_depth >= 0 AND max_scroll_depth <= 100),
  CHECK (is_entry IN (0, 1)),
  CHECK (is_exit IN (0, 1)),
  CHECK (is_bounce IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_page_summaries_unique
  ON analytics_page_summaries(session_id, route_name, path, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_analytics_page_summaries_date_route
  ON analytics_page_summaries(date, route_name);
CREATE INDEX IF NOT EXISTS idx_analytics_page_summaries_session
  ON analytics_page_summaries(session_id);

CREATE TABLE IF NOT EXISTS analytics_session_summaries (
  session_id TEXT PRIMARY KEY REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  invite_code_id TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT 'unknown',
  country TEXT NOT NULL DEFAULT '',
  entry_path TEXT NOT NULL DEFAULT '/',
  exit_path TEXT NOT NULL DEFAULT '',
  page_view_count INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  contact_click_count INTEGER NOT NULL DEFAULT 0,
  register_success_count INTEGER NOT NULL DEFAULT 0,
  membership_grant_count INTEGER NOT NULL DEFAULT 0,
  is_bounce INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (device_type IN ('desktop', 'tablet', 'mobile', 'unknown')),
  CHECK (page_view_count >= 0),
  CHECK (active_seconds >= 0),
  CHECK (click_count >= 0),
  CHECK (contact_click_count >= 0),
  CHECK (register_success_count >= 0),
  CHECK (membership_grant_count >= 0),
  CHECK (is_bounce IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_analytics_session_summaries_date_source
  ON analytics_session_summaries(date, source_channel);
CREATE INDEX IF NOT EXISTS idx_analytics_session_summaries_invite
  ON analytics_session_summaries(invite_code_id, date);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  route_name TEXT NOT NULL,
  path TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  device_type TEXT NOT NULL DEFAULT 'unknown',
  country TEXT NOT NULL DEFAULT '',
  app_env TEXT NOT NULL DEFAULT 'production',
  consent_state TEXT NOT NULL DEFAULT 'limited',
  entity_type TEXT NOT NULL DEFAULT 'system',
  entity_id TEXT NOT NULL DEFAULT '',
  event_props TEXT NOT NULL DEFAULT '{}',
  value REAL,
  dedupe_key TEXT NOT NULL DEFAULT '',
  sampled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (device_type IN ('desktop', 'tablet', 'mobile', 'unknown')),
  CHECK (consent_state IN ('granted', 'limited', 'denied')),
  CHECK (sampled IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_name_occurred
  ON analytics_events(event_name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_occurred
  ON analytics_events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_entity_occurred
  ON analytics_events(entity_type, entity_id, occurred_at);

CREATE TABLE IF NOT EXISTS analytics_ingest_health_daily (
  date TEXT PRIMARY KEY,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  sensitive_blocked_count INTEGER NOT NULL DEFAULT 0,
  sampled_count INTEGER NOT NULL DEFAULT 0,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  estimated_rows_read INTEGER NOT NULL DEFAULT 0,
  estimated_rows_written INTEGER NOT NULL DEFAULT 0,
  max_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_ingested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (accepted_count >= 0),
  CHECK (rejected_count >= 0),
  CHECK (duplicate_count >= 0),
  CHECK (sensitive_blocked_count >= 0),
  CHECK (sampled_count >= 0),
  CHECK (dropped_count >= 0),
  CHECK (estimated_rows_read >= 0),
  CHECK (estimated_rows_written >= 0),
  CHECK (max_duration_ms >= 0)
);

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('analytics_enabled', 'false', datetime('now')),
  ('analytics_sample_rate', '0.01', datetime('now')),
  ('analytics_consent_mode', '"limited"', datetime('now'));
