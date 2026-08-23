-- Privacy-2A：账号私有数据导出制品、可恢复分页任务与一次性下载票据。
--
-- 边界：
-- 1. 本 migration 只建立默认关闭的导出执行器，不启用任何环境或策略；
-- 2. 导出对象固定写入私有 R2 data-rights/exports/{requestId}/{artifactId}/，不保存公开 URL；
-- 3. 明文下载票据只在单次响应中返回，D1 仅保存 SHA-256；
-- 4. 每个分类先冻结最大 rowid，再按小页生成显式白名单 NDJSON，避免单次 Worker 聚合完整历史；
-- 5. 不可逆注销执行、匿名化分类和法定保留隔离继续硬关闭，等待 OQ-020/OQ-024/OQ-025；
-- 6. 24 小时仅是 development 制品逻辑有效期，不代表正式数据保留政策。

CREATE TABLE app_data_rights_export_profiles (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drxp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  policy_id TEXT NOT NULL UNIQUE REFERENCES app_data_rights_policies(id) ON DELETE RESTRICT,
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      length(version_code) BETWEEN 3 AND 80
      AND version_code NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  artifact_ttl_hours INTEGER NOT NULL DEFAULT 24 CHECK (artifact_ttl_hours BETWEEN 1 AND 168),
  download_ticket_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (download_ticket_ttl_seconds BETWEEN 60 AND 900),
  page_size INTEGER NOT NULL DEFAULT 250 CHECK (page_size BETWEEN 25 AND 500),
  max_part_bytes INTEGER NOT NULL DEFAULT 2000000
    CHECK (max_part_bytes BETWEEN 65536 AND 5000000),
  max_parts INTEGER NOT NULL DEFAULT 512 CHECK (max_parts BETWEEN 16 AND 1000),
  max_artifact_bytes INTEGER NOT NULL DEFAULT 100000000
    CHECK (max_artifact_bytes BETWEEN 1000000 AND 250000000),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (production_ready = 0 OR state = 'published')
);

INSERT INTO app_data_rights_export_profiles (
  id, policy_id, version_code, state, production_ready, schema_version,
  artifact_ttl_hours, download_ticket_ttl_seconds, page_size,
  max_part_bytes, max_parts, max_artifact_bytes, created_at
) VALUES (
  'drxp_app_1_0_privacy_2a_dev_1',
  'drp_app_1_0_privacy_1_dev_1',
  'app-1.0-privacy-2a-dev-1',
  'development',
  0,
  1,
  24,
  300,
  250,
  2000000,
  512,
  100000000,
  '2026-08-20T00:00:00.000Z'
);

CREATE TABLE app_data_rights_export_artifacts (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drea_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  request_version INTEGER NOT NULL CHECK (request_version > 0),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES app_data_rights_export_profiles(id) ON DELETE RESTRICT,
  profile_version_snapshot TEXT NOT NULL CHECK (length(profile_version_snapshot) BETWEEN 3 AND 80),
  export_schema_version INTEGER NOT NULL CHECK (export_schema_version = 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'collecting', 'finalizing', 'ready', 'failed',
      'expired', 'superseded', 'purging', 'purged'
    )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  generation_token TEXT NOT NULL UNIQUE CHECK (length(generation_token) BETWEEN 16 AND 96),
  snapshot_at TEXT NOT NULL CHECK (julianday(snapshot_at) IS NOT NULL),
  part_count INTEGER NOT NULL DEFAULT 0 CHECK (part_count BETWEEN 0 AND 1000),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count BETWEEN 0 AND 1000000000),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes BETWEEN 0 AND 250000000),
  aggregate_sha256 TEXT CHECK (
    aggregate_sha256 IS NULL
    OR (length(aggregate_sha256) = 64 AND aggregate_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  readme_r2_key TEXT,
  readme_r2_etag TEXT CHECK (readme_r2_etag IS NULL OR length(readme_r2_etag) BETWEEN 1 AND 160),
  readme_sha256 TEXT CHECK (
    readme_sha256 IS NULL
    OR (length(readme_sha256) = 64 AND readme_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  readme_size INTEGER CHECK (readme_size IS NULL OR readme_size BETWEEN 1 AND 1000000),
  manifest_r2_key TEXT,
  manifest_r2_etag TEXT CHECK (manifest_r2_etag IS NULL OR length(manifest_r2_etag) BETWEEN 1 AND 160),
  manifest_sha256 TEXT CHECK (
    manifest_sha256 IS NULL
    OR (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  manifest_size INTEGER CHECK (manifest_size IS NULL OR manifest_size BETWEEN 1 AND 5000000),
  archive_r2_key TEXT,
  archive_r2_etag TEXT CHECK (archive_r2_etag IS NULL OR length(archive_r2_etag) BETWEEN 1 AND 160),
  archive_size INTEGER CHECK (archive_size IS NULL OR archive_size BETWEEN 1 AND 250000000),
  generated_at TEXT CHECK (generated_at IS NULL OR julianday(generated_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL),
  failure_code TEXT CHECK (
    failure_code IS NULL
    OR (
      length(failure_code) BETWEEN 3 AND 120
      AND failure_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (request_id, request_version),
  CHECK (
    readme_r2_key IS NULL
    OR readme_r2_key = 'data-rights/exports/' || request_id || '/' || id || '/README.txt'
  ),
  CHECK (
    manifest_r2_key IS NULL
    OR manifest_r2_key = 'data-rights/exports/' || request_id || '/' || id || '/manifest.json'
  ),
  CHECK (
    archive_r2_key IS NULL
    OR archive_r2_key = 'data-rights/exports/' || request_id || '/' || id || '/meigallery-data-export.tar'
  ),
  CHECK (
    status NOT IN ('ready', 'expired', 'purging', 'purged')
    OR (
      aggregate_sha256 IS NOT NULL
      AND readme_r2_key IS NOT NULL AND readme_r2_etag IS NOT NULL
      AND readme_sha256 IS NOT NULL AND readme_size IS NOT NULL
      AND manifest_r2_key IS NOT NULL AND manifest_r2_etag IS NOT NULL
      AND manifest_sha256 IS NOT NULL AND manifest_size IS NOT NULL
      AND archive_r2_key IS NOT NULL AND archive_r2_etag IS NOT NULL AND archive_size IS NOT NULL
      AND generated_at IS NOT NULL AND expires_at IS NOT NULL
      AND julianday(expires_at) > julianday(generated_at)
    )
  )
);

CREATE INDEX idx_app_data_rights_export_artifacts_request
  ON app_data_rights_export_artifacts(request_id, request_version DESC, id DESC);

CREATE INDEX idx_app_data_rights_export_artifacts_queue
  ON app_data_rights_export_artifacts(status, updated_at ASC, id ASC);

CREATE INDEX idx_app_data_rights_export_artifacts_expiry
  ON app_data_rights_export_artifacts(status, expires_at ASC, id ASC)
  WHERE expires_at IS NOT NULL;

CREATE TABLE app_data_rights_export_scopes (
  artifact_id TEXT NOT NULL REFERENCES app_data_rights_export_artifacts(id) ON DELETE RESTRICT,
  category_ordinal INTEGER NOT NULL CHECK (category_ordinal BETWEEN 0 AND 99),
  category_code TEXT NOT NULL
    CHECK (
      length(category_code) BETWEEN 3 AND 48
      AND category_code NOT GLOB '*[^a-z0-9_]*'
    ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collecting', 'completed')),
  max_rowid_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (max_rowid_snapshot >= 0),
  cursor_rowid INTEGER NOT NULL DEFAULT 0 CHECK (cursor_rowid >= 0),
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  part_count INTEGER NOT NULL DEFAULT 0 CHECK (part_count >= 0),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (artifact_id, category_ordinal),
  UNIQUE (artifact_id, category_code),
  CHECK (cursor_rowid <= max_rowid_snapshot),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE app_data_rights_export_parts (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drep_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  artifact_id TEXT NOT NULL REFERENCES app_data_rights_export_artifacts(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  category_code TEXT NOT NULL
    CHECK (
      length(category_code) BETWEEN 3 AND 48
      AND category_code NOT GLOB '*[^a-z0-9_]*'
    ),
  file_name TEXT NOT NULL
    CHECK (
      file_name GLOB 'data/*.ndjson'
      AND file_name NOT GLOB '*..*'
      AND length(file_name) BETWEEN 12 AND 128
    ),
  r2_key TEXT NOT NULL CHECK (
    r2_key GLOB 'data-rights/exports/*/*/data/*.ndjson'
    AND r2_key NOT GLOB '*..*'
    AND length(r2_key) BETWEEN 32 AND 320
  ),
  r2_etag TEXT NOT NULL CHECK (length(r2_etag) BETWEEN 1 AND 160),
  file_sha256 TEXT NOT NULL CHECK (
    length(file_sha256) = 64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  file_size INTEGER NOT NULL CHECK (file_size BETWEEN 1 AND 5000000),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 1 AND 500),
  first_rowid INTEGER NOT NULL CHECK (first_rowid > 0),
  last_rowid INTEGER NOT NULL CHECK (last_rowid >= first_rowid),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (artifact_id, ordinal),
  UNIQUE (artifact_id, file_name),
  UNIQUE (r2_key)
);

CREATE INDEX idx_app_data_rights_export_parts_artifact
  ON app_data_rights_export_parts(artifact_id, ordinal ASC);

CREATE TABLE app_data_rights_export_jobs (
  artifact_id TEXT PRIMARY KEY REFERENCES app_data_rights_export_artifacts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'finalizing', 'completed', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  category_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (category_ordinal BETWEEN 0 AND 100),
  next_part_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_part_ordinal BETWEEN 1 AND 1001),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 96),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR (
      length(last_error_code) BETWEEN 3 AND 120
      AND last_error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX idx_app_data_rights_export_jobs_recovery
  ON app_data_rights_export_jobs(status, lease_expires_at, updated_at ASC, artifact_id ASC);

CREATE TABLE app_data_rights_export_download_tickets (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drdt_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  request_version INTEGER NOT NULL CHECK (request_version > 0),
  artifact_id TEXT NOT NULL REFERENCES app_data_rights_export_artifacts(id) ON DELETE RESTRICT,
  artifact_version INTEGER NOT NULL CHECK (artifact_version > 0),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  manifest_sha256_snapshot TEXT NOT NULL CHECK (
    length(manifest_sha256_snapshot) = 64
    AND manifest_sha256_snapshot NOT GLOB '*[^0-9a-f]*'
  ),
  aggregate_sha256_snapshot TEXT NOT NULL CHECK (
    length(aggregate_sha256_snapshot) = 64
    AND aggregate_sha256_snapshot NOT GLOB '*[^0-9a-f]*'
  ),
  archive_r2_etag_snapshot TEXT NOT NULL CHECK (length(archive_r2_etag_snapshot) BETWEEN 1 AND 160),
  archive_size_snapshot INTEGER NOT NULL CHECK (archive_size_snapshot BETWEEN 1 AND 250000000),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  consumed_request_id TEXT CHECK (
    consumed_request_id IS NULL OR length(consumed_request_id) BETWEEN 8 AND 96
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK ((consumed_at IS NULL) = (consumed_request_id IS NULL))
);

CREATE INDEX idx_app_data_rights_export_tickets_account
  ON app_data_rights_export_download_tickets(account_id, created_at DESC, id DESC);

CREATE INDEX idx_app_data_rights_export_tickets_active
  ON app_data_rights_export_download_tickets(request_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE app_data_rights_export_download_commands (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drdc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_ticket_id TEXT NOT NULL REFERENCES app_data_rights_export_download_tickets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (account_id, idempotency_key_hash)
);

CREATE TRIGGER app_data_rights_export_profiles_no_update
BEFORE UPDATE ON app_data_rights_export_profiles
BEGIN
  SELECT RAISE(ABORT, 'app data rights export profiles are immutable');
END;

CREATE TRIGGER app_data_rights_export_profiles_no_delete
BEFORE DELETE ON app_data_rights_export_profiles
BEGIN
  SELECT RAISE(ABORT, 'app data rights export profiles are immutable');
END;

CREATE TRIGGER app_data_rights_export_parts_no_update
BEFORE UPDATE ON app_data_rights_export_parts
BEGIN
  SELECT RAISE(ABORT, 'app data rights export parts are immutable');
END;

CREATE TRIGGER app_data_rights_export_parts_no_delete
BEFORE DELETE ON app_data_rights_export_parts
BEGIN
  SELECT RAISE(ABORT, 'app data rights export parts are immutable');
END;

CREATE TRIGGER app_data_rights_export_download_commands_no_update
BEFORE UPDATE ON app_data_rights_export_download_commands
BEGIN
  SELECT RAISE(ABORT, 'app data rights export download commands are immutable');
END;

CREATE TRIGGER app_data_rights_export_download_commands_no_delete
BEFORE DELETE ON app_data_rights_export_download_commands
BEGIN
  SELECT RAISE(ABORT, 'app data rights export download commands are immutable');
END;
