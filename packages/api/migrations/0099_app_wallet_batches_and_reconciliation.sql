-- Wallet-2：批量调币编排与钱包账本对账控制面。
--
-- 本 migration 只建立默认关闭的治理结构：
-- - 既有 batch_adjustments_enabled 仍保持 0；新控制表 enabled 同样默认 0，配置阶段显式开放后才允许创建批量任务；
-- - 批量 CSV 每行仍创建普通 app_wallet_adjustments，逐条经过既有独立复核；
-- - 对账扫描只比较不可变分录与钱包快照，不修改钱包余额或 sequence；
-- - 差异修复只能创建追加式 forward-fix 调币申请，不提供直改余额和自动补账。

CREATE TABLE app_wallet_batch_controls (
  policy_id TEXT PRIMARY KEY REFERENCES app_wallet_policies(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  max_rows INTEGER NOT NULL DEFAULT 200 CHECK (max_rows BETWEEN 1 AND 200),
  max_total_amount INTEGER NOT NULL DEFAULT 10000000 CHECK (max_total_amount BETWEEN 1 AND 200000000),
  decision_reference TEXT
    CHECK (decision_reference IS NULL OR length(trim(decision_reference)) BETWEEN 3 AND 160),
  approved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT CHECK (approved_at IS NULL OR julianday(approved_at) IS NOT NULL),
  updated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
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

INSERT INTO app_wallet_batch_controls (
  policy_id, enabled, max_rows, max_total_amount, created_at, updated_at
) VALUES (
  'wlp_app_1_0_wallet_1_dev_1', 0, 200, 10000000,
  '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z'
);

CREATE TABLE app_wallet_adjustment_batches (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wab_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_wallet_policies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'pending_review', 'processing', 'completed', 'partial_failed', 'cancelled')),
  source_name TEXT NOT NULL CHECK (length(trim(source_name)) BETWEEN 1 AND 120),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
  total_count INTEGER NOT NULL CHECK (total_count BETWEEN 1 AND 200),
  valid_count INTEGER NOT NULL CHECK (valid_count BETWEEN 0 AND total_count),
  invalid_count INTEGER NOT NULL CHECK (invalid_count BETWEEN 0 AND total_count),
  total_amount INTEGER NOT NULL CHECK (total_amount BETWEEN 0 AND 200000000),
  risk_codes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(risk_codes_json) AND json_type(risk_codes_json) = 'array'),
  submitted_count INTEGER NOT NULL DEFAULT 0 CHECK (submitted_count BETWEEN 0 AND total_count),
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
        processing_token GLOB 'wabx_*'
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
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (created_by, request_idempotency_key),
  CHECK (valid_count + invalid_count = total_count),
  CHECK (
    (
      status IN ('draft', 'pending_review', 'cancelled')
      AND processing_started_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND processing_token IS NULL
      AND processing_idempotency_key IS NULL
      AND processing_request_hash IS NULL
      AND submitted_at IS NULL
    )
    OR (
      status = 'processing'
      AND processing_started_at IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
      AND processing_token IS NOT NULL
      AND processing_idempotency_key IS NOT NULL
      AND processing_request_hash IS NOT NULL
      AND submitted_at IS NULL
    )
    OR (
      status IN ('completed', 'partial_failed')
      AND processing_started_at IS NOT NULL
      AND processing_lease_expires_at IS NULL
      AND processing_token IS NULL
      AND processing_idempotency_key IS NOT NULL
      AND processing_request_hash IS NOT NULL
      AND submitted_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_app_wallet_adjustment_batches_queue
  ON app_wallet_adjustment_batches (status, created_at DESC, id DESC);

CREATE TRIGGER trg_app_wallet_adjustment_batches_update_guard
BEFORE UPDATE ON app_wallet_adjustment_batches
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.policy_id <> OLD.policy_id
      OR NEW.source_name <> OLD.source_name
      OR NEW.source_sha256 <> OLD.source_sha256
      OR NEW.total_count <> OLD.total_count
      OR NEW.valid_count <> OLD.valid_count
      OR NEW.invalid_count <> OLD.invalid_count
      OR NEW.total_amount <> OLD.total_amount
      OR NEW.risk_codes_json <> OLD.risk_codes_json
      OR NEW.request_idempotency_key <> OLD.request_idempotency_key
      OR NEW.request_hash <> OLD.request_hash
      OR NEW.created_by <> OLD.created_by
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_adjustment_batches immutable preview evidence changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_wallet_adjustment_batches version must increment by one')
    WHEN NEW.submitted_count < OLD.submitted_count
      THEN RAISE(ABORT, 'app_wallet_adjustment_batches submitted count cannot decrease')
    WHEN OLD.status <> 'processing' AND NEW.submitted_count <> OLD.submitted_count
      THEN RAISE(ABORT, 'app_wallet_adjustment_batches submitted count changed outside processing')
    WHEN OLD.status <> 'draft' AND OLD.status <> 'pending_review' AND OLD.status <> 'partial_failed'
      AND OLD.status <> 'processing'
      AND (
        NEW.processing_started_at IS NOT OLD.processing_started_at
        OR NEW.processing_lease_expires_at IS NOT OLD.processing_lease_expires_at
        OR NEW.processing_token IS NOT OLD.processing_token
        OR NEW.processing_idempotency_key IS NOT OLD.processing_idempotency_key
        OR NEW.processing_request_hash IS NOT OLD.processing_request_hash
        OR NEW.submitted_at IS NOT OLD.submitted_at
      )
      THEN RAISE(ABORT, 'app_wallet_adjustment_batches processing evidence changed outside processing')
    WHEN NOT (
      (OLD.status = 'draft' AND NEW.status IN ('pending_review', 'processing', 'cancelled'))
      OR (OLD.status = 'pending_review' AND NEW.status IN ('processing', 'cancelled'))
      OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'completed', 'partial_failed'))
      OR (OLD.status = 'partial_failed' AND NEW.status IN ('processing', 'cancelled'))
    )
      THEN RAISE(ABORT, 'app_wallet_adjustment_batches invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_adjustment_batches_delete_guard
BEFORE DELETE ON app_wallet_adjustment_batches
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_adjustment_batches cannot be deleted');
END;

CREATE TRIGGER trg_app_wallet_batch_controls_delete_guard
BEFORE DELETE ON app_wallet_batch_controls
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_batch_controls cannot be deleted');
END;

CREATE TABLE app_wallet_adjustment_batch_items (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wabi_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  batch_id TEXT NOT NULL REFERENCES app_wallet_adjustment_batches(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK (row_number BETWEEN 1 AND 200),
  row_sha256 TEXT NOT NULL
    CHECK (length(row_sha256) = 64 AND row_sha256 NOT GLOB '*[^a-f0-9]*'),
  raw_row_json TEXT NOT NULL CHECK (json_valid(raw_row_json) AND json_type(raw_row_json) = 'object'),
  account_public_id TEXT CHECK (account_public_id IS NULL OR length(trim(account_public_id)) BETWEEN 5 AND 80),
  action_type TEXT CHECK (action_type IS NULL OR action_type IN ('admin_credit', 'admin_debit', 'compensation')),
  amount INTEGER CHECK (amount IS NULL OR amount BETWEEN 1 AND 1000000),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN ('manual_adjustment', 'service_compensation', 'correction')),
  user_visible_note TEXT CHECK (user_visible_note IS NULL OR length(trim(user_visible_note)) BETWEEN 2 AND 160),
  internal_note TEXT CHECK (internal_note IS NULL OR length(trim(internal_note)) BETWEEN 2 AND 500),
  business_reference TEXT CHECK (business_reference IS NULL OR length(trim(business_reference)) BETWEEN 3 AND 80),
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'submitting', 'submitted', 'submit_failed')),
  error_code TEXT,
  error_summary TEXT CHECK (error_summary IS NULL OR length(trim(error_summary)) BETWEEN 1 AND 300),
  processing_token TEXT
    CHECK (
      processing_token IS NULL
      OR (
        processing_token GLOB 'wabx_*'
        AND processing_token NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(processing_token) BETWEEN 6 AND 96
      )
    ),
  adjustment_id TEXT REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (batch_id, row_number),
  CHECK (status <> 'submitted' OR adjustment_id IS NOT NULL),
  CHECK (
    status = 'invalid'
    OR (
      account_public_id IS NOT NULL AND action_type IS NOT NULL AND amount IS NOT NULL
      AND reason_code IS NOT NULL AND user_visible_note IS NOT NULL
      AND internal_note IS NOT NULL AND business_reference IS NOT NULL
    )
  ),
  CHECK (
    (status = 'valid' AND adjustment_id IS NULL AND error_code IS NULL AND error_summary IS NULL)
    OR (status = 'invalid' AND adjustment_id IS NULL AND error_code IS NOT NULL AND error_summary IS NOT NULL)
    OR (status = 'submitting' AND adjustment_id IS NULL AND error_code IS NULL AND error_summary IS NULL)
    OR (status = 'submit_failed' AND adjustment_id IS NULL AND error_code IS NOT NULL AND error_summary IS NOT NULL)
    OR (status = 'submitted' AND adjustment_id IS NOT NULL AND error_code IS NULL AND error_summary IS NULL)
  ),
  CHECK (
    (status = 'submitting' AND processing_token IS NOT NULL)
    OR (status <> 'submitting' AND processing_token IS NULL)
  )
);

CREATE INDEX idx_app_wallet_adjustment_batch_items_status
  ON app_wallet_adjustment_batch_items (batch_id, status, row_number ASC);
CREATE UNIQUE INDEX idx_app_wallet_adjustment_batch_items_business_reference
  ON app_wallet_adjustment_batch_items (batch_id, business_reference)
  WHERE business_reference IS NOT NULL AND status <> 'invalid';

CREATE TRIGGER trg_app_wallet_adjustment_batch_items_update_guard
BEFORE UPDATE ON app_wallet_adjustment_batch_items
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.batch_id <> OLD.batch_id
      OR NEW.row_number <> OLD.row_number
      OR NEW.row_sha256 <> OLD.row_sha256
      OR NEW.raw_row_json <> OLD.raw_row_json
      OR NEW.account_public_id IS NOT OLD.account_public_id
      OR NEW.action_type IS NOT OLD.action_type
      OR NEW.amount IS NOT OLD.amount
      OR NEW.reason_code IS NOT OLD.reason_code
      OR NEW.user_visible_note IS NOT OLD.user_visible_note
      OR NEW.internal_note IS NOT OLD.internal_note
      OR NEW.business_reference IS NOT OLD.business_reference
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_adjustment_batch_items immutable row evidence changed')
    WHEN NOT (
      (OLD.status = 'valid' AND NEW.status = 'submitting')
      OR (OLD.status = 'submit_failed' AND NEW.status = 'submitting')
      OR (OLD.status = 'submitting' AND NEW.status IN ('submitting', 'submitted', 'submit_failed'))
    )
      THEN RAISE(ABORT, 'app_wallet_adjustment_batch_items invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_adjustment_batch_items_delete_guard
BEFORE DELETE ON app_wallet_adjustment_batch_items
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_adjustment_batch_items cannot be deleted');
END;

CREATE TABLE app_wallet_adjustment_batch_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wabr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  batch_id TEXT NOT NULL REFERENCES app_wallet_adjustment_batches(id) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  result_status TEXT NOT NULL CHECK (result_status IN ('completed', 'partial_failed')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (actor_id, idempotency_key)
);

CREATE TRIGGER trg_app_wallet_adjustment_batch_requests_immutable_update
BEFORE UPDATE ON app_wallet_adjustment_batch_requests
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_adjustment_batch_requests are immutable');
END;

CREATE TRIGGER trg_app_wallet_adjustment_batch_requests_immutable_delete
BEFORE DELETE ON app_wallet_adjustment_batch_requests
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_adjustment_batch_requests are immutable');
END;

CREATE TABLE app_wallet_reconciliation_runs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wrc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_wallet_policies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  wallet_count INTEGER NOT NULL DEFAULT 0 CHECK (wallet_count >= 0),
  difference_count INTEGER NOT NULL DEFAULT 0 CHECK (difference_count >= 0),
  request_idempotency_key TEXT NOT NULL CHECK (length(request_idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  execution_token TEXT UNIQUE
    CHECK (
      execution_token IS NULL
      OR (
        execution_token GLOB 'wrcx_*'
        AND execution_token NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(execution_token) BETWEEN 6 AND 96
      )
    ),
  failure_code TEXT CHECK (failure_code IS NULL OR length(trim(failure_code)) BETWEEN 3 AND 80),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (created_by, request_idempotency_key),
  CHECK (
    (status = 'running' AND lease_expires_at IS NOT NULL AND execution_token IS NOT NULL AND completed_at IS NULL AND failure_code IS NULL)
    OR (status = 'completed' AND lease_expires_at IS NULL AND execution_token IS NULL AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND lease_expires_at IS NULL AND execution_token IS NULL AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX idx_app_wallet_reconciliation_runs_time
  ON app_wallet_reconciliation_runs (created_at DESC, id DESC);

CREATE TRIGGER trg_app_wallet_reconciliation_runs_update_guard
BEFORE UPDATE ON app_wallet_reconciliation_runs
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.policy_id <> OLD.policy_id
      OR NEW.request_idempotency_key <> OLD.request_idempotency_key
      OR NEW.request_hash <> OLD.request_hash
      OR NEW.created_by <> OLD.created_by
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_reconciliation_runs immutable request evidence changed')
    WHEN NOT (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
      THEN RAISE(ABORT, 'app_wallet_reconciliation_runs invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_reconciliation_runs_delete_guard
BEFORE DELETE ON app_wallet_reconciliation_runs
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_reconciliation_runs cannot be deleted');
END;

CREATE TABLE app_wallet_reconciliation_cases (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wrd_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  run_id TEXT NOT NULL REFERENCES app_wallet_reconciliation_runs(id) ON DELETE RESTRICT,
  wallet_id TEXT REFERENCES app_wallets(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_public_id TEXT NOT NULL CHECK (length(trim(account_public_id)) BETWEEN 5 AND 80),
  difference_type TEXT NOT NULL CHECK (difference_type IN ('balance_mismatch', 'sequence_mismatch', 'entry_chain_break')),
  severity TEXT NOT NULL CHECK (severity IN ('p0', 'p1', 'p2')),
  wallet_balance INTEGER NOT NULL,
  expected_balance INTEGER NOT NULL,
  wallet_sequence INTEGER NOT NULL CHECK (wallet_sequence >= 0),
  expected_sequence INTEGER NOT NULL CHECK (expected_sequence >= 0),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'creating_forward_fix', 'forward_fix_requested', 'resolved', 'dismissed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  assigned_to INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at TEXT CHECK (claimed_at IS NULL OR julianday(claimed_at) IS NOT NULL),
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(trim(resolution_note)) BETWEEN 2 AND 500),
  forward_fix_adjustment_id TEXT REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  mutation_token TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (run_id, account_id, difference_type),
  CHECK (status NOT IN ('claimed', 'creating_forward_fix', 'forward_fix_requested', 'resolved') OR (assigned_to IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (status <> 'creating_forward_fix' OR mutation_token IS NOT NULL),
  CHECK (status = 'creating_forward_fix' OR mutation_token IS NULL),
  CHECK (status <> 'forward_fix_requested' OR forward_fix_adjustment_id IS NOT NULL)
);

CREATE INDEX idx_app_wallet_reconciliation_cases_queue
  ON app_wallet_reconciliation_cases (status, severity, created_at ASC, id ASC);

CREATE TRIGGER trg_app_wallet_reconciliation_cases_update_guard
BEFORE UPDATE ON app_wallet_reconciliation_cases
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.run_id <> OLD.run_id
      OR NEW.wallet_id IS NOT OLD.wallet_id
      OR NEW.account_id <> OLD.account_id
      OR NEW.account_public_id <> OLD.account_public_id
      OR NEW.difference_type <> OLD.difference_type
      OR NEW.severity <> OLD.severity
      OR NEW.wallet_balance <> OLD.wallet_balance
      OR NEW.expected_balance <> OLD.expected_balance
      OR NEW.wallet_sequence <> OLD.wallet_sequence
      OR NEW.expected_sequence <> OLD.expected_sequence
      OR NEW.evidence_sha256 <> OLD.evidence_sha256
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_reconciliation_cases immutable evidence changed')
    WHEN NEW.version <> OLD.version + 1
      THEN RAISE(ABORT, 'app_wallet_reconciliation_cases version must increment by one')
    WHEN NOT (
      (OLD.status = 'open' AND NEW.status IN ('claimed', 'dismissed'))
      OR (OLD.status = 'claimed' AND NEW.status IN ('creating_forward_fix', 'dismissed'))
      OR (OLD.status = 'creating_forward_fix' AND NEW.status IN ('claimed', 'forward_fix_requested'))
      OR (OLD.status = 'forward_fix_requested' AND NEW.status = 'resolved')
    )
      THEN RAISE(ABORT, 'app_wallet_reconciliation_cases invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_reconciliation_cases_delete_guard
BEFORE DELETE ON app_wallet_reconciliation_cases
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_reconciliation_cases cannot be deleted');
END;

CREATE TABLE app_wallet_reconciliation_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wre_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  case_id TEXT NOT NULL REFERENCES app_wallet_reconciliation_cases(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('detected', 'claimed', 'forward_fix_requested', 'resolved', 'dismissed')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (case_id, sequence)
);

CREATE TRIGGER trg_app_wallet_reconciliation_events_immutable_update
BEFORE UPDATE ON app_wallet_reconciliation_events
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_reconciliation_events are immutable');
END;

CREATE TRIGGER trg_app_wallet_reconciliation_events_immutable_delete
BEFORE DELETE ON app_wallet_reconciliation_events
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_reconciliation_events are immutable');
END;
