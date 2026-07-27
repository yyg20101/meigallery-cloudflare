PRAGMA defer_foreign_keys = ON;

CREATE TABLE analytics_visitors_next (
  id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_source_channel TEXT NOT NULL DEFAULT 'unknown',
  first_source_name TEXT NOT NULL DEFAULT '',
  first_landing_path TEXT NOT NULL DEFAULT '/',
  first_invite_code_id TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE analytics_sessions_next (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors_next(id) ON DELETE CASCADE,
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

CREATE TABLE analytics_page_summaries_next (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors_next(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES analytics_sessions_next(id) ON DELETE CASCADE,
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

CREATE TABLE analytics_session_summaries_next (
  session_id TEXT PRIMARY KEY REFERENCES analytics_sessions_next(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors_next(id) ON DELETE CASCADE,
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

CREATE TABLE analytics_events_next (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors_next(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES analytics_sessions_next(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  route_name TEXT NOT NULL,
  path TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  device_type TEXT NOT NULL DEFAULT 'unknown',
  country TEXT NOT NULL DEFAULT '',
  app_env TEXT NOT NULL DEFAULT 'production',
  entity_type TEXT NOT NULL DEFAULT 'system',
  entity_id TEXT NOT NULL DEFAULT '',
  event_props TEXT NOT NULL DEFAULT '{}',
  value REAL,
  dedupe_key TEXT NOT NULL DEFAULT '',
  sampled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (device_type IN ('desktop', 'tablet', 'mobile', 'unknown')),
  CHECK (sampled IN (0, 1))
);

CREATE TABLE invite_registrations_next (
  id TEXT PRIMARY KEY,
  invite_code_id TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors_next(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES analytics_sessions_next(id) ON DELETE CASCADE,
  invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL DEFAULT 'invite',
  landing_path TEXT NOT NULL DEFAULT '/',
  registered_at TEXT NOT NULL,
  first_membership_granted_at TEXT,
  first_membership_rank INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (invited_user_id),
  UNIQUE (invite_code_id, invited_user_id),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (first_membership_rank IS NULL OR first_membership_rank >= 0)
);

INSERT INTO analytics_visitors_next (
  id, first_seen_at, last_seen_at, first_source_channel, first_source_name,
  first_landing_path, first_invite_code_id, user_id, created_at, updated_at
)
SELECT
  id, first_seen_at, last_seen_at, first_source_channel, first_source_name,
  first_landing_path, first_invite_code_id, user_id, created_at, updated_at
FROM analytics_visitors;

INSERT INTO analytics_sessions_next SELECT * FROM analytics_sessions;

INSERT INTO analytics_page_summaries_next SELECT * FROM analytics_page_summaries;

INSERT INTO analytics_session_summaries_next SELECT * FROM analytics_session_summaries;

INSERT INTO analytics_events_next (
  id, event_name, occurred_at, received_at, visitor_id, session_id, user_id,
  route_name, path, page_title, referrer_host, source_channel, device_type,
  country, app_env, entity_type, entity_id, event_props, value, dedupe_key,
  sampled, created_at
)
SELECT
  id, event_name, occurred_at, received_at, visitor_id, session_id, user_id,
  route_name, path, page_title, referrer_host, source_channel, device_type,
  country, app_env, entity_type, entity_id, event_props, value, dedupe_key,
  sampled, created_at
FROM analytics_events;

INSERT INTO invite_registrations_next SELECT * FROM invite_registrations;

DROP TABLE invite_registrations;
DROP TABLE analytics_events;
DROP TABLE analytics_page_summaries;
DROP TABLE analytics_session_summaries;
DROP TABLE analytics_sessions;
DROP TABLE analytics_visitors;

ALTER TABLE analytics_visitors_next RENAME TO analytics_visitors;
ALTER TABLE analytics_sessions_next RENAME TO analytics_sessions;
ALTER TABLE analytics_page_summaries_next RENAME TO analytics_page_summaries;
ALTER TABLE analytics_session_summaries_next RENAME TO analytics_session_summaries;
ALTER TABLE analytics_events_next RENAME TO analytics_events;
ALTER TABLE invite_registrations_next RENAME TO invite_registrations;

CREATE INDEX idx_analytics_visitors_user ON analytics_visitors(user_id);
CREATE INDEX idx_analytics_sessions_started_source ON analytics_sessions(started_at, source_channel);
CREATE INDEX idx_analytics_sessions_visitor_started ON analytics_sessions(visitor_id, started_at);
CREATE UNIQUE INDEX idx_analytics_page_summaries_unique
  ON analytics_page_summaries(session_id, route_name, path, entity_type, entity_id);
CREATE INDEX idx_analytics_page_summaries_date_route
  ON analytics_page_summaries(date, route_name);
CREATE INDEX idx_analytics_page_summaries_session
  ON analytics_page_summaries(session_id);
CREATE INDEX idx_analytics_session_summaries_date_source
  ON analytics_session_summaries(date, source_channel);
CREATE INDEX idx_analytics_session_summaries_invite
  ON analytics_session_summaries(invite_code_id, date);
CREATE INDEX idx_analytics_events_name_occurred
  ON analytics_events(event_name, occurred_at);
CREATE INDEX idx_analytics_events_session_occurred
  ON analytics_events(session_id, occurred_at);
CREATE INDEX idx_analytics_events_entity_occurred
  ON analytics_events(entity_type, entity_id, occurred_at);
CREATE INDEX idx_invite_registrations_invite_registered
  ON invite_registrations(invite_code_id, registered_at);
CREATE INDEX idx_invite_registrations_user
  ON invite_registrations(invited_user_id);

DELETE FROM site_settings WHERE key = 'analytics_consent_mode';
DELETE FROM attribution_quality_snapshots
WHERE provider = 'meta' AND collection_status IN ('error', 'unavailable');

PRAGMA foreign_key_check;
