PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS attribution_fact_provider_immutable;
DROP TRIGGER IF EXISTS attribution_connection_provider_immutable;
DROP TRIGGER IF EXISTS attribution_delivery_provider_guard;
DROP TRIGGER IF EXISTS attribution_delivery_provider_update_guard;
DROP TRIGGER IF EXISTS attribution_outbox_provider_guard;
DROP TRIGGER IF EXISTS attribution_outbox_provider_update_guard;
DROP TRIGGER IF EXISTS attribution_fact_source_insert_guard;
DROP TRIGGER IF EXISTS attribution_fact_source_update_guard;

CREATE TABLE attribution_platform_connections_next (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  browser_enabled INTEGER NOT NULL DEFAULT 0,
  server_enabled INTEGER NOT NULL DEFAULT 0,
  public_config_json TEXT NOT NULL,
  outbox_scope TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (provider IN ('meta', 'tiktok', 'google')),
  CHECK (enabled IN (0, 1)),
  CHECK (browser_enabled IN (0, 1)),
  CHECK (server_enabled IN (0, 1))
);

INSERT INTO attribution_platform_connections_next (
  id, provider, enabled, browser_enabled, server_enabled,
  public_config_json, outbox_scope, created_at, updated_at
)
SELECT
  id, provider, enabled, browser_enabled, server_enabled,
  public_config_json, connection_revision, created_at, updated_at
FROM attribution_platform_connections;

CREATE TABLE attribution_event_bindings_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections_next(id) ON DELETE CASCADE,
  canonical_event TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  browser_destination TEXT NOT NULL DEFAULT '',
  server_destination TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, canonical_event),
  CHECK (canonical_event IN ('Contact', 'CompleteRegistration')),
  CHECK (enabled IN (0, 1))
);

INSERT INTO attribution_event_bindings_next (
  id, connection_id, canonical_event, enabled,
  browser_destination, server_destination, created_at, updated_at
)
SELECT
  id, connection_id, canonical_event, enabled,
  browser_destination, server_destination, created_at, updated_at
FROM attribution_event_bindings;

CREATE TABLE attribution_credentials_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections_next(id) ON DELETE CASCADE,
  credential_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  encryption_context TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, credential_type)
);

INSERT INTO attribution_credentials_next (
  id, connection_id, credential_type, schema_version, key_id,
  iv, ciphertext, tag, fingerprint, encryption_context,
  created_by, created_at, updated_at
)
SELECT
  credential.id,
  credential.connection_id,
  credential.credential_type,
  credential.schema_version,
  credential.key_id,
  credential.iv,
  credential.ciphertext,
  credential.tag,
  credential.fingerprint,
  credential.credential_revision,
  credential.created_by,
  credential.created_at,
  credential.updated_at
FROM attribution_credentials AS credential
WHERE credential.id = (
  SELECT latest.id
  FROM attribution_credentials AS latest
  WHERE latest.connection_id = credential.connection_id
    AND latest.credential_type = credential.credential_type
  ORDER BY latest.updated_at DESC, latest.id DESC
  LIMIT 1
);

CREATE TABLE attribution_conversion_facts_next (
  id TEXT PRIMARY KEY,
  canonical_event TEXT NOT NULL,
  fact_origin TEXT NOT NULL,
  external_event_id TEXT UNIQUE,
  attribution_provider TEXT,
  attribution_source TEXT NOT NULL,
  attribution_context_id TEXT,
  occurred_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  analytics_dimensions_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (canonical_event IN ('Contact', 'CompleteRegistration')),
  CHECK (attribution_provider IS NULL OR attribution_provider IN ('meta', 'tiktok', 'google')),
  CHECK (fact_origin IN ('live', 'historical_backfill')),
  CHECK (
    (fact_origin = 'live' AND external_event_id IS NOT NULL)
    OR (fact_origin = 'historical_backfill' AND external_event_id IS NULL)
  )
);

INSERT INTO attribution_conversion_facts_next (
  id, canonical_event, fact_origin, external_event_id,
  attribution_provider, attribution_source, attribution_context_id,
  occurred_at, dedupe_key, analytics_dimensions_json, created_at
)
SELECT
  id, canonical_event, fact_origin, external_event_id,
  attribution_provider, attribution_source, attribution_context_id,
  occurred_at, dedupe_key, analytics_dimensions_json, created_at
FROM attribution_conversion_facts;

CREATE TABLE attribution_deliveries_next (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES attribution_conversion_facts_next(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections_next(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  destination TEXT NOT NULL DEFAULT '',
  match_signals_json TEXT NOT NULL DEFAULT '[]',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queue_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  queued_at TEXT,
  accepted_at TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fact_id, provider, transport),
  CHECK (provider IN ('meta', 'tiktok', 'google')),
  CHECK (transport IN ('browser', 'server')),
  CHECK (status IN ('planned', 'queued', 'accepted', 'processed', 'retrying', 'rejected', 'dead_letter', 'cancelled')),
  CHECK (attempt_count >= 0),
  CHECK (queue_attempt_count >= 0)
);

INSERT INTO attribution_deliveries_next
SELECT * FROM attribution_deliveries;

CREATE TABLE attribution_outbox_next (
  delivery_id TEXT PRIMARY KEY REFERENCES attribution_deliveries_next(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (provider IN ('meta', 'tiktok', 'google'))
);

INSERT INTO attribution_outbox_next
SELECT * FROM attribution_outbox;

CREATE TABLE attribution_provider_receipts_next (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES attribution_deliveries_next(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (provider IN ('meta', 'tiktok', 'google'))
);

INSERT INTO attribution_provider_receipts_next
SELECT * FROM attribution_provider_receipts;

CREATE TABLE attribution_incidents_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES attribution_platform_connections_next(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO attribution_incidents_next
SELECT * FROM attribution_incidents;

CREATE TABLE attribution_quality_snapshots_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections_next(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value TEXT,
  collection_status TEXT NOT NULL,
  error_category TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO attribution_quality_snapshots_next
SELECT * FROM attribution_quality_snapshots;

DROP TABLE attribution_outbox;
DROP TABLE attribution_provider_receipts;
DROP TABLE attribution_deliveries;
DROP TABLE attribution_event_bindings;
DROP TABLE attribution_credentials;
DROP TABLE attribution_incidents;
DROP TABLE attribution_quality_snapshots;
DROP TABLE attribution_conversion_facts;
DROP TABLE attribution_platform_connections;

ALTER TABLE attribution_platform_connections_next RENAME TO attribution_platform_connections;
ALTER TABLE attribution_conversion_facts_next RENAME TO attribution_conversion_facts;
ALTER TABLE attribution_deliveries_next RENAME TO attribution_deliveries;
ALTER TABLE attribution_outbox_next RENAME TO attribution_outbox;
ALTER TABLE attribution_provider_receipts_next RENAME TO attribution_provider_receipts;
ALTER TABLE attribution_event_bindings_next RENAME TO attribution_event_bindings;
ALTER TABLE attribution_credentials_next RENAME TO attribution_credentials;
ALTER TABLE attribution_incidents_next RENAME TO attribution_incidents;
ALTER TABLE attribution_quality_snapshots_next RENAME TO attribution_quality_snapshots;

CREATE INDEX idx_attribution_event_bindings_connection
  ON attribution_event_bindings(connection_id, canonical_event);
CREATE INDEX idx_attribution_credentials_connection
  ON attribution_credentials(connection_id, credential_type, updated_at);
CREATE INDEX idx_attribution_conversion_facts_provider_occurred
  ON attribution_conversion_facts(attribution_provider, occurred_at);
CREATE INDEX idx_attribution_conversion_facts_context
  ON attribution_conversion_facts(attribution_context_id, occurred_at);
CREATE INDEX idx_attribution_deliveries_provider_status
  ON attribution_deliveries(provider, transport, status, updated_at);
CREATE INDEX idx_attribution_deliveries_connection
  ON attribution_deliveries(connection_id, status, updated_at);
CREATE INDEX idx_attribution_outbox_expiry
  ON attribution_outbox(expires_at);
CREATE INDEX idx_attribution_provider_receipts_delivery
  ON attribution_provider_receipts(delivery_id, provider, received_at);
CREATE INDEX idx_attribution_incidents_connection
  ON attribution_incidents(connection_id, provider, status, opened_at);
CREATE INDEX idx_attribution_quality_snapshots_connection
  ON attribution_quality_snapshots(connection_id, provider, canonical_event, collected_at);

CREATE TRIGGER attribution_fact_provider_immutable
BEFORE UPDATE OF attribution_provider ON attribution_conversion_facts
WHEN OLD.attribution_provider IS NOT NEW.attribution_provider
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_IMMUTABLE');
END;

CREATE TRIGGER attribution_connection_provider_immutable
BEFORE UPDATE OF provider ON attribution_platform_connections
WHEN OLD.provider IS NOT NEW.provider
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_IMMUTABLE');
END;

CREATE TRIGGER attribution_delivery_provider_guard
BEFORE INSERT ON attribution_deliveries
WHEN NOT EXISTS (
  SELECT 1
  FROM attribution_conversion_facts AS fact
  JOIN attribution_platform_connections AS connection
    ON connection.id = NEW.connection_id
  WHERE fact.id = NEW.fact_id
    AND fact.attribution_provider = NEW.provider
    AND connection.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH');
END;

CREATE TRIGGER attribution_delivery_provider_update_guard
BEFORE UPDATE OF fact_id, connection_id, provider ON attribution_deliveries
WHEN NOT EXISTS (
  SELECT 1
  FROM attribution_conversion_facts AS fact
  JOIN attribution_platform_connections AS connection
    ON connection.id = NEW.connection_id
  WHERE fact.id = NEW.fact_id
    AND fact.attribution_provider = NEW.provider
    AND connection.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH');
END;

CREATE TRIGGER attribution_outbox_provider_guard
BEFORE INSERT ON attribution_outbox
WHEN NOT EXISTS (
  SELECT 1
  FROM attribution_deliveries AS delivery
  WHERE delivery.id = NEW.delivery_id
    AND delivery.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH');
END;

CREATE TRIGGER attribution_outbox_provider_update_guard
BEFORE UPDATE OF delivery_id, provider ON attribution_outbox
WHEN NOT EXISTS (
  SELECT 1
  FROM attribution_deliveries AS delivery
  WHERE delivery.id = NEW.delivery_id
    AND delivery.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH');
END;

CREATE TRIGGER attribution_fact_source_insert_guard
BEFORE INSERT ON attribution_conversion_facts
WHEN (
  NEW.attribution_provider IS NULL
  AND NEW.attribution_source NOT IN ('none', 'conflict')
) OR (
  NEW.attribution_provider IS NOT NULL
  AND (
    NEW.attribution_provider NOT IN ('meta', 'tiktok', 'google')
    OR NEW.attribution_source NOT IN ('click_id', 'managed_link')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_FACT_SOURCE_INVALID');
END;

CREATE TRIGGER attribution_fact_source_update_guard
BEFORE UPDATE OF attribution_provider, attribution_source ON attribution_conversion_facts
WHEN (
  NEW.attribution_provider IS NULL
  AND NEW.attribution_source NOT IN ('none', 'conflict')
) OR (
  NEW.attribution_provider IS NOT NULL
  AND (
    NEW.attribution_provider NOT IN ('meta', 'tiktok', 'google')
    OR NEW.attribution_source NOT IN ('click_id', 'managed_link')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ATTRIBUTION_FACT_SOURCE_INVALID');
END;

DROP TABLE IF EXISTS attribution_privacy_policy;

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

PRAGMA foreign_key_check;
