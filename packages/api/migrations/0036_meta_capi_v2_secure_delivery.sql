ALTER TABLE users ADD COLUMN meta_external_id TEXT;

UPDATE users
SET meta_external_id = lower(hex(randomblob(16)))
WHERE meta_external_id IS NULL OR meta_external_id = '';

CREATE UNIQUE INDEX idx_users_meta_external_id
  ON users(meta_external_id)
  WHERE meta_external_id IS NOT NULL AND meta_external_id <> '';

CREATE TABLE meta_connection_verifications (
  environment TEXT PRIMARY KEY,
  pixel_id TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  graph_api_version TEXT NOT NULL,
  verified_event_name TEXT NOT NULL,
  verified_commit TEXT NOT NULL,
  dataset_quality_status TEXT NOT NULL DEFAULT 'not_checked',
  verified_at TEXT NOT NULL,
  verified_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (graph_api_version = 'v25.0'),
  CHECK (verified_event_name IN ('Contact', 'CompleteRegistration')),
  CHECK (length(verified_commit) = 40 AND verified_commit NOT GLOB '*[^0-9A-Fa-f]*'),
  CHECK (dataset_quality_status IN ('not_checked', 'available', 'permission_denied', 'error'))
);

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

CREATE INDEX idx_meta_capi_secure_outbox_expiry
  ON meta_capi_secure_outbox(expires_at);

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN has_email INTEGER NOT NULL DEFAULT 0 CHECK (has_email IN (0, 1));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN has_external_id INTEGER NOT NULL DEFAULT 0 CHECK (has_external_id IN (0, 1));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN encryption_key_id TEXT NOT NULL DEFAULT '';
