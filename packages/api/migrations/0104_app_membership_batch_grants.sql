-- Membership-6：会员批量发放预览、逐项独立复核提交与可恢复部分失败。
--
-- 安全边界：
-- 1. 本 migration 只 seed disabled 控制项，不开启任何环境或批量能力；
-- 2. CSV 每个有效行只创建普通 app_membership_change_requests，永远需要另一位管理员逐项复核；
-- 3. 批次提交不是会员生效，只有既有独立复核事务成功写 grant 后才生效；
-- 4. 批次行证据不可修改，重试只恢复 submit_failed/过期租约项，已提交项不会重复创建；
-- 5. 单项失败不回滚其他已创建的复核申请，也不允许直接写 rank、entitlement 或 grant；
-- 6. OQ-018 的批量与双人复核规则未批准前，enabled 必须保持 0。
-- 7. 只有创建人可在提交前幂等取消 draft，取消原因和命令结果不可修改。

CREATE TABLE app_membership_batch_controls (
  catalog_version_id TEXT PRIMARY KEY
    REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  max_rows INTEGER NOT NULL DEFAULT 200 CHECK (max_rows BETWEEN 1 AND 200),
  large_batch_threshold INTEGER NOT NULL DEFAULT 50 CHECK (large_batch_threshold BETWEEN 2 AND 200),
  decision_reference TEXT
    CHECK (decision_reference IS NULL OR length(trim(decision_reference)) BETWEEN 3 AND 160),
  approved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT CHECK (approved_at IS NULL OR julianday(approved_at) IS NOT NULL),
  updated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (large_batch_threshold <= max_rows),
  CHECK (
    enabled = 0
    OR (
      decision_reference IS NOT NULL
      AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND updated_by IS NOT NULL
    )
  )
);

INSERT INTO app_membership_batch_controls (
  catalog_version_id, enabled, max_rows, large_batch_threshold, created_at, updated_at
) VALUES (
  'amc_app_1_0_draft_1', 0, 200, 50,
  '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
);

CREATE TABLE app_membership_grant_batches (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amb_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  catalog_version_id TEXT NOT NULL
    REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'processing', 'submitted', 'partial_failed', 'cancelled')),
  source_name TEXT NOT NULL CHECK (length(trim(source_name)) BETWEEN 1 AND 120),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
  total_count INTEGER NOT NULL CHECK (total_count BETWEEN 1 AND 200),
  valid_count INTEGER NOT NULL CHECK (valid_count BETWEEN 0 AND total_count),
  invalid_count INTEGER NOT NULL CHECK (invalid_count BETWEEN 0 AND total_count),
  risk_codes_json TEXT NOT NULL DEFAULT '["BATCH_INDEPENDENT_REVIEW"]'
    CHECK (json_valid(risk_codes_json) AND json_type(risk_codes_json) = 'array'),
  submitted_count INTEGER NOT NULL DEFAULT 0 CHECK (submitted_count BETWEEN 0 AND valid_count),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  request_idempotency_key TEXT NOT NULL
    CHECK (
      length(request_idempotency_key) BETWEEN 16 AND 128
      AND request_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  processing_started_at TEXT
    CHECK (processing_started_at IS NULL OR julianday(processing_started_at) IS NOT NULL),
  processing_lease_expires_at TEXT
    CHECK (processing_lease_expires_at IS NULL OR julianday(processing_lease_expires_at) IS NOT NULL),
  processing_token TEXT UNIQUE
    CHECK (
      processing_token IS NULL
      OR (
        processing_token GLOB 'ambx_*'
        AND processing_token NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(processing_token) BETWEEN 6 AND 96
      )
    ),
  processing_idempotency_key TEXT
    CHECK (
      processing_idempotency_key IS NULL
      OR (
        length(processing_idempotency_key) BETWEEN 16 AND 128
        AND processing_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
  processing_request_hash TEXT
    CHECK (
      processing_request_hash IS NULL
      OR (length(processing_request_hash) = 64 AND processing_request_hash NOT GLOB '*[^a-f0-9]*')
    ),
  submitted_at TEXT CHECK (submitted_at IS NULL OR julianday(submitted_at) IS NOT NULL),
  cancelled_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  cancellation_reason TEXT
    CHECK (cancellation_reason IS NULL OR length(trim(cancellation_reason)) BETWEEN 3 AND 300),
  cancelled_at TEXT CHECK (cancelled_at IS NULL OR julianday(cancelled_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (created_by, request_idempotency_key),
  CHECK (valid_count + invalid_count = total_count),
  CHECK (
    (
      status = 'draft'
      AND processing_started_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND processing_token IS NULL
      AND processing_idempotency_key IS NULL
      AND processing_request_hash IS NULL
      AND submitted_at IS NULL
      AND cancelled_by IS NULL
      AND cancellation_reason IS NULL
      AND cancelled_at IS NULL
    )
    OR (
      status = 'processing'
      AND processing_started_at IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
      AND processing_token IS NOT NULL
      AND processing_idempotency_key IS NOT NULL
      AND processing_request_hash IS NOT NULL
      AND submitted_at IS NULL
      AND cancelled_by IS NULL
      AND cancellation_reason IS NULL
      AND cancelled_at IS NULL
    )
    OR (
      status IN ('submitted', 'partial_failed')
      AND processing_started_at IS NOT NULL
      AND processing_lease_expires_at IS NULL
      AND processing_token IS NULL
      AND processing_idempotency_key IS NOT NULL
      AND processing_request_hash IS NOT NULL
      AND submitted_at IS NOT NULL
      AND cancelled_by IS NULL
      AND cancellation_reason IS NULL
      AND cancelled_at IS NULL
    )
    OR (
      status = 'cancelled'
      AND submitted_count = 0
      AND processing_started_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND processing_token IS NULL
      AND processing_idempotency_key IS NULL
      AND processing_request_hash IS NULL
      AND submitted_at IS NULL
      AND cancelled_by IS NOT NULL
      AND cancellation_reason IS NOT NULL
      AND cancelled_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_app_membership_grant_batches_queue
  ON app_membership_grant_batches (catalog_version_id, status, created_at DESC, id DESC);

CREATE TRIGGER trg_app_membership_grant_batches_update_guard
BEFORE UPDATE ON app_membership_grant_batches
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.catalog_version_id <> OLD.catalog_version_id
      OR NEW.source_name <> OLD.source_name
      OR NEW.source_sha256 <> OLD.source_sha256
      OR NEW.total_count <> OLD.total_count
      OR NEW.valid_count <> OLD.valid_count
      OR NEW.invalid_count <> OLD.invalid_count
      OR NEW.risk_codes_json <> OLD.risk_codes_json
      OR NEW.request_idempotency_key <> OLD.request_idempotency_key
      OR NEW.request_hash <> OLD.request_hash
      OR NEW.created_by <> OLD.created_by
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_membership_grant_batches immutable preview evidence changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_membership_grant_batches version must increment by one')
    WHEN NEW.submitted_count < OLD.submitted_count
      THEN RAISE(ABORT, 'app_membership_grant_batches submitted count cannot decrease')
    WHEN OLD.status <> 'processing' AND NEW.submitted_count <> OLD.submitted_count
      THEN RAISE(ABORT, 'app_membership_grant_batches submitted count changed outside processing')
    WHEN NOT (
      (OLD.status = 'draft' AND NEW.status IN ('processing', 'cancelled'))
      OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'submitted', 'partial_failed'))
      OR (OLD.status = 'partial_failed' AND NEW.status = 'processing')
    )
      THEN RAISE(ABORT, 'app_membership_grant_batches invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_membership_grant_batches_delete_guard
BEFORE DELETE ON app_membership_grant_batches
BEGIN
  SELECT RAISE(ABORT, 'app_membership_grant_batches cannot be deleted');
END;

CREATE TABLE app_membership_grant_batch_items (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ambi_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  batch_id TEXT NOT NULL REFERENCES app_membership_grant_batches(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number BETWEEN 2 AND 201),
  row_sha256 TEXT NOT NULL
    CHECK (length(row_sha256) = 64 AND row_sha256 NOT GLOB '*[^a-f0-9]*'),
  raw_row_json TEXT NOT NULL CHECK (json_valid(raw_row_json) AND json_type(raw_row_json) = 'object'),
  account_public_id TEXT
    CHECK (
      account_public_id IS NULL
      OR (
        account_public_id GLOB 'acc_*'
        AND account_public_id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(account_public_id) BETWEEN 5 AND 80
      )
    ),
  target_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  catalog_version_id TEXT REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  tier_id TEXT,
  tier_name_snapshot TEXT CHECK (tier_name_snapshot IS NULL OR length(trim(tier_name_snapshot)) BETWEEN 1 AND 32),
  rank_snapshot INTEGER CHECK (rank_snapshot IS NULL OR rank_snapshot BETWEEN 1 AND 1000),
  action TEXT CHECK (action IS NULL OR action IN ('grant', 'renew')),
  requested_starts_at TEXT CHECK (requested_starts_at IS NULL OR julianday(requested_starts_at) IS NOT NULL),
  preview_starts_at TEXT CHECK (preview_starts_at IS NULL OR julianday(preview_starts_at) IS NOT NULL),
  preview_expires_at TEXT CHECK (preview_expires_at IS NULL OR julianday(preview_expires_at) IS NOT NULL),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 366),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN ('manual_review', 'customer_support', 'promotion', 'compensation')),
  user_visible_note TEXT CHECK (user_visible_note IS NULL OR length(trim(user_visible_note)) BETWEEN 1 AND 240),
  internal_note TEXT
    CHECK (internal_note IS NULL OR length(trim(internal_note)) BETWEEN 1 AND 1000),
  business_reference TEXT CHECK (business_reference IS NULL OR length(trim(business_reference)) BETWEEN 3 AND 100),
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'submitting', 'submitted', 'submit_failed')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 3 AND 80),
  error_summary TEXT CHECK (error_summary IS NULL OR length(trim(error_summary)) BETWEEN 1 AND 300),
  processing_token TEXT
    CHECK (
      processing_token IS NULL
      OR (
        processing_token GLOB 'ambx_*'
        AND processing_token NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(processing_token) BETWEEN 6 AND 96
      )
    ),
  change_request_id TEXT REFERENCES app_membership_change_requests(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (batch_id, row_number),
  FOREIGN KEY (catalog_version_id, tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id),
  CHECK (target_user_id IS NULL OR account_public_id IS NOT NULL),
  CHECK (
    status = 'invalid'
    OR (
      account_public_id IS NOT NULL
      AND target_user_id IS NOT NULL
      AND catalog_version_id IS NOT NULL
      AND tier_id IS NOT NULL
      AND tier_name_snapshot IS NOT NULL
      AND rank_snapshot IS NOT NULL
      AND action IS NOT NULL
      AND preview_starts_at IS NOT NULL
      AND preview_expires_at IS NOT NULL
      AND duration_days IS NOT NULL
      AND reason_code IS NOT NULL
      AND user_visible_note IS NOT NULL
      AND internal_note IS NOT NULL
      AND business_reference IS NOT NULL
    )
  ),
  CHECK (
    (status = 'valid' AND processing_token IS NULL AND change_request_id IS NULL AND error_code IS NULL AND error_summary IS NULL)
    OR (status = 'invalid' AND processing_token IS NULL AND change_request_id IS NULL AND error_code IS NOT NULL AND error_summary IS NOT NULL)
    OR (status = 'submitting' AND processing_token IS NOT NULL AND change_request_id IS NULL AND error_code IS NULL AND error_summary IS NULL)
    OR (status = 'submitted' AND processing_token IS NULL AND change_request_id IS NOT NULL AND error_code IS NULL AND error_summary IS NULL)
    OR (status = 'submit_failed' AND processing_token IS NULL AND change_request_id IS NULL AND error_code IS NOT NULL AND error_summary IS NOT NULL)
  )
);

CREATE INDEX idx_app_membership_grant_batch_items_status
  ON app_membership_grant_batch_items (batch_id, status, row_number ASC);
CREATE UNIQUE INDEX idx_app_membership_grant_batch_items_business_reference
  ON app_membership_grant_batch_items (batch_id, target_user_id, business_reference)
  WHERE target_user_id IS NOT NULL AND business_reference IS NOT NULL AND status <> 'invalid';

CREATE TRIGGER trg_app_membership_grant_batch_items_active_account
BEFORE INSERT ON app_membership_grant_batch_items
WHEN NEW.target_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM users account
    JOIN app_account_security security ON security.account_id = account.id
    WHERE account.id = NEW.target_user_id
      AND account.status = 'active'
      AND security.status = 'active'
      AND security.account_public_id = NEW.account_public_id
  )
BEGIN
  SELECT RAISE(ABORT, 'membership batch target account is not active');
END;

CREATE TRIGGER trg_app_membership_grant_batch_items_update_guard
BEFORE UPDATE ON app_membership_grant_batch_items
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.batch_id <> OLD.batch_id
      OR NEW.row_number <> OLD.row_number
      OR NEW.row_sha256 <> OLD.row_sha256
      OR NEW.raw_row_json <> OLD.raw_row_json
      OR NEW.account_public_id IS NOT OLD.account_public_id
      OR NEW.target_user_id IS NOT OLD.target_user_id
      OR NEW.catalog_version_id IS NOT OLD.catalog_version_id
      OR NEW.tier_id IS NOT OLD.tier_id
      OR NEW.tier_name_snapshot IS NOT OLD.tier_name_snapshot
      OR NEW.rank_snapshot IS NOT OLD.rank_snapshot
      OR NEW.action IS NOT OLD.action
      OR NEW.requested_starts_at IS NOT OLD.requested_starts_at
      OR NEW.preview_starts_at IS NOT OLD.preview_starts_at
      OR NEW.preview_expires_at IS NOT OLD.preview_expires_at
      OR NEW.duration_days IS NOT OLD.duration_days
      OR NEW.reason_code IS NOT OLD.reason_code
      OR NEW.user_visible_note IS NOT OLD.user_visible_note
      OR NEW.internal_note IS NOT OLD.internal_note
      OR NEW.business_reference IS NOT OLD.business_reference
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_membership_grant_batch_items immutable row evidence changed')
    WHEN NOT (
      (OLD.status = 'valid' AND NEW.status = 'submitting')
      OR (OLD.status = 'submit_failed' AND NEW.status = 'submitting')
      OR (OLD.status = 'submitting' AND NEW.status IN ('submitting', 'submitted', 'submit_failed'))
    )
      THEN RAISE(ABORT, 'app_membership_grant_batch_items invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_membership_grant_batch_items_delete_guard
BEFORE DELETE ON app_membership_grant_batch_items
BEGIN
  SELECT RAISE(ABORT, 'app_membership_grant_batch_items cannot be deleted');
END;

CREATE TABLE app_membership_grant_batch_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ambr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  batch_id TEXT NOT NULL REFERENCES app_membership_grant_batches(id) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'cancel')),
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  result_status TEXT NOT NULL CHECK (result_status IN ('submitted', 'partial_failed', 'cancelled')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (actor_id, idempotency_key)
);

CREATE TRIGGER trg_app_membership_grant_batch_requests_no_update
BEFORE UPDATE ON app_membership_grant_batch_requests
BEGIN
  SELECT RAISE(ABORT, 'app_membership_grant_batch_requests are immutable');
END;

CREATE TRIGGER trg_app_membership_grant_batch_requests_no_delete
BEFORE DELETE ON app_membership_grant_batch_requests
BEGIN
  SELECT RAISE(ABORT, 'app_membership_grant_batch_requests are immutable');
END;
