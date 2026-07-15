CREATE TABLE attribution_platform_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'disabled',
  browser_enabled INTEGER NOT NULL DEFAULT 0,
  server_enabled INTEGER NOT NULL DEFAULT 0,
  public_config_json TEXT NOT NULL,
  attribution_window_days INTEGER NOT NULL DEFAULT 30,
  rollout_target_percentage INTEGER NOT NULL DEFAULT 0,
  rollout_effective_percentage INTEGER NOT NULL DEFAULT 0,
  connection_revision TEXT NOT NULL,
  credential_revision TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (enabled IN (0, 1)),
  CHECK (mode IN ('disabled', 'test', 'production')),
  CHECK (browser_enabled IN (0, 1)),
  CHECK (server_enabled IN (0, 1)),
  CHECK (attribution_window_days > 0),
  CHECK (rollout_target_percentage BETWEEN 0 AND 100),
  CHECK (rollout_effective_percentage BETWEEN 0 AND 100)
);

CREATE TABLE attribution_event_bindings (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  browser_destination TEXT NOT NULL DEFAULT '',
  server_destination TEXT NOT NULL DEFAULT '',
  mapping_revision TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, canonical_event),
  CHECK (enabled IN (0, 1))
);

CREATE TABLE attribution_credentials (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  credential_revision TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, credential_type, credential_revision)
);

CREATE TABLE attribution_conversion_facts (
  id TEXT PRIMARY KEY,
  canonical_event TEXT NOT NULL,
  fact_origin TEXT NOT NULL,
  external_event_id TEXT UNIQUE,
  attribution_provider TEXT,
  attribution_source TEXT NOT NULL,
  attribution_context_id TEXT,
  occurred_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  consent_snapshot_json TEXT NOT NULL,
  analytics_dimensions_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (fact_origin IN ('live', 'historical_backfill')),
  CHECK (
    (fact_origin = 'live' AND external_event_id IS NOT NULL)
    OR (fact_origin = 'historical_backfill' AND external_event_id IS NULL)
  )
);

CREATE TABLE attribution_deliveries (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES attribution_conversion_facts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
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
  CHECK (transport IN ('browser', 'server')),
  CHECK (status IN ('planned', 'queued', 'accepted', 'processed', 'retrying', 'rejected', 'dead_letter', 'cancelled')),
  CHECK (attempt_count >= 0),
  CHECK (queue_attempt_count >= 0)
);

CREATE TABLE attribution_outbox (
  delivery_id TEXT PRIMARY KEY REFERENCES attribution_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_provider_receipts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES attribution_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_verifications (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  credential_revision TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (attempt > 0)
);

CREATE TABLE attribution_incidents (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
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

CREATE TABLE attribution_quality_snapshots (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  canonical_event TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value TEXT,
  collection_status TEXT NOT NULL,
  error_category TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_usage_daily (
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  queue_operations INTEGER NOT NULL DEFAULT 0,
  d1_reads INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0,
  workflow_steps INTEGER NOT NULL DEFAULT 0,
  server_conversion_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, provider),
  CHECK (worker_requests >= 0),
  CHECK (queue_operations >= 0),
  CHECK (d1_reads >= 0),
  CHECK (d1_writes >= 0),
  CHECK (workflow_steps >= 0),
  CHECK (server_conversion_count >= 0)
);

CREATE INDEX idx_attribution_event_bindings_connection
  ON attribution_event_bindings(connection_id, provider, canonical_event);
CREATE INDEX idx_attribution_credentials_connection
  ON attribution_credentials(connection_id, provider, credential_type, updated_at);
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
CREATE INDEX idx_attribution_verifications_connection
  ON attribution_verifications(connection_id, provider, status, updated_at);
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
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM attribution_conversion_facts f
    JOIN attribution_platform_connections c ON c.id = NEW.connection_id
    WHERE f.id = NEW.fact_id
      AND f.attribution_provider = NEW.provider
      AND c.provider = NEW.provider
  ) THEN RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH') END;
END;

CREATE TRIGGER attribution_delivery_provider_update_guard
BEFORE UPDATE OF fact_id, connection_id, provider ON attribution_deliveries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM attribution_conversion_facts f
    JOIN attribution_platform_connections c ON c.id = NEW.connection_id
    WHERE f.id = NEW.fact_id
      AND f.attribution_provider = NEW.provider
      AND c.provider = NEW.provider
  ) THEN RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH') END;
END;

CREATE TRIGGER attribution_outbox_provider_guard
BEFORE INSERT ON attribution_outbox
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM attribution_deliveries d
    WHERE d.id = NEW.delivery_id AND d.provider = NEW.provider
  ) THEN RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH') END;
END;

CREATE TRIGGER attribution_outbox_provider_update_guard
BEFORE UPDATE OF delivery_id, provider ON attribution_outbox
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM attribution_deliveries d
    WHERE d.id = NEW.delivery_id AND d.provider = NEW.provider
  ) THEN RAISE(ABORT, 'ATTRIBUTION_PROVIDER_MISMATCH') END;
END;
