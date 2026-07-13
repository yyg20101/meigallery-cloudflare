PRAGMA defer_foreign_keys = true;

DROP INDEX idx_users_meta_external_id;
ALTER TABLE users RENAME COLUMN meta_external_id TO conversion_external_id;
CREATE UNIQUE INDEX idx_users_conversion_external_id
  ON users(conversion_external_id)
  WHERE conversion_external_id IS NOT NULL AND conversion_external_id <> '';

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN has_ttclid INTEGER NOT NULL DEFAULT 0 CHECK (has_ttclid IN (0, 1));
ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN has_ttp INTEGER NOT NULL DEFAULT 0 CHECK (has_ttp IN (0, 1));

CREATE TABLE ad_platform_secure_outbox (
  delivery_id TEXT PRIMARY KEY REFERENCES analytics_conversion_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(provider) BETWEEN 2 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
  CHECK (schema_version = 2)
);

INSERT INTO ad_platform_secure_outbox (
  delivery_id, provider, schema_version, key_id, iv, ciphertext, tag,
  expires_at, created_at, updated_at
)
SELECT
  o.delivery_id, 'meta', o.schema_version, o.key_id, o.iv, o.ciphertext, o.tag,
  o.expires_at, o.created_at, o.updated_at
FROM meta_capi_secure_outbox o
JOIN analytics_conversion_deliveries d ON d.id = o.delivery_id
WHERE d.provider = 'meta' AND d.transport = 'server';

DROP TABLE meta_capi_secure_outbox;

CREATE INDEX idx_ad_platform_secure_outbox_provider_expiry
  ON ad_platform_secure_outbox(provider, expires_at);

CREATE TABLE tiktok_connection_verifications (
  environment TEXT PRIMARY KEY,
  pixel_id TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  revision TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment = 'production'),
  CHECK (length(pixel_id) BETWEEN 10 AND 30 AND pixel_id NOT GLOB '*[^A-Z0-9]*'),
  CHECK (length(credential_fingerprint) = 64 AND credential_fingerprint NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(revision) = 32 AND revision NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX idx_tiktok_connection_verifications_revision
  ON tiktok_connection_verifications(revision);

UPDATE ad_platform_connections
SET credential_secret_name = 'TIKTOK_EVENTS_ACCESS_TOKEN', updated_at = datetime('now')
WHERE provider = 'tiktok';

PRAGMA defer_foreign_keys = false;
