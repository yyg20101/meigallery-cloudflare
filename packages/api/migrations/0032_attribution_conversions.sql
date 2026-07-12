CREATE TABLE IF NOT EXISTS analytics_conversion_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  date TEXT NOT NULL,
  visitor_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  tracking_source_slug TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  method_type TEXT NOT NULL DEFAULT '',
  action_target TEXT NOT NULL DEFAULT '',
  route_name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  duplicate_of TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (action_type IN ('contact', 'lead', 'complete_registration', 'start_trial', 'membership_grant'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_conversion_actions_date_source
  ON analytics_conversion_actions(date, source_channel, source_name);
CREATE INDEX IF NOT EXISTS idx_analytics_conversion_actions_session
  ON analytics_conversion_actions(session_id, occurred_at);

CREATE TABLE IF NOT EXISTS analytics_conversion_deliveries (
  id TEXT PRIMARY KEY,
  conversion_action_id TEXT NOT NULL REFERENCES analytics_conversion_actions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('meta_pixel', 'meta_capi')),
  CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'duplicate_suppressed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_conversion_deliveries_external
  ON analytics_conversion_deliveries(channel, external_event_id);
CREATE INDEX IF NOT EXISTS idx_analytics_conversion_deliveries_status
  ON analytics_conversion_deliveries(status, updated_at);

CREATE TABLE IF NOT EXISTS analytics_conversion_daily (
  date TEXT NOT NULL,
  action_type TEXT NOT NULL,
  source_channel TEXT NOT NULL DEFAULT 'unknown',
  source_name TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  action_count INTEGER NOT NULL DEFAULT 0,
  unique_session_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, action_type, source_channel, source_name, utm_campaign, utm_content)
);

CREATE TABLE IF NOT EXISTS analytics_conversion_delivery_daily (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT NOT NULL DEFAULT '',
  delivery_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, channel, event_name, status, skip_reason)
);
