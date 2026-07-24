PRAGMA foreign_keys = ON;

CREATE TABLE attribution_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  active_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX attribution_connections_provider_name
  ON attribution_connections(provider, name);

CREATE UNIQUE INDEX attribution_connections_one_default
  ON attribution_connections(provider)
  WHERE is_default = 1;

CREATE TABLE attribution_connection_versions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  base_active_version_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'candidate',
      'validating',
      'ready',
      'active',
      'draining',
      'failed',
      'superseded',
      'retired'
    )
  ),
  public_config_json TEXT NOT NULL CHECK (json_valid(public_config_json)),
  config_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  validated_at TEXT,
  activated_at TEXT,
  draining_at TEXT,
  retired_at TEXT,
  failure_code TEXT NOT NULL DEFAULT ''
);

CREATE INDEX attribution_versions_connection_status
  ON attribution_connection_versions(connection_id, status);

CREATE UNIQUE INDEX attribution_versions_one_live_candidate
  ON attribution_connection_versions(connection_id)
  WHERE status IN ('candidate','validating','ready');

CREATE TABLE attribution_version_credentials (
  version_id TEXT PRIMARY KEY
    REFERENCES attribution_connection_versions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  destroy_after TEXT
);

CREATE TABLE attribution_version_bindings (
  version_id TEXT NOT NULL
    REFERENCES attribution_connection_versions(id) ON DELETE CASCADE,
  canonical_event TEXT NOT NULL CHECK (
    canonical_event IN ('Contact','CompleteRegistration')
  ),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  browser_destination TEXT NOT NULL,
  server_destination TEXT NOT NULL,
  PRIMARY KEY (version_id, canonical_event)
);

CREATE TABLE attribution_runtime_policies (
  connection_id TEXT PRIMARY KEY
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  browser_enabled INTEGER NOT NULL CHECK (browser_enabled IN (0,1)),
  server_enabled INTEGER NOT NULL CHECK (server_enabled IN (0,1)),
  server_target_percentage INTEGER NOT NULL CHECK (
    server_target_percentage IN (0,10,50,100)
  ),
  server_effective_percentage INTEGER NOT NULL CHECK (
    server_effective_percentage IN (0,10,50,100)
  ),
  circuit_state TEXT NOT NULL CHECK (
    circuit_state IN ('closed','server_open')
  ),
  runtime_generation INTEGER NOT NULL DEFAULT 1 CHECK (runtime_generation > 0),
  updated_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_activation_fences (
  connection_id TEXT PRIMARY KEY
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  candidate_version_id TEXT NOT NULL
    REFERENCES attribution_connection_versions(id) ON DELETE CASCADE,
  expected_active_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER attribution_activation_fence_validate
BEFORE INSERT ON attribution_activation_fences
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM attribution_connections AS connection
      INNER JOIN attribution_connection_versions AS candidate
        ON candidate.id = NEW.candidate_version_id
       AND candidate.connection_id = connection.id
      WHERE connection.id = NEW.connection_id
        AND NEW.expected_active_version_id IS connection.active_version_id
        AND candidate.provider = connection.provider
        AND (
          connection.active_version_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM attribution_connection_versions AS current_active
            WHERE current_active.id = connection.active_version_id
              AND current_active.connection_id = connection.id
              AND current_active.provider = connection.provider
              AND current_active.status = 'active'
          )
        )
        AND (
          (
            candidate.status = 'ready'
            AND candidate.base_active_version_id IS connection.active_version_id
          )
          OR (
            candidate.status = 'draining'
            AND connection.active_version_id IS NOT NULL
          )
        )
    )
    THEN RAISE(ABORT, 'ATTRIBUTION_ACTIVE_VERSION_CHANGED')
  END;
END;

CREATE TABLE attribution_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX attribution_audit_logs_connection_created
  ON attribution_audit_logs(connection_id, created_at DESC);

CREATE TABLE attribution_incidents (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  connection_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  code TEXT NOT NULL,
  affected_transport TEXT NOT NULL,
  affected_fact_count INTEGER NOT NULL DEFAULT 0
    CHECK (affected_fact_count >= 0),
  affected_delivery_count INTEGER NOT NULL DEFAULT 0
    CHECK (affected_delivery_count >= 0),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution TEXT NOT NULL DEFAULT ''
);

CREATE INDEX attribution_incidents_status_detected
  ON attribution_incidents(status, detected_at DESC);

CREATE INDEX attribution_incidents_connection_status
  ON attribution_incidents(connection_id, status);
