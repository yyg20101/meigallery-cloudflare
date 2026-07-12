PRAGMA defer_foreign_keys = true;

CREATE TABLE analytics_conversion_deliveries_v2 (
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
  has_fbp INTEGER NOT NULL DEFAULT 0,
  has_fbc INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('meta_pixel', 'meta_capi')),
  CHECK (status IN ('pending', 'attempted', 'sent', 'failed', 'skipped', 'duplicate_suppressed')),
  CHECK (has_fbp IN (0, 1)),
  CHECK (has_fbc IN (0, 1))
);

INSERT INTO analytics_conversion_deliveries_v2 (
  id,
  conversion_action_id,
  channel,
  external_event_id,
  event_name,
  status,
  skip_reason,
  error_code,
  error_message,
  attempt_count,
  has_fbp,
  has_fbc,
  last_attempt_at,
  sent_at,
  created_at,
  updated_at
)
SELECT
  id,
  conversion_action_id,
  channel,
  external_event_id,
  event_name,
  status,
  skip_reason,
  error_code,
  error_message,
  attempt_count,
  0,
  0,
  last_attempt_at,
  sent_at,
  created_at,
  updated_at
FROM analytics_conversion_deliveries;

DROP TABLE analytics_conversion_deliveries;
ALTER TABLE analytics_conversion_deliveries_v2 RENAME TO analytics_conversion_deliveries;

CREATE UNIQUE INDEX idx_analytics_conversion_deliveries_external
  ON analytics_conversion_deliveries(channel, external_event_id);
CREATE INDEX idx_analytics_conversion_deliveries_status
  ON analytics_conversion_deliveries(status, updated_at);

INSERT INTO site_settings (key, value, updated_at)
VALUES ('meta_tracking_mode', '"disabled"', datetime('now'))
ON CONFLICT(key) DO UPDATE SET
  value = CASE
    WHEN site_settings.value IN ('"test"', '"production"') THEN site_settings.value
    ELSE '"disabled"'
  END,
  updated_at = datetime('now');

CREATE TABLE IF NOT EXISTS analytics_release_verifications (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  environment TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (status IN ('passed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_release_verifications_lookup
  ON analytics_release_verifications(environment, verification_type, verified_at DESC);

PRAGMA defer_foreign_keys = false;
