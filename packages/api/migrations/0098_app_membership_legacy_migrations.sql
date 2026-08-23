-- Membership-5：旧 Web 会员到 App 五级会员的显式映射、逐项独立复核与受控执行。
--
-- 本 migration 只创建空治理表，不自动识别 vip/svip 对应的新等级，不迁移任何会员：
-- - Dry-run 只读取 user_memberships + membership_levels 的既有证据并冻结快照；
-- - 每条记录都必须由非任务创建人的 Owner 独立批准或拒绝；
-- - 执行时再次核对 legacy 证据、目标目录、账号状态与重复迁移；
-- - 正式 grant 仍写入 app_membership_grants，失败逐项记录且不阻塞其他条目；
-- - 不改变会员运行配置，不接入支付，也不推断未知 legacy 等级。

CREATE TABLE app_membership_legacy_migration_controls (
  catalog_version_id TEXT PRIMARY KEY REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  execution_enabled INTEGER NOT NULL DEFAULT 0 CHECK (execution_enabled IN (0, 1)),
  decision_reference TEXT
    CHECK (decision_reference IS NULL OR length(trim(decision_reference)) BETWEEN 3 AND 160),
  approved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT CHECK (approved_at IS NULL OR julianday(approved_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (
    execution_enabled = 0
    OR (decision_reference IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

INSERT INTO app_membership_legacy_migration_controls (
  catalog_version_id, execution_enabled, created_at, updated_at
)
SELECT id, 0, '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z'
FROM app_membership_catalog_versions;

CREATE TABLE app_membership_legacy_migration_jobs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amlj_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  catalog_version_id TEXT NOT NULL REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN (
      'dry_run', 'pending_review', 'ready', 'executing',
      'completed', 'partial_failed', 'cancelled'
    )),
  mapping_json TEXT NOT NULL
    CHECK (json_valid(mapping_json) AND json_type(mapping_json) = 'array'),
  mapping_sha256 TEXT NOT NULL
    CHECK (length(mapping_sha256) = 64 AND mapping_sha256 NOT GLOB '*[^a-f0-9]*'),
  request_idempotency_key TEXT NOT NULL
    CHECK (
      length(request_idempotency_key) BETWEEN 16 AND 128
      AND request_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TEXT CHECK (submitted_at IS NULL OR julianday(submitted_at) IS NOT NULL),
  executed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  execution_started_at TEXT CHECK (execution_started_at IS NULL OR julianday(execution_started_at) IS NOT NULL),
  execution_lease_expires_at TEXT
    CHECK (execution_lease_expires_at IS NULL OR julianday(execution_lease_expires_at) IS NOT NULL),
  execution_token TEXT UNIQUE
    CHECK (
      execution_token IS NULL
      OR (
        execution_token GLOB 'amlx_*'
        AND execution_token NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(execution_token) BETWEEN 6 AND 96
      )
    ),
  execution_idempotency_key TEXT
    CHECK (
      execution_idempotency_key IS NULL
      OR (
        length(execution_idempotency_key) BETWEEN 16 AND 128
        AND execution_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
  execution_request_hash TEXT
    CHECK (
      execution_request_hash IS NULL
      OR (length(execution_request_hash) = 64 AND execution_request_hash NOT GLOB '*[^a-f0-9]*')
    ),
  executed_at TEXT CHECK (executed_at IS NULL OR julianday(executed_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (created_by, request_idempotency_key),
  UNIQUE (id, catalog_version_id),
  CHECK (executed_at IS NULL OR executed_by IS NOT NULL),
  CHECK (
    (
      status IN ('dry_run', 'pending_review', 'ready')
      AND executed_by IS NULL
      AND execution_started_at IS NULL
      AND execution_lease_expires_at IS NULL
      AND execution_token IS NULL
      AND execution_idempotency_key IS NULL
      AND execution_request_hash IS NULL
      AND executed_at IS NULL
    )
    OR (
      status = 'executing'
      AND executed_by IS NOT NULL
      AND execution_started_at IS NOT NULL
      AND execution_lease_expires_at IS NOT NULL
      AND execution_token IS NOT NULL
      AND execution_idempotency_key IS NOT NULL
      AND execution_request_hash IS NOT NULL
      AND executed_at IS NULL
    )
    OR (
      status IN ('completed', 'partial_failed')
      AND executed_by IS NOT NULL
      AND execution_started_at IS NOT NULL
      AND execution_lease_expires_at IS NULL
      AND execution_token IS NULL
      AND execution_idempotency_key IS NOT NULL
      AND execution_request_hash IS NOT NULL
      AND executed_at IS NOT NULL
    )
    OR (
      status IN ('completed', 'cancelled')
      AND executed_by IS NULL
      AND execution_started_at IS NULL
      AND execution_lease_expires_at IS NULL
      AND execution_token IS NULL
      AND execution_idempotency_key IS NULL
      AND execution_request_hash IS NULL
      AND executed_at IS NULL
    )
  )
);

CREATE INDEX idx_app_membership_legacy_jobs_queue
  ON app_membership_legacy_migration_jobs (status, created_at DESC, id DESC);

CREATE TRIGGER trg_app_membership_legacy_jobs_update_guard
BEFORE UPDATE ON app_membership_legacy_migration_jobs
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.catalog_version_id <> OLD.catalog_version_id
      OR NEW.mapping_json <> OLD.mapping_json
      OR NEW.mapping_sha256 <> OLD.mapping_sha256
      OR NEW.request_idempotency_key <> OLD.request_idempotency_key
      OR NEW.request_hash <> OLD.request_hash
      OR NEW.created_by <> OLD.created_by
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_membership_legacy_migration_jobs immutable identity changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_membership_legacy_migration_jobs version must increment by one')
    WHEN OLD.status <> 'dry_run' AND NEW.submitted_at IS NOT OLD.submitted_at
      THEN RAISE(ABORT, 'app_membership_legacy_migration_jobs submitted evidence is immutable')
    WHEN OLD.status <> 'ready' AND OLD.status <> 'executing'
      AND (
        NEW.executed_by IS NOT OLD.executed_by
        OR NEW.execution_started_at IS NOT OLD.execution_started_at
        OR NEW.execution_lease_expires_at IS NOT OLD.execution_lease_expires_at
        OR NEW.execution_token IS NOT OLD.execution_token
        OR NEW.execution_idempotency_key IS NOT OLD.execution_idempotency_key
        OR NEW.execution_request_hash IS NOT OLD.execution_request_hash
        OR NEW.executed_at IS NOT OLD.executed_at
      )
      THEN RAISE(ABORT, 'app_membership_legacy_migration_jobs execution evidence changed outside execution')
    WHEN NOT (
      (OLD.status = 'dry_run' AND NEW.status IN ('pending_review', 'cancelled'))
      OR (OLD.status = 'pending_review' AND NEW.status IN ('pending_review', 'ready', 'completed', 'cancelled'))
      OR (OLD.status = 'ready' AND NEW.status IN ('executing', 'cancelled'))
      OR (OLD.status = 'executing' AND NEW.status IN ('executing', 'ready', 'completed', 'partial_failed'))
    )
      THEN RAISE(ABORT, 'app_membership_legacy_migration_jobs invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_membership_legacy_jobs_delete_guard
BEFORE DELETE ON app_membership_legacy_migration_jobs
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_jobs cannot be deleted');
END;

CREATE TRIGGER trg_app_membership_legacy_execution_control_delete_guard
BEFORE DELETE ON app_membership_legacy_migration_controls
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_controls cannot be deleted');
END;

CREATE TABLE app_membership_legacy_migration_items (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amli_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
  ),
  job_id TEXT NOT NULL REFERENCES app_membership_legacy_migration_jobs(id) ON DELETE RESTRICT,
  catalog_version_id TEXT NOT NULL,
  legacy_membership_id TEXT NOT NULL CHECK (length(trim(legacy_membership_id)) BETWEEN 1 AND 128),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_public_id_snapshot TEXT,
  email_masked_snapshot TEXT NOT NULL CHECK (length(email_masked_snapshot) BETWEEN 3 AND 254),
  legacy_level_id TEXT NOT NULL CHECK (length(trim(legacy_level_id)) BETWEEN 1 AND 80),
  legacy_level_code TEXT NOT NULL CHECK (length(trim(legacy_level_code)) BETWEEN 1 AND 48),
  legacy_level_name TEXT NOT NULL CHECK (length(trim(legacy_level_name)) BETWEEN 1 AND 80),
  legacy_rank INTEGER NOT NULL,
  legacy_granted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  legacy_starts_at_raw TEXT NOT NULL CHECK (length(legacy_starts_at_raw) <= 128),
  legacy_expires_at_raw TEXT NOT NULL CHECK (length(legacy_expires_at_raw) <= 128),
  legacy_starts_at TEXT CHECK (legacy_starts_at IS NULL OR julianday(legacy_starts_at) IS NOT NULL),
  legacy_expires_at TEXT CHECK (legacy_expires_at IS NULL OR julianday(legacy_expires_at) IS NOT NULL),
  target_tier_id TEXT NOT NULL,
  target_tier_code_snapshot TEXT NOT NULL CHECK (length(target_tier_code_snapshot) BETWEEN 3 AND 48),
  target_tier_name_snapshot TEXT NOT NULL CHECK (length(trim(target_tier_name_snapshot)) BETWEEN 1 AND 32),
  target_rank_snapshot INTEGER NOT NULL CHECK (target_rank_snapshot BETWEEN 1 AND 1000),
  evidence_sha256 TEXT NOT NULL
    CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL
    CHECK (status IN (
      'draft', 'pending_review', 'approved', 'rejected', 'conflict',
      'evidence_insufficient', 'migrated', 'failed', 'stale'
    )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  conflict_code TEXT,
  conflict_summary TEXT CHECK (conflict_summary IS NULL OR length(trim(conflict_summary)) BETWEEN 1 AND 300),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 2 AND 500),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  result_grant_id TEXT,
  failure_code TEXT,
  failure_summary TEXT CHECK (failure_summary IS NULL OR length(trim(failure_summary)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (job_id, legacy_membership_id),
  CHECK (reviewed_by IS NULL OR reviewed_at IS NOT NULL),
  CHECK (status <> 'migrated' OR result_grant_id IS NOT NULL),
  CHECK (
    status NOT IN ('draft', 'pending_review', 'approved', 'migrated', 'failed', 'stale')
    OR (legacy_starts_at IS NOT NULL AND legacy_expires_at IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('conflict', 'evidence_insufficient')
    OR (conflict_code IS NOT NULL AND conflict_summary IS NOT NULL)
  ),
  CHECK (
    status IN ('conflict', 'evidence_insufficient')
    OR (conflict_code IS NULL AND conflict_summary IS NULL)
  ),
  CHECK (
    status NOT IN ('approved', 'rejected', 'migrated', 'failed', 'stale')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL)
  ),
  CHECK (status = 'migrated' OR result_grant_id IS NULL),
  CHECK (
    status NOT IN ('failed', 'stale')
    OR (failure_code IS NOT NULL AND failure_summary IS NOT NULL)
  ),
  CHECK (status IN ('failed', 'stale') OR (failure_code IS NULL AND failure_summary IS NULL)),
  FOREIGN KEY (job_id, catalog_version_id)
    REFERENCES app_membership_legacy_migration_jobs(id, catalog_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (catalog_version_id, target_tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id) ON DELETE RESTRICT
);

CREATE INDEX idx_app_membership_legacy_items_queue
  ON app_membership_legacy_migration_items (job_id, status, created_at ASC, id ASC);
CREATE UNIQUE INDEX idx_app_membership_legacy_items_migrated_once
  ON app_membership_legacy_migration_items (legacy_membership_id)
  WHERE status = 'migrated';

CREATE TRIGGER trg_app_membership_legacy_items_update_guard
BEFORE UPDATE ON app_membership_legacy_migration_items
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.job_id <> OLD.job_id
      OR NEW.catalog_version_id <> OLD.catalog_version_id
      OR NEW.legacy_membership_id <> OLD.legacy_membership_id
      OR NEW.user_id <> OLD.user_id
      OR NEW.account_public_id_snapshot IS NOT OLD.account_public_id_snapshot
      OR NEW.email_masked_snapshot <> OLD.email_masked_snapshot
      OR NEW.legacy_level_id <> OLD.legacy_level_id
      OR NEW.legacy_level_code <> OLD.legacy_level_code
      OR NEW.legacy_level_name <> OLD.legacy_level_name
      OR NEW.legacy_rank <> OLD.legacy_rank
      OR NEW.legacy_granted_by <> OLD.legacy_granted_by
      OR NEW.legacy_starts_at_raw <> OLD.legacy_starts_at_raw
      OR NEW.legacy_expires_at_raw <> OLD.legacy_expires_at_raw
      OR NEW.legacy_starts_at IS NOT OLD.legacy_starts_at
      OR NEW.legacy_expires_at IS NOT OLD.legacy_expires_at
      OR NEW.target_tier_id <> OLD.target_tier_id
      OR NEW.target_tier_code_snapshot <> OLD.target_tier_code_snapshot
      OR NEW.target_tier_name_snapshot <> OLD.target_tier_name_snapshot
      OR NEW.target_rank_snapshot <> OLD.target_rank_snapshot
      OR NEW.evidence_sha256 <> OLD.evidence_sha256
      OR NEW.conflict_code IS NOT OLD.conflict_code
      OR NEW.conflict_summary IS NOT OLD.conflict_summary
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_membership_legacy_migration_items immutable evidence changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_membership_legacy_migration_items version must increment by one')
    WHEN OLD.status <> 'pending_review'
      AND (
        NEW.reviewed_by IS NOT OLD.reviewed_by
        OR NEW.review_note IS NOT OLD.review_note
        OR NEW.reviewed_at IS NOT OLD.reviewed_at
      )
      THEN RAISE(ABORT, 'app_membership_legacy_migration_items review evidence is immutable')
    WHEN OLD.status <> 'approved'
      AND (
        NEW.result_grant_id IS NOT OLD.result_grant_id
        OR NEW.failure_code IS NOT OLD.failure_code
        OR NEW.failure_summary IS NOT OLD.failure_summary
      )
      THEN RAISE(ABORT, 'app_membership_legacy_migration_items result can only follow approval')
    WHEN NOT (
      (OLD.status = 'draft' AND NEW.status = 'pending_review')
      OR (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected'))
      OR (OLD.status = 'approved' AND NEW.status IN ('migrated', 'failed', 'stale'))
    )
      THEN RAISE(ABORT, 'app_membership_legacy_migration_items invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_membership_legacy_items_delete_guard
BEFORE DELETE ON app_membership_legacy_migration_items
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_items cannot be deleted');
END;

CREATE TABLE app_membership_legacy_migration_item_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amle_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  item_id TEXT NOT NULL REFERENCES app_membership_legacy_migration_items(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('dry_run_created', 'submitted', 'approved', 'rejected', 'migrated', 'stale', 'failed')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  result_code TEXT NOT NULL CHECK (length(trim(result_code)) BETWEEN 1 AND 80),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (item_id, sequence)
);

CREATE TRIGGER trg_app_membership_legacy_item_events_immutable_update
BEFORE UPDATE ON app_membership_legacy_migration_item_events
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_item_events are immutable');
END;

CREATE TRIGGER trg_app_membership_legacy_item_events_immutable_delete
BEFORE DELETE ON app_membership_legacy_migration_item_events
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_item_events are immutable');
END;

CREATE TABLE app_membership_legacy_migration_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amlr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  job_id TEXT NOT NULL REFERENCES app_membership_legacy_migration_jobs(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'review', 'execute')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  result_status TEXT NOT NULL CHECK (length(trim(result_status)) BETWEEN 1 AND 48),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (actor_id, idempotency_key)
);

CREATE TRIGGER trg_app_membership_legacy_requests_immutable_update
BEFORE UPDATE ON app_membership_legacy_migration_requests
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_requests are immutable');
END;

CREATE TRIGGER trg_app_membership_legacy_requests_immutable_delete
BEFORE DELETE ON app_membership_legacy_migration_requests
BEGIN
  SELECT RAISE(ABORT, 'app_membership_legacy_migration_requests are immutable');
END;
