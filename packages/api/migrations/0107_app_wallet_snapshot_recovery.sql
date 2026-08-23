-- Wallet-3：不可变账本驱动的钱包快照重建与受控解冻。
--
-- 约束：
-- 1. 分录仍是唯一账务事实；恢复命令只能把快照重建为当前有效分录的末态；
-- 2. 恢复命令必须覆盖当前钱包全部未终结对账案件，且这些案件已由同一 Owner 认领；
-- 3. 分录链本身仍有断点时禁止恢复，不能用解冻掩盖历史完整性问题；
-- 4. 命令、案件关联和审计只追加；余额、sequence、案件关闭与解冻在同一 D1 batch 内完成。

CREATE TABLE app_wallet_recovery_commands (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'wrec_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  wallet_id TEXT NOT NULL REFERENCES app_wallets(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  anchor_case_id TEXT NOT NULL REFERENCES app_wallet_reconciliation_cases(id) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  case_set_digest TEXT NOT NULL
    CHECK (length(case_set_digest) = 64 AND case_set_digest NOT GLOB '*[^0-9a-f]*'),
  covered_case_count INTEGER NOT NULL CHECK (covered_case_count BETWEEN 1 AND 200),
  reason_code TEXT NOT NULL DEFAULT 'verified_snapshot_rebuild'
    CHECK (reason_code = 'verified_snapshot_rebuild'),
  resolution_note TEXT NOT NULL CHECK (length(trim(resolution_note)) BETWEEN 2 AND 500),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 3 AND 300),
  expected_wallet_status TEXT NOT NULL CHECK (expected_wallet_status = 'frozen'),
  expected_balance INTEGER NOT NULL CHECK (expected_balance BETWEEN 0 AND 9000000000000),
  expected_sequence INTEGER NOT NULL CHECK (expected_sequence >= 0),
  rebuilt_balance INTEGER NOT NULL CHECK (rebuilt_balance BETWEEN 0 AND 9000000000000),
  rebuilt_sequence INTEGER NOT NULL CHECK (rebuilt_sequence >= 0),
  status TEXT NOT NULL CHECK (status IN ('executing', 'applied')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  applied_at TEXT CHECK (applied_at IS NULL OR julianday(applied_at) IS NOT NULL),
  UNIQUE (actor_id, idempotency_key),
  CHECK (
    (status = 'executing' AND applied_at IS NULL)
    OR (status = 'applied' AND applied_at IS NOT NULL)
  )
);

CREATE INDEX idx_app_wallet_recovery_commands_wallet
  ON app_wallet_recovery_commands (wallet_id, created_at DESC, id DESC);
CREATE INDEX idx_app_wallet_recovery_commands_applied_wallet
  ON app_wallet_recovery_commands (wallet_id, applied_at DESC, id DESC)
  WHERE status = 'applied';
CREATE UNIQUE INDEX idx_app_wallet_recovery_commands_executing_wallet
  ON app_wallet_recovery_commands (wallet_id)
  WHERE status = 'executing';

CREATE TABLE app_wallet_recovery_case_links (
  command_id TEXT NOT NULL REFERENCES app_wallet_recovery_commands(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES app_wallet_reconciliation_cases(id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
  previous_status TEXT NOT NULL CHECK (previous_status IN ('claimed', 'resolved')),
  evidence_sha256 TEXT NOT NULL
    CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (command_id, case_id)
);

CREATE INDEX idx_app_wallet_recovery_case_links_case
  ON app_wallet_recovery_case_links (case_id, command_id);

CREATE TRIGGER trg_app_wallet_recovery_commands_insert_guard
BEFORE INSERT ON app_wallet_recovery_commands
WHEN NEW.status <> 'executing' OR NEW.applied_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_recovery_commands must start executing');
END;

CREATE TRIGGER trg_app_wallet_recovery_case_links_insert_guard
BEFORE INSERT ON app_wallet_recovery_case_links
WHEN NOT EXISTS (
  SELECT 1 FROM app_wallet_recovery_commands recovery
  WHERE recovery.id = NEW.command_id AND recovery.status = 'executing'
)
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_recovery_case_links require an executing command');
END;

-- 原始保护仍覆盖普通业务入账；只有存在精确匹配的 executing 恢复命令时，
-- 才允许快照跳转到该命令记录的重建末态。最终命令迁移 trigger 会再次验证分录链和案件集合。
DROP TRIGGER trg_app_wallet_balance_requires_entry;

CREATE TRIGGER trg_app_wallet_balance_requires_entry
BEFORE UPDATE OF balance, sequence ON app_wallets
WHEN NEW.balance <> OLD.balance OR NEW.sequence <> OLD.sequence
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM app_wallet_recovery_commands recovery
      WHERE recovery.wallet_id = OLD.id
        AND recovery.account_id = OLD.account_id
        AND recovery.status = 'executing'
        AND recovery.expected_wallet_status = OLD.status
        AND recovery.expected_balance = OLD.balance
        AND recovery.expected_sequence = OLD.sequence
        AND recovery.rebuilt_balance = NEW.balance
        AND recovery.rebuilt_sequence = NEW.sequence
    ) THEN NULL
    WHEN NEW.sequence <> OLD.sequence + 1
      THEN RAISE(ABORT, 'wallet sequence must advance by one')
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

CREATE TRIGGER trg_app_wallet_status_recovery_guard
BEFORE UPDATE OF status ON app_wallets
WHEN OLD.status = 'frozen' AND NEW.status = 'active'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM app_wallet_recovery_commands recovery
    WHERE recovery.wallet_id = OLD.id
      AND recovery.account_id = OLD.account_id
      AND recovery.status = 'executing'
      AND recovery.expected_wallet_status = OLD.status
      AND recovery.expected_balance = OLD.balance
      AND recovery.expected_sequence = OLD.sequence
      AND recovery.rebuilt_balance = NEW.balance
      AND recovery.rebuilt_sequence = NEW.sequence
  ) THEN RAISE(ABORT, 'frozen wallet requires a verified recovery command') END;
END;

-- 既有案件状态机只额外开放“同一恢复命令覆盖的 claimed -> resolved”。
-- 其他 transition、证据不可变和 version +1 规则保持不变。
DROP TRIGGER trg_app_wallet_reconciliation_cases_update_guard;

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
      OR (
        OLD.status = 'claimed'
        AND NEW.status = 'resolved'
        AND EXISTS (
          SELECT 1
          FROM app_wallet_recovery_case_links link
          JOIN app_wallet_recovery_commands recovery ON recovery.id = link.command_id
          WHERE link.case_id = OLD.id
            AND link.expected_version = OLD.version
            AND link.previous_status = 'claimed'
            AND recovery.status = 'executing'
            AND recovery.wallet_id = OLD.wallet_id
            AND recovery.account_id = OLD.account_id
            AND recovery.actor_id = OLD.assigned_to
        )
      )
    ) THEN RAISE(ABORT, 'app_wallet_reconciliation_cases invalid state transition')
  END;
END;

CREATE TRIGGER trg_app_wallet_recovery_commands_apply_guard
BEFORE UPDATE ON app_wallet_recovery_commands
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.wallet_id <> OLD.wallet_id
      OR NEW.account_id <> OLD.account_id
      OR NEW.anchor_case_id <> OLD.anchor_case_id
      OR NEW.actor_id <> OLD.actor_id
      OR NEW.idempotency_key <> OLD.idempotency_key
      OR NEW.request_hash <> OLD.request_hash
      OR NEW.case_set_digest <> OLD.case_set_digest
      OR NEW.covered_case_count <> OLD.covered_case_count
      OR NEW.reason_code <> OLD.reason_code
      OR NEW.resolution_note <> OLD.resolution_note
      OR NEW.evidence_reference <> OLD.evidence_reference
      OR NEW.expected_wallet_status <> OLD.expected_wallet_status
      OR NEW.expected_balance <> OLD.expected_balance
      OR NEW.expected_sequence <> OLD.expected_sequence
      OR NEW.rebuilt_balance <> OLD.rebuilt_balance
      OR NEW.rebuilt_sequence <> OLD.rebuilt_sequence
      OR NEW.created_at <> OLD.created_at
      THEN RAISE(ABORT, 'app_wallet_recovery_commands immutable evidence changed')
    WHEN OLD.status <> 'executing' OR NEW.status <> 'applied' OR NEW.applied_at IS NULL
      THEN RAISE(ABORT, 'app_wallet_recovery_commands invalid state transition')
    WHEN NOT EXISTS (
      SELECT 1 FROM app_wallets wallet
      WHERE wallet.id = OLD.wallet_id
        AND wallet.account_id = OLD.account_id
        AND wallet.status = 'active'
        AND wallet.balance = OLD.rebuilt_balance
        AND wallet.sequence = OLD.rebuilt_sequence
    ) THEN RAISE(ABORT, 'wallet recovery snapshot was not applied')
    WHEN OLD.rebuilt_balance <> COALESCE((
      SELECT latest.balance_after
      FROM app_wallet_entries latest
      WHERE latest.wallet_id = OLD.wallet_id
      ORDER BY latest.sequence DESC LIMIT 1
    ), 0) THEN RAISE(ABORT, 'wallet recovery balance does not match ledger')
    WHEN OLD.rebuilt_sequence <> COALESCE((
      SELECT latest.sequence
      FROM app_wallet_entries latest
      WHERE latest.wallet_id = OLD.wallet_id
      ORDER BY latest.sequence DESC LIMIT 1
    ), 0) THEN RAISE(ABORT, 'wallet recovery sequence does not match ledger')
    WHEN OLD.rebuilt_sequence <> (
      SELECT COUNT(*) FROM app_wallet_entries counted WHERE counted.wallet_id = OLD.wallet_id
    ) THEN RAISE(ABORT, 'wallet recovery ledger sequence is incomplete')
    WHEN EXISTS (
      SELECT 1
      FROM app_wallet_entries entry
      WHERE entry.wallet_id = OLD.wallet_id
        AND (
          (entry.sequence = 1 AND entry.balance_before <> 0)
          OR (
            entry.sequence > 1
            AND NOT EXISTS (
              SELECT 1 FROM app_wallet_entries previous
              WHERE previous.wallet_id = entry.wallet_id
                AND previous.sequence = entry.sequence - 1
                AND previous.balance_after = entry.balance_before
            )
            AND NOT EXISTS (
              SELECT 1
              FROM app_wallet_reconciliation_cases covered
              JOIN app_wallet_adjustments adjustment
                ON adjustment.id = covered.forward_fix_adjustment_id
              WHERE covered.status = 'resolved'
                AND adjustment.entry_id = entry.id
            )
          )
        )
    ) THEN RAISE(ABORT, 'wallet recovery ledger chain is broken')
    WHEN OLD.covered_case_count <> (
      SELECT COUNT(*) FROM app_wallet_recovery_case_links link WHERE link.command_id = OLD.id
    ) THEN RAISE(ABORT, 'wallet recovery case set is incomplete')
    WHEN EXISTS (
      SELECT 1
      FROM app_wallet_recovery_case_links link
      JOIN app_wallet_reconciliation_cases reconciliation ON reconciliation.id = link.case_id
      WHERE link.command_id = OLD.id
        AND (
          reconciliation.wallet_id <> OLD.wallet_id
          OR reconciliation.account_id <> OLD.account_id
          OR reconciliation.evidence_sha256 <> link.evidence_sha256
          OR (
            link.previous_status = 'claimed'
            AND (
              reconciliation.status <> 'resolved'
              OR reconciliation.version <> link.expected_version + 1
              OR reconciliation.assigned_to <> OLD.actor_id
            )
          )
          OR (
            link.previous_status = 'resolved'
            AND (
              reconciliation.status <> 'resolved'
              OR reconciliation.version <> link.expected_version
            )
          )
        )
    ) THEN RAISE(ABORT, 'wallet recovery linked cases were not resolved')
    WHEN EXISTS (
      SELECT 1
      FROM app_wallet_reconciliation_cases reconciliation
      WHERE reconciliation.wallet_id = OLD.wallet_id
        AND reconciliation.status NOT IN ('resolved', 'dismissed')
    ) THEN RAISE(ABORT, 'wallet recovery has unresolved cases')
  END;
END;

CREATE TRIGGER trg_app_wallet_recovery_commands_delete_guard
BEFORE DELETE ON app_wallet_recovery_commands
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_recovery_commands cannot be deleted');
END;

CREATE TRIGGER trg_app_wallet_recovery_case_links_update_guard
BEFORE UPDATE ON app_wallet_recovery_case_links
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_recovery_case_links are immutable');
END;

CREATE TRIGGER trg_app_wallet_recovery_case_links_delete_guard
BEFORE DELETE ON app_wallet_recovery_case_links
BEGIN
  SELECT RAISE(ABORT, 'app_wallet_recovery_case_links cannot be deleted');
END;
