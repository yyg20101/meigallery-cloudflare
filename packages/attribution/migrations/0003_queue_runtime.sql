PRAGMA foreign_keys = ON;

CREATE TABLE attribution_delivery_receipts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL
    REFERENCES attribution_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  classification TEXT NOT NULL CHECK (
    classification IN (
      'accepted',
      'processed',
      'retryable',
      'rejected',
      'credential_invalid',
      'destination_invalid'
    )
  ),
  http_status INTEGER CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  request_id TEXT NOT NULL DEFAULT '' CHECK (length(request_id) <= 160),
  provider_code INTEGER,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (delivery_id, attempt_count)
);

CREATE INDEX attribution_delivery_receipts_provider_created
  ON attribution_delivery_receipts(provider, created_at DESC);

CREATE TABLE attribution_circuit_observations (
  connection_id TEXT PRIMARY KEY
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  consecutive_transient_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_transient_failures >= 0),
  window_started_at TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  opened_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    consecutive_transient_failures = 0
    OR (
      window_started_at IS NOT NULL
      AND last_failure_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX attribution_incidents_one_open_server_code
  ON attribution_incidents(connection_id, provider, code, affected_transport)
  WHERE status = 'open' AND connection_id IS NOT NULL;
