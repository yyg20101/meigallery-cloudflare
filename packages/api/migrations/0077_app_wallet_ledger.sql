-- Wallet-1：默认关闭的 App 金币钱包、追加式账本与管理员单笔调币。
--
-- 本 migration 只建立 development 策略、空钱包表族和 Wallet-1 通知连接：
-- - 不创建账号钱包、余额、调币申请或分录 seed，不迁移 legacy 余额；
-- - adjustments_enabled 默认关闭，production_ready 默认关闭；
-- - OQ-018 未关闭时强制所有调币独立复核，并禁止负余额；
-- - OQ-020/OQ-024 未关闭时不启用自动清理，也不接入生产钱包数据；
-- - 不包含充值、支付、礼物、装扮、消费、转账、提现或批量调币。

CREATE TABLE app_wallet_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wlp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      version_code NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(version_code) BETWEEN 3 AND 80
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  adjustments_enabled INTEGER NOT NULL DEFAULT 0 CHECK (adjustments_enabled IN (0, 1)),
  risk_decision_status TEXT NOT NULL CHECK (risk_decision_status IN ('unresolved', 'approved')),
  retention_decision_status TEXT NOT NULL CHECK (retention_decision_status IN ('unresolved', 'approved')),
  data_location_decision_status TEXT NOT NULL CHECK (data_location_decision_status IN ('unresolved', 'approved')),
  require_independent_review INTEGER NOT NULL DEFAULT 1 CHECK (require_independent_review = 1),
  allow_negative_balance INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative_balance = 0),
  batch_adjustments_enabled INTEGER NOT NULL DEFAULT 0 CHECK (batch_adjustments_enabled = 0),
  migration_entries_enabled INTEGER NOT NULL DEFAULT 0 CHECK (migration_entries_enabled = 0),
  max_single_amount INTEGER NOT NULL DEFAULT 1000000
    CHECK (max_single_amount BETWEEN 1 AND 1000000),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (
    production_ready = 0
    OR (
      state = 'published'
      AND risk_decision_status = 'approved'
      AND retention_decision_status = 'approved'
      AND data_location_decision_status = 'approved'
      AND retention_days IS NOT NULL
    )
  ),
  CHECK (adjustments_enabled = 0 OR state IN ('development', 'published'))
);

INSERT INTO app_wallet_policies (
  id,
  version_code,
  state,
  production_ready,
  adjustments_enabled,
  risk_decision_status,
  retention_decision_status,
  data_location_decision_status,
  require_independent_review,
  allow_negative_balance,
  batch_adjustments_enabled,
  migration_entries_enabled,
  max_single_amount,
  retention_days,
  created_at
) VALUES (
  'wlp_app_1_0_wallet_1_dev_1',
  'app-1.0-wallet-1-dev-1',
  'development',
  0,
  0,
  'unresolved',
  'unresolved',
  'unresolved',
  1,
  0,
  0,
  0,
  1000000,
  NULL,
  '2026-08-08T00:00:00.000Z'
);

CREATE TABLE app_wallets (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wlt_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  account_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  currency_code TEXT NOT NULL DEFAULT 'mei_coin' CHECK (currency_code = 'mei_coin'),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 9000000000000),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  last_entry_at TEXT CHECK (last_entry_at IS NULL OR julianday(last_entry_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE INDEX idx_app_wallets_status ON app_wallets (status, updated_at DESC);

CREATE TABLE app_wallet_adjustments (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wad_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_wallet_policies(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL
    CHECK (action_type IN ('admin_credit', 'admin_debit', 'compensation', 'reversal')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('manual_adjustment', 'service_compensation', 'correction', 'reversal')),
  user_visible_note TEXT NOT NULL CHECK (length(trim(user_visible_note)) BETWEEN 2 AND 160),
  internal_note TEXT NOT NULL CHECK (length(trim(internal_note)) BETWEEN 2 AND 500),
  business_reference TEXT NOT NULL
    CHECK (
      length(business_reference) BETWEEN 3 AND 80
      AND business_reference NOT GLOB '*[^A-Za-z0-9._:/-]*'
    ),
  original_entry_id TEXT,
  preview_balance INTEGER NOT NULL CHECK (preview_balance BETWEEN 0 AND 9000000000000),
  preview_sequence INTEGER NOT NULL CHECK (preview_sequence >= 0),
  projected_balance INTEGER NOT NULL CHECK (projected_balance BETWEEN 0 AND 9000000000000),
  status TEXT NOT NULL
    CHECK (status IN ('pending_review', 'executing', 'applied', 'rejected', 'cancelled', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  request_idempotency_key TEXT NOT NULL
    CHECK (
      length(request_idempotency_key) BETWEEN 8 AND 128
      AND request_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 2 AND 300),
  entry_id TEXT UNIQUE,
  mutation_token TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  applied_at TEXT CHECK (applied_at IS NULL OR julianday(applied_at) IS NOT NULL),
  UNIQUE (account_id, business_reference),
  UNIQUE (requested_by, request_idempotency_key),
  CHECK (
    (action_type = 'admin_credit' AND direction = 'credit' AND original_entry_id IS NULL)
    OR (action_type = 'admin_debit' AND direction = 'debit' AND original_entry_id IS NULL)
    OR (action_type = 'compensation' AND direction = 'credit' AND original_entry_id IS NULL)
    OR (action_type = 'reversal' AND original_entry_id IS NOT NULL)
  ),
  CHECK (
    status <> 'applied'
    OR (
      entry_id IS NOT NULL
      AND reviewed_by IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND applied_at IS NOT NULL
      AND mutation_token IS NOT NULL
    )
  ),
  CHECK (status <> 'rejected' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE INDEX idx_app_wallet_adjustments_account
  ON app_wallet_adjustments (account_id, created_at DESC, id DESC);
CREATE INDEX idx_app_wallet_adjustments_queue
  ON app_wallet_adjustments (status, created_at ASC, id ASC);

CREATE TABLE app_wallet_entries (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wle_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  wallet_id TEXT NOT NULL REFERENCES app_wallets(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  action_type TEXT NOT NULL
    CHECK (action_type IN ('admin_credit', 'admin_debit', 'compensation', 'reversal')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('manual_adjustment', 'service_compensation', 'correction', 'reversal')),
  user_visible_note TEXT NOT NULL CHECK (length(trim(user_visible_note)) BETWEEN 2 AND 160),
  public_reference TEXT NOT NULL UNIQUE
    CHECK (
      public_reference GLOB 'WAL-*'
      AND public_reference NOT GLOB '*[^A-Z0-9-]*'
      AND length(public_reference) BETWEEN 12 AND 48
    ),
  business_reference TEXT NOT NULL
    CHECK (
      length(business_reference) BETWEEN 3 AND 80
      AND business_reference NOT GLOB '*[^A-Za-z0-9._:/-]*'
    ),
  adjustment_id TEXT NOT NULL UNIQUE REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  original_entry_id TEXT REFERENCES app_wallet_entries(id) ON DELETE RESTRICT,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  balance_before INTEGER NOT NULL CHECK (balance_before BETWEEN 0 AND 9000000000000),
  balance_after INTEGER NOT NULL CHECK (balance_after BETWEEN 0 AND 9000000000000),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status = 'posted'),
  posted_at TEXT NOT NULL CHECK (julianday(posted_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (wallet_id, sequence),
  CHECK (
    (direction = 'credit' AND balance_after = balance_before + amount)
    OR (direction = 'debit' AND balance_after = balance_before - amount)
  ),
  CHECK ((action_type = 'reversal') = (original_entry_id IS NOT NULL))
);

CREATE INDEX idx_app_wallet_entries_account_time
  ON app_wallet_entries (account_id, posted_at DESC, id DESC);
CREATE INDEX idx_app_wallet_entries_account_direction
  ON app_wallet_entries (account_id, direction, posted_at DESC, id DESC);
CREATE UNIQUE INDEX idx_app_wallet_entries_single_reversal
  ON app_wallet_entries (original_entry_id)
  WHERE original_entry_id IS NOT NULL;

CREATE TRIGGER trg_app_wallet_entries_immutable_update
BEFORE UPDATE ON app_wallet_entries
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_entries are immutable');
END;

CREATE TRIGGER trg_app_wallet_entries_immutable_delete
BEFORE DELETE ON app_wallet_entries
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_entries are immutable');
END;

CREATE TRIGGER trg_app_wallet_balance_requires_entry
BEFORE UPDATE OF balance, sequence ON app_wallets
WHEN NEW.balance <> OLD.balance OR NEW.sequence <> OLD.sequence
BEGIN
  SELECT CASE
    WHEN NEW.sequence <> OLD.sequence + 1 THEN RAISE(ABORT, 'wallet sequence must advance by one')
    WHEN NOT EXISTS (
      SELECT 1
      FROM app_wallet_entries entry
      WHERE entry.wallet_id = OLD.id
        AND entry.account_id = OLD.account_id
        AND entry.sequence = NEW.sequence
        AND entry.balance_before = OLD.balance
        AND entry.balance_after = NEW.balance
    ) THEN RAISE(ABORT, 'wallet balance change requires posted entry')
  END;
END;

CREATE TABLE app_wallet_adjustment_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wae_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  adjustment_id TEXT NOT NULL REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('submitted', 'approved_applied', 'rejected', 'execution_conflict')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  result_code TEXT NOT NULL
    CHECK (result_code IN ('pending_review', 'applied', 'rejected', 'wallet_changed')),
  entry_id TEXT REFERENCES app_wallet_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (adjustment_id, sequence)
);

CREATE TRIGGER trg_app_wallet_adjustment_events_immutable_update
BEFORE UPDATE ON app_wallet_adjustment_events
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_adjustment_events are immutable');
END;

CREATE TRIGGER trg_app_wallet_adjustment_events_immutable_delete
BEFORE DELETE ON app_wallet_adjustment_events
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_adjustment_events are immutable');
END;

CREATE TABLE app_wallet_review_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wrr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  adjustment_id TEXT NOT NULL REFERENCES app_wallet_adjustments(id) ON DELETE RESTRICT,
  reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 8 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  result_status TEXT NOT NULL CHECK (result_status IN ('applied', 'rejected')),
  entry_id TEXT REFERENCES app_wallet_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (reviewer_id, idempotency_key)
);

CREATE TRIGGER trg_app_wallet_review_requests_immutable_update
BEFORE UPDATE ON app_wallet_review_requests
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_review_requests are immutable');
END;

CREATE TRIGGER trg_app_wallet_review_requests_immutable_delete
BEFORE DELETE ON app_wallet_review_requests
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_review_requests are immutable');
END;

-- Wallet-1 只激活既有的必要通知事件；总通知策略仍默认 generation_enabled=0。
UPDATE app_notification_event_definitions
SET active = 1
WHERE id = 'nde_wallet_entry_posted'
  AND event_type = 'wallet.entry_posted'
  AND active = 0;

INSERT INTO app_notification_template_versions (
  id,
  event_definition_id,
  version_code,
  state,
  title_text,
  summary_text,
  body_text,
  created_at
) VALUES (
  'ntv_wallet_entry_posted_v1',
  'nde_wallet_entry_posted',
  'wallet-entry-posted-v1',
  'development',
  '金币余额已更新',
  '一笔管理员金币调整已生效，请查看权威余额与明细。',
  '通知只提示账本结果；打开金币明细后会重新读取分录、余额和冲正关系。金币当前不可购买、消费、转赠、兑换或提现。',
  '2026-08-08T00:00:00.000Z'
);

CREATE TRIGGER trg_app_wallet_entry_notification_outbox
AFTER INSERT ON app_wallet_entries
WHEN NEW.status = 'posted'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id,
    policy_id,
    event_definition_id,
    account_id,
    event_type,
    event_ref,
    target_type,
    target_id,
    status,
    attempts,
    next_attempt_at,
    created_at
  )
  SELECT
    'nto_wal_' || NEW.id,
    policy.id,
    definition.id,
    NEW.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.id,
    'pending',
    0,
    NEW.posted_at,
    NEW.posted_at
  FROM app_notification_policies policy
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'wallet.entry_posted'
   AND definition.active = 1
  WHERE policy.generation_enabled = 1;
END;
