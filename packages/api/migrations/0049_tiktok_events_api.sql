PRAGMA defer_foreign_keys = true;

ALTER TABLE users ADD COLUMN conversion_external_id TEXT;
UPDATE users
SET conversion_external_id = meta_external_id
WHERE conversion_external_id IS NULL OR conversion_external_id = '';
CREATE UNIQUE INDEX idx_users_conversion_external_id
  ON users(conversion_external_id)
  WHERE conversion_external_id IS NOT NULL AND conversion_external_id <> '';

-- Expand 阶段同时兼容当前 production Worker 与新 Worker，contract 阶段再删除旧列。
CREATE TRIGGER trg_0049_bridge_user_identity_insert
AFTER INSERT ON users
WHEN COALESCE(NEW.meta_external_id, '') <> COALESCE(NEW.conversion_external_id, '')
BEGIN
  UPDATE users
  SET
    meta_external_id = COALESCE(NULLIF(NEW.conversion_external_id, ''), NEW.meta_external_id),
    conversion_external_id = COALESCE(NULLIF(NEW.conversion_external_id, ''), NEW.meta_external_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_0049_bridge_user_identity_update
AFTER UPDATE OF meta_external_id, conversion_external_id ON users
WHEN COALESCE(NEW.meta_external_id, '') <> COALESCE(NEW.conversion_external_id, '')
BEGIN
  UPDATE users
  SET
    meta_external_id = CASE
      WHEN NEW.conversion_external_id IS NOT OLD.conversion_external_id THEN NEW.conversion_external_id
      ELSE NEW.meta_external_id
    END,
    conversion_external_id = CASE
      WHEN NEW.conversion_external_id IS NOT OLD.conversion_external_id THEN NEW.conversion_external_id
      ELSE NEW.meta_external_id
    END
  WHERE id = NEW.id;
END;

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

CREATE INDEX idx_ad_platform_secure_outbox_provider_expiry
  ON ad_platform_secure_outbox(provider, expires_at);

-- 两侧同步仅服务于 expand/rollback 窗口，不进入应用业务逻辑。
CREATE TRIGGER trg_0049_bridge_meta_outbox_legacy_insert
AFTER INSERT ON meta_capi_secure_outbox
BEGIN
  INSERT INTO ad_platform_secure_outbox (
    delivery_id, provider, schema_version, key_id, iv, ciphertext, tag,
    expires_at, created_at, updated_at
  )
  VALUES (
    NEW.delivery_id, 'meta', NEW.schema_version, NEW.key_id, NEW.iv, NEW.ciphertext, NEW.tag,
    NEW.expires_at, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT(delivery_id) DO UPDATE SET
    provider = 'meta',
    schema_version = excluded.schema_version,
    key_id = excluded.key_id,
    iv = excluded.iv,
    ciphertext = excluded.ciphertext,
    tag = excluded.tag,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
  WHERE ad_platform_secure_outbox.provider = 'meta' AND (
    ad_platform_secure_outbox.schema_version IS NOT excluded.schema_version
    OR ad_platform_secure_outbox.key_id IS NOT excluded.key_id
    OR ad_platform_secure_outbox.iv IS NOT excluded.iv
    OR ad_platform_secure_outbox.ciphertext IS NOT excluded.ciphertext
    OR ad_platform_secure_outbox.tag IS NOT excluded.tag
    OR ad_platform_secure_outbox.expires_at IS NOT excluded.expires_at
    OR ad_platform_secure_outbox.created_at IS NOT excluded.created_at
    OR ad_platform_secure_outbox.updated_at IS NOT excluded.updated_at
  );
END;

CREATE TRIGGER trg_0049_bridge_meta_outbox_legacy_update
AFTER UPDATE ON meta_capi_secure_outbox
BEGIN
  INSERT INTO ad_platform_secure_outbox (
    delivery_id, provider, schema_version, key_id, iv, ciphertext, tag,
    expires_at, created_at, updated_at
  )
  VALUES (
    NEW.delivery_id, 'meta', NEW.schema_version, NEW.key_id, NEW.iv, NEW.ciphertext, NEW.tag,
    NEW.expires_at, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT(delivery_id) DO UPDATE SET
    provider = 'meta',
    schema_version = excluded.schema_version,
    key_id = excluded.key_id,
    iv = excluded.iv,
    ciphertext = excluded.ciphertext,
    tag = excluded.tag,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
  WHERE ad_platform_secure_outbox.provider = 'meta' AND (
    ad_platform_secure_outbox.schema_version IS NOT excluded.schema_version
    OR ad_platform_secure_outbox.key_id IS NOT excluded.key_id
    OR ad_platform_secure_outbox.iv IS NOT excluded.iv
    OR ad_platform_secure_outbox.ciphertext IS NOT excluded.ciphertext
    OR ad_platform_secure_outbox.tag IS NOT excluded.tag
    OR ad_platform_secure_outbox.expires_at IS NOT excluded.expires_at
    OR ad_platform_secure_outbox.created_at IS NOT excluded.created_at
    OR ad_platform_secure_outbox.updated_at IS NOT excluded.updated_at
  );
END;

CREATE TRIGGER trg_0049_bridge_meta_outbox_legacy_delete
AFTER DELETE ON meta_capi_secure_outbox
BEGIN
  DELETE FROM ad_platform_secure_outbox
  WHERE delivery_id = OLD.delivery_id AND provider = 'meta';
END;

CREATE TRIGGER trg_0049_bridge_meta_outbox_current_insert
AFTER INSERT ON ad_platform_secure_outbox
WHEN NEW.provider = 'meta'
BEGIN
  INSERT INTO meta_capi_secure_outbox (
    delivery_id, schema_version, key_id, iv, ciphertext, tag,
    expires_at, created_at, updated_at
  )
  VALUES (
    NEW.delivery_id, NEW.schema_version, NEW.key_id, NEW.iv, NEW.ciphertext, NEW.tag,
    NEW.expires_at, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT(delivery_id) DO UPDATE SET
    schema_version = excluded.schema_version,
    key_id = excluded.key_id,
    iv = excluded.iv,
    ciphertext = excluded.ciphertext,
    tag = excluded.tag,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
  WHERE meta_capi_secure_outbox.schema_version IS NOT excluded.schema_version
    OR meta_capi_secure_outbox.key_id IS NOT excluded.key_id
    OR meta_capi_secure_outbox.iv IS NOT excluded.iv
    OR meta_capi_secure_outbox.ciphertext IS NOT excluded.ciphertext
    OR meta_capi_secure_outbox.tag IS NOT excluded.tag
    OR meta_capi_secure_outbox.expires_at IS NOT excluded.expires_at
    OR meta_capi_secure_outbox.created_at IS NOT excluded.created_at
    OR meta_capi_secure_outbox.updated_at IS NOT excluded.updated_at;
END;

CREATE TRIGGER trg_0049_bridge_meta_outbox_current_update
AFTER UPDATE ON ad_platform_secure_outbox
WHEN NEW.provider = 'meta'
BEGIN
  INSERT INTO meta_capi_secure_outbox (
    delivery_id, schema_version, key_id, iv, ciphertext, tag,
    expires_at, created_at, updated_at
  )
  VALUES (
    NEW.delivery_id, NEW.schema_version, NEW.key_id, NEW.iv, NEW.ciphertext, NEW.tag,
    NEW.expires_at, NEW.created_at, NEW.updated_at
  )
  ON CONFLICT(delivery_id) DO UPDATE SET
    schema_version = excluded.schema_version,
    key_id = excluded.key_id,
    iv = excluded.iv,
    ciphertext = excluded.ciphertext,
    tag = excluded.tag,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
  WHERE meta_capi_secure_outbox.schema_version IS NOT excluded.schema_version
    OR meta_capi_secure_outbox.key_id IS NOT excluded.key_id
    OR meta_capi_secure_outbox.iv IS NOT excluded.iv
    OR meta_capi_secure_outbox.ciphertext IS NOT excluded.ciphertext
    OR meta_capi_secure_outbox.tag IS NOT excluded.tag
    OR meta_capi_secure_outbox.expires_at IS NOT excluded.expires_at
    OR meta_capi_secure_outbox.created_at IS NOT excluded.created_at
    OR meta_capi_secure_outbox.updated_at IS NOT excluded.updated_at;
END;

CREATE TRIGGER trg_0049_bridge_meta_outbox_current_delete
AFTER DELETE ON ad_platform_secure_outbox
WHEN OLD.provider = 'meta'
BEGIN
  DELETE FROM meta_capi_secure_outbox WHERE delivery_id = OLD.delivery_id;
END;

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
