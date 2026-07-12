PRAGMA defer_foreign_keys = true;

CREATE TABLE ad_platform_connections (
  provider TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'disabled',
  browser_enabled INTEGER NOT NULL DEFAULT 0,
  server_enabled INTEGER NOT NULL DEFAULT 0,
  destination_id TEXT NOT NULL DEFAULT '',
  debug_enabled INTEGER NOT NULL DEFAULT 0,
  rollout_percentage INTEGER NOT NULL DEFAULT 0,
  credential_secret_name TEXT NOT NULL DEFAULT '',
  revision TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(provider) BETWEEN 2 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
  CHECK (enabled IN (0, 1)),
  CHECK (mode IN ('disabled', 'test', 'production')),
  CHECK (browser_enabled IN (0, 1)),
  CHECK (server_enabled IN (0, 1)),
  CHECK (debug_enabled IN (0, 1)),
  CHECK (rollout_percentage IN (0, 10, 50, 100)),
  CHECK (
    revision IS NULL
    OR (length(revision) = 32 AND revision NOT GLOB '*[^0-9a-f]*')
  )
);

INSERT INTO ad_platform_connections (
  provider, enabled, mode, browser_enabled, server_enabled, destination_id,
  debug_enabled, rollout_percentage, credential_secret_name, revision
)
SELECT
  'meta',
  CASE WHEN COALESCE((SELECT value FROM site_settings WHERE key = 'facebook_pixel_enabled'), 'false') = 'true'
    OR COALESCE((SELECT value FROM site_settings WHERE key = 'meta_capi_enabled'), 'false') = 'true'
    THEN 1 ELSE 0 END,
  CASE COALESCE(json_extract((SELECT value FROM site_settings WHERE key = 'meta_tracking_mode'), '$'), 'disabled')
    WHEN 'test' THEN 'test'
    WHEN 'production' THEN 'production'
    ELSE 'disabled' END,
  CASE WHEN COALESCE((SELECT value FROM site_settings WHERE key = 'facebook_pixel_enabled'), 'false') = 'true'
    THEN 1 ELSE 0 END,
  CASE WHEN COALESCE((SELECT value FROM site_settings WHERE key = 'meta_capi_enabled'), 'false') = 'true'
    THEN 1 ELSE 0 END,
  COALESCE(json_extract((SELECT value FROM site_settings WHERE key = 'facebook_pixel_id'), '$'), ''),
  CASE WHEN COALESCE((SELECT value FROM site_settings WHERE key = 'facebook_pixel_debug_enabled'), 'false') = 'true'
    THEN 1 ELSE 0 END,
  CASE CAST(COALESCE((SELECT value FROM site_settings WHERE key = 'meta_capi_rollout_percentage'), '0') AS INTEGER)
    WHEN 10 THEN 10 WHEN 50 THEN 50 WHEN 100 THEN 100 ELSE 0 END,
  'META_CAPI_ACCESS_TOKEN',
  (SELECT revision FROM meta_connection_verifications WHERE environment = 'production' LIMIT 1);

DROP TABLE meta_capi_secure_outbox;

CREATE TABLE analytics_conversion_deliveries_clean (
  id TEXT PRIMARY KEY,
  conversion_action_id TEXT NOT NULL REFERENCES analytics_conversion_actions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  has_fbp INTEGER NOT NULL DEFAULT 0,
  has_fbc INTEGER NOT NULL DEFAULT 0,
  has_email INTEGER NOT NULL DEFAULT 0,
  has_external_id INTEGER NOT NULL DEFAULT 0,
  tracking_mode TEXT NOT NULL DEFAULT 'disabled',
  connection_revision TEXT,
  encryption_key_id TEXT NOT NULL DEFAULT '',
  rollout_target_percentage INTEGER NOT NULL DEFAULT 0,
  rollout_effective_percentage INTEGER NOT NULL DEFAULT 0,
  rollout_bucket INTEGER,
  queue_enqueued_at TEXT,
  queue_attempt_count INTEGER NOT NULL DEFAULT 0,
  duplicate_suppressed_at TEXT,
  delivery_lease_token TEXT NOT NULL DEFAULT '',
  delivery_lease_expires_at TEXT,
  last_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(provider) BETWEEN 2 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
  CHECK (transport IN ('browser', 'server')),
  CHECK (status IN ('pending', 'attempted', 'sent', 'failed', 'skipped', 'duplicate_suppressed')),
  CHECK (has_fbp IN (0, 1)),
  CHECK (has_fbc IN (0, 1)),
  CHECK (has_email IN (0, 1)),
  CHECK (has_external_id IN (0, 1)),
  CHECK (tracking_mode IN ('disabled', 'test', 'production')),
  CHECK (connection_revision IS NULL OR (length(connection_revision) = 32 AND connection_revision NOT GLOB '*[^0-9a-f]*')),
  CHECK (rollout_target_percentage IN (0, 10, 50, 100)),
  CHECK (rollout_effective_percentage IN (0, 10, 50, 100)),
  CHECK (rollout_bucket IS NULL OR (typeof(rollout_bucket) = 'integer' AND rollout_bucket BETWEEN 0 AND 99)),
  CHECK (queue_attempt_count >= 0),
  CHECK (delivery_lease_token = '' OR (length(delivery_lease_token) = 32 AND delivery_lease_token NOT GLOB '*[^0-9a-f]*'))
);

DROP TABLE analytics_conversion_deliveries;
ALTER TABLE analytics_conversion_deliveries_clean RENAME TO analytics_conversion_deliveries;

CREATE UNIQUE INDEX idx_conversion_delivery_provider_external
  ON analytics_conversion_deliveries(provider, transport, external_event_id);
CREATE UNIQUE INDEX idx_conversion_delivery_action_destination
  ON analytics_conversion_deliveries(conversion_action_id, provider, transport);
CREATE INDEX idx_conversion_delivery_provider_status
  ON analytics_conversion_deliveries(provider, transport, status, updated_at);
CREATE INDEX idx_conversion_delivery_lease_expiry
  ON analytics_conversion_deliveries(provider, transport, delivery_lease_expires_at)
  WHERE delivery_lease_token <> '';

CREATE TABLE meta_capi_secure_outbox (
  delivery_id TEXT PRIMARY KEY REFERENCES analytics_conversion_deliveries(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (schema_version = 2)
);
CREATE INDEX idx_meta_capi_secure_outbox_expiry ON meta_capi_secure_outbox(expires_at);

DROP TABLE analytics_conversion_delivery_daily;
CREATE TABLE analytics_conversion_delivery_daily (
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT NOT NULL DEFAULT '',
  delivery_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, provider, transport, event_name, status, skip_reason),
  CHECK (length(provider) BETWEEN 2 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
  CHECK (transport IN ('browser', 'server'))
);
CREATE INDEX idx_conversion_delivery_daily_provider_date
  ON analytics_conversion_delivery_daily(provider, transport, date);

DELETE FROM site_settings
WHERE key IN (
  'facebook_pixel_enabled',
  'facebook_pixel_id',
  'facebook_pixel_debug_enabled',
  'meta_tracking_mode',
  'meta_capi_enabled',
  'meta_capi_rollout_percentage',
  'meta_capi_test_event_enabled'
);

PRAGMA defer_foreign_keys = false;
