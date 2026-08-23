-- Wallet-4：旧余额外部快照 Dry-run、逐项独立复核与受控迁移。
--
-- 仓库内不存在可作为权威来源的 legacy 金币字段，因此本 migration：
-- - 只建立空的证据、复核、幂等与执行表，不读取或猜测任何旧余额；
-- - 正式执行默认关闭，且仍受钱包写开关与运营安全控制约束；
-- - 每个来源记录和目标账号最多成功迁移一次；
-- - 实际余额变化继续复用普通双人复核调币与不可变 app_wallet_entries；
-- - 通过不可变 link 把迁移分录与日常调币永久区分，不修改既有账本 CHECK。

CREATE TABLE app_wallet_legacy_migration_controls (
  policy_id TEXT PRIMARY KEY REFERENCES app_wallet_policies(id) ON DELETE RESTRICT,
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

INSERT INTO app_wallet_legacy_migration_controls (
  policy_id, execution_enabled, created_at, updated_at
) VALUES (
  'wlp_app_1_0_wallet_1_dev_1', 0,
  '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
);

CREATE TABLE app_wallet_legacy_migration_jobs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wlmj_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_wallet_policies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN (
      'dry_run', 'pending_review', 'ready', 'executing',
      'completed', 'partial_failed', 'cancelled'
    )),
  source_name TEXT NOT NULL CHECK (length(trim(source_name)) BETWEEN 1 AND 120),
  source_system TEXT NOT NULL
    CHECK (
      length(source_system) BETWEEN 2 AND 48
      AND source_system NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  extracted_at TEXT NOT NULL CHECK (julianday(extracted_at) IS NOT NULL),
  mapping_rule TEXT NOT NULL CHECK (length(trim(mapping_rule)) BETWEEN 3 AND 160),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
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
        execution_token GLOB 'wlmx_*'
        AND execution_token NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(execution_token) BETWEEN 6 AND 96
      )
    ),
  executed_at TEXT CHECK (executed_at IS NULL OR julianday(executed_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (created_by, request_idempotency_key),
  CHECK (status = 'dry_run' OR submitted_at IS NOT NULL),
  CHECK (
    (status = 'executing'
      AND executed_by IS NOT NULL
      AND execution_started_at IS NOT NULL
      AND execution_lease_expires_at IS NOT NULL
      AND execution_token IS NOT NULL
      AND executed_at IS NULL)
    OR
    (status <> 'executing'
      AND execution_lease_expires_at IS NULL
      AND execution_token IS NULL)
  ),
  CHECK (executed_at IS NULL OR executed_by IS NOT NULL)
);

CREATE INDEX idx_app_wallet_legacy_jobs_queue
  ON app_wallet_legacy_migration_jobs (status, created_at DESC, id DESC);

CREATE TRIGGER trg_app_wallet_legacy_jobs_update_guard
BEFORE UPDATE ON app_wallet_legacy_migration_jobs
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.policy_id <> OLD.policy_id
      OR NEW.source_name <> OLD.source_name
      OR NEW.source_system <> OLD.source_system
      OR NEW.extracted_at <> OLD.extracted_at
      OR NEW.mapping_rule <> OLD.mapping_rule
      OR NEW.source_sha256 <> OLD.source_sha256
      OR NEW.request_idempotency_key <> OLD.request_idempotency_key
      OR NEW.request_hash <> OLD.request_hash
      OR NEW.created_by <> OLD.created_by
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_jobs immutable evidence changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_jobs version must increment by one')
    WHEN OLD.status <> 'dry_run' AND NEW.submitted_at IS NOT OLD.submitted_at
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_jobs submitted evidence is immutable')
    WHEN OLD.status NOT IN ('ready', 'executing')
      AND (
        NEW.executed_by IS NOT OLD.executed_by
        OR NEW.execution_started_at IS NOT OLD.execution_started_at
        OR NEW.execution_lease_expires_at IS NOT OLD.execution_lease_expires_at
        OR NEW.execution_token IS NOT OLD.execution_token
        OR NEW.executed_at IS NOT OLD.executed_at
      )
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_jobs execution evidence changed outside execution')
    WHEN NOT (
      (OLD.status = 'dry_run' AND NEW.status IN ('pending_review', 'cancelled'))
      OR (OLD.status = 'pending_review' AND NEW.status IN ('pending_review', 'ready', 'completed', 'cancelled'))
      OR (OLD.status = 'ready' AND NEW.status IN ('executing', 'cancelled'))
      OR (OLD.status = 'executing' AND NEW.status IN ('executing', 'completed', 'partial_failed'))
    )
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_jobs invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_legacy_jobs_delete_guard
BEFORE DELETE ON app_wallet_legacy_migration_jobs
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_jobs cannot be deleted');
END;

CREATE TRIGGER trg_app_wallet_legacy_controls_delete_guard
BEFORE DELETE ON app_wallet_legacy_migration_controls
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_controls cannot be deleted');
END;

CREATE TABLE app_wallet_legacy_migration_items (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wlmi_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  job_id TEXT NOT NULL REFERENCES app_wallet_legacy_migration_jobs(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number BETWEEN 1 AND 200),
  source_record_id TEXT NOT NULL CHECK (length(trim(source_record_id)) BETWEEN 1 AND 128),
  source_account_reference TEXT NOT NULL
    CHECK (
      source_account_reference GLOB 'opaque:*'
      AND source_account_reference NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND length(source_account_reference) BETWEEN 11 AND 127
    ),
  source_identity_sha256 TEXT NOT NULL
    CHECK (length(source_identity_sha256) = 64 AND source_identity_sha256 NOT GLOB '*[^a-f0-9]*'),
  target_account_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  account_public_id_snapshot TEXT NOT NULL
    CHECK (
      account_public_id_snapshot GLOB 'acc_*'
      AND account_public_id_snapshot NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(account_public_id_snapshot) BETWEEN 5 AND 80
    ),
  source_balance INTEGER NOT NULL CHECK (source_balance BETWEEN 1 AND 1000000),
  evidence_sha256 TEXT NOT NULL
    CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL
    CHECK (status IN (
      'draft', 'pending_review', 'approved', 'rejected',
      'conflict', 'evidence_insufficient', 'migrated', 'failed', 'stale'
    )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  conflict_code TEXT CHECK (conflict_code IS NULL OR length(conflict_code) BETWEEN 3 AND 80),
  conflict_summary TEXT
    CHECK (conflict_summary IS NULL OR length(trim(conflict_summary)) BETWEEN 1 AND 300),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 2 AND 500),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  result_adjustment_id TEXT REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  result_entry_id TEXT REFERENCES app_wallet_entries(id) ON DELETE RESTRICT,
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 3 AND 80),
  failure_summary TEXT
    CHECK (failure_summary IS NULL OR length(trim(failure_summary)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (job_id, row_number),
  UNIQUE (job_id, source_record_id),
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
  CHECK (
    status IN ('conflict', 'evidence_insufficient')
    OR target_account_id IS NOT NULL
  ),
  CHECK (
    status = 'migrated'
    OR (result_adjustment_id IS NULL AND result_entry_id IS NULL)
  ),
  CHECK (
    status <> 'migrated'
    OR (result_adjustment_id IS NOT NULL AND result_entry_id IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('failed', 'stale')
    OR (failure_code IS NOT NULL AND failure_summary IS NOT NULL)
  ),
  CHECK (
    status IN ('failed', 'stale')
    OR (failure_code IS NULL AND failure_summary IS NULL)
  )
);

CREATE INDEX idx_app_wallet_legacy_items_queue
  ON app_wallet_legacy_migration_items (job_id, status, row_number ASC);
CREATE UNIQUE INDEX idx_app_wallet_legacy_items_source_migrated_once
  ON app_wallet_legacy_migration_items (source_identity_sha256)
  WHERE status = 'migrated';
CREATE UNIQUE INDEX idx_app_wallet_legacy_items_account_migrated_once
  ON app_wallet_legacy_migration_items (target_account_id)
  WHERE status = 'migrated';

CREATE TRIGGER trg_app_wallet_legacy_items_update_guard
BEFORE UPDATE ON app_wallet_legacy_migration_items
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.job_id <> OLD.job_id
      OR NEW.row_number <> OLD.row_number
      OR NEW.source_record_id <> OLD.source_record_id
      OR NEW.source_account_reference <> OLD.source_account_reference
      OR NEW.source_identity_sha256 <> OLD.source_identity_sha256
      OR NEW.target_account_id <> OLD.target_account_id
      OR NEW.account_public_id_snapshot <> OLD.account_public_id_snapshot
      OR NEW.source_balance <> OLD.source_balance
      OR NEW.evidence_sha256 <> OLD.evidence_sha256
      OR NEW.conflict_code IS NOT OLD.conflict_code
      OR NEW.conflict_summary IS NOT OLD.conflict_summary
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_items immutable evidence changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_items version must increment by one')
    WHEN OLD.status <> 'pending_review'
      AND (
        NEW.reviewed_by IS NOT OLD.reviewed_by
        OR NEW.review_note IS NOT OLD.review_note
        OR NEW.reviewed_at IS NOT OLD.reviewed_at
      )
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_items review evidence changed outside review')
    WHEN OLD.status <> 'approved'
      AND (
        NEW.result_adjustment_id IS NOT OLD.result_adjustment_id
        OR NEW.result_entry_id IS NOT OLD.result_entry_id
        OR NEW.failure_code IS NOT OLD.failure_code
        OR NEW.failure_summary IS NOT OLD.failure_summary
      )
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_items result changed outside execution')
    WHEN NOT (
      (OLD.status = 'draft' AND NEW.status = 'pending_review')
      OR (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected'))
      OR (OLD.status = 'approved' AND NEW.status IN ('migrated', 'failed', 'stale'))
    )
      THEN RAISE(ABORT, 'app_wallet_legacy_migration_items invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_legacy_items_delete_guard
BEFORE DELETE ON app_wallet_legacy_migration_items
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_items cannot be deleted');
END;

CREATE TABLE app_wallet_legacy_migration_links (
  item_id TEXT PRIMARY KEY REFERENCES app_wallet_legacy_migration_items(id) ON DELETE RESTRICT,
  adjustment_id TEXT NOT NULL UNIQUE REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE TRIGGER trg_app_wallet_legacy_links_insert_guard
BEFORE INSERT ON app_wallet_legacy_migration_links
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM app_wallet_legacy_migration_items item
    JOIN app_wallet_legacy_migration_jobs job ON job.id = item.job_id
    JOIN app_wallet_adjustments adjustment ON adjustment.id = NEW.adjustment_id
    WHERE item.id = NEW.item_id
      AND item.status = 'approved'
      AND adjustment.status = 'pending_review'
      AND adjustment.account_id = item.target_account_id
      AND adjustment.action_type = 'admin_credit'
      AND adjustment.direction = 'credit'
      AND adjustment.amount = item.source_balance
      AND adjustment.reason_code = 'correction'
      AND adjustment.original_entry_id IS NULL
      AND adjustment.requested_by = job.created_by
      AND adjustment.business_reference = 'legacy:' || item.id
  ) THEN RAISE(ABORT, 'app_wallet_legacy_migration_links evidence mismatch') END;
END;

CREATE TRIGGER trg_app_wallet_legacy_links_update_guard
BEFORE UPDATE ON app_wallet_legacy_migration_links
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_links are immutable');
END;

CREATE TRIGGER trg_app_wallet_legacy_links_delete_guard
BEFORE DELETE ON app_wallet_legacy_migration_links
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_links are immutable');
END;

CREATE TRIGGER trg_app_wallet_legacy_entry_requires_link
BEFORE INSERT ON app_wallet_entries
WHEN NEW.business_reference GLOB 'legacy:*'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM app_wallet_legacy_migration_links link
    WHERE link.adjustment_id = NEW.adjustment_id
  ) THEN RAISE(ABORT, 'legacy wallet entry requires migration evidence link') END;
END;

CREATE TABLE app_wallet_legacy_migration_item_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wlme_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  item_id TEXT NOT NULL REFERENCES app_wallet_legacy_migration_items(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('dry_run', 'submitted', 'approved', 'rejected', 'migrated', 'failed', 'stale')),
  status_from TEXT,
  status_to TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  result_code TEXT NOT NULL CHECK (length(result_code) BETWEEN 2 AND 80),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (item_id, sequence)
);

CREATE TRIGGER trg_app_wallet_legacy_item_events_update_guard
BEFORE UPDATE ON app_wallet_legacy_migration_item_events
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_item_events are immutable');
END;

CREATE TRIGGER trg_app_wallet_legacy_item_events_delete_guard
BEFORE DELETE ON app_wallet_legacy_migration_item_events
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_item_events are immutable');
END;

CREATE TABLE app_wallet_legacy_migration_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wlmr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  job_id TEXT NOT NULL REFERENCES app_wallet_legacy_migration_jobs(id) ON DELETE RESTRICT,
  item_id TEXT REFERENCES app_wallet_legacy_migration_items(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'review', 'execute')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  result_status TEXT NOT NULL CHECK (length(result_status) BETWEEN 2 AND 48),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (actor_id, idempotency_key),
  CHECK ((operation = 'review') = (item_id IS NOT NULL))
);

CREATE TRIGGER trg_app_wallet_legacy_requests_update_guard
BEFORE UPDATE ON app_wallet_legacy_migration_requests
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_requests are immutable');
END;

CREATE TRIGGER trg_app_wallet_legacy_requests_delete_guard
BEFORE DELETE ON app_wallet_legacy_migration_requests
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_legacy_migration_requests are immutable');
END;
