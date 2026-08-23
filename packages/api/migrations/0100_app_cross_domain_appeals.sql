-- Account/Settings-3：APP-SET-08、ADM-SAF-03/04 跨领域申诉工作流。
--
-- 本 migration 不启用运行时开关，也不把 Figma 示例中的“48 小时”固化为生产承诺：
-- - 举报结论继续使用 app_safety_appeals；账号限制与金币分录使用 app_service_appeals；
-- - 统一的 review_state、补充材料和升级事件只表达复核工作流，不直接改写原业务对象；
-- - 管理员领取、请求补充、升级及结论继续执行原审核人隔离、乐观锁、幂等和审计；
-- - 处理时限由策略快照决定，当前 development 策略没有正式 SLA，因此 review_due_at 默认 NULL；
-- - 事件、补充材料和命令均为追加事实，禁止更新或删除。

ALTER TABLE app_account_security
  ADD COLUMN restriction_version INTEGER NOT NULL DEFAULT 0
  CHECK (restriction_version >= 0);

ALTER TABLE app_account_security
  ADD COLUMN restriction_reference TEXT
  CHECK (
    restriction_reference IS NULL
    OR (
      restriction_reference GLOB 'SEC-*'
      AND restriction_reference NOT GLOB '*[^A-Z0-9-]*'
      AND length(restriction_reference) BETWEEN 12 AND 32
    )
  );

ALTER TABLE app_account_security
  ADD COLUMN restriction_decision_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;

UPDATE app_account_security
SET restriction_version = 1,
    restriction_reference = 'SEC-' || upper(substr(hex(randomblob(8)), 1, 12))
WHERE status = 'restricted';

CREATE UNIQUE INDEX idx_app_account_security_restriction_reference
  ON app_account_security (restriction_reference)
  WHERE restriction_reference IS NOT NULL;

CREATE TRIGGER trg_app_account_security_restriction_reference_insert
AFTER INSERT ON app_account_security
WHEN NEW.status = 'restricted' AND NEW.restriction_reference IS NULL
BEGIN
  UPDATE app_account_security
  SET restriction_version = 1,
      restriction_reference = 'SEC-' || upper(substr(hex(randomblob(8)), 1, 12))
  WHERE account_id = NEW.account_id
    AND status = 'restricted'
    AND restriction_reference IS NULL;
END;

CREATE TRIGGER trg_app_account_security_restriction_reference_update
AFTER UPDATE OF status, restriction_reason_code, restricted_until, restriction_decision_admin_id ON app_account_security
WHEN NEW.status = 'restricted'
  AND (
    OLD.status <> 'restricted'
    OR NEW.restriction_reason_code IS NOT OLD.restriction_reason_code
    OR NEW.restricted_until IS NOT OLD.restricted_until
    OR NEW.restriction_decision_admin_id IS NOT OLD.restriction_decision_admin_id
  )
BEGIN
  UPDATE app_account_security
  SET restriction_version = OLD.restriction_version + 1,
      restriction_reference = 'SEC-' || upper(substr(hex(randomblob(8)), 1, 12))
  WHERE account_id = NEW.account_id AND status = 'restricted';
END;

ALTER TABLE app_safety_appeal_policies
  ADD COLUMN review_sla_hours INTEGER
  CHECK (review_sla_hours IS NULL OR review_sla_hours BETWEEN 1 AND 2160);

ALTER TABLE app_safety_appeal_policies
  ADD COLUMN review_sla_decision_status TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (review_sla_decision_status IN ('unresolved', 'approved'));

ALTER TABLE app_safety_appeals
  ADD COLUMN review_state TEXT NOT NULL DEFAULT 'normal'
  CHECK (review_state IN ('normal', 'evidence_insufficient', 'needs_escalation'));

ALTER TABLE app_safety_appeals
  ADD COLUMN review_due_at TEXT
  CHECK (review_due_at IS NULL OR julianday(review_due_at) IS NOT NULL);

ALTER TABLE app_safety_appeals
  ADD COLUMN supplement_due_at TEXT
  CHECK (supplement_due_at IS NULL OR julianday(supplement_due_at) IS NOT NULL);

CREATE TABLE app_service_appeals (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'bap_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('account_restriction', 'wallet_entry')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 5 AND 96),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 80),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 5 AND 80),
  source_label TEXT NOT NULL CHECK (length(trim(source_label)) BETWEEN 2 AND 80),
  source_snapshot_json TEXT NOT NULL CHECK (json_valid(source_snapshot_json)),
  source_snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(source_snapshot_sha256) = 64
      AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  original_decision_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  statement_text TEXT NOT NULL CHECK (length(trim(statement_text)) BETWEEN 1 AND 500),
  statement_sha256 TEXT NOT NULL
    CHECK (
      length(statement_sha256) = 64
      AND statement_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'triaged', 'investigating', 'upheld', 'changed', 'closed')),
  review_state TEXT NOT NULL DEFAULT 'normal'
    CHECK (review_state IN ('normal', 'evidence_insufficient', 'needs_escalation')),
  user_visible_status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (user_visible_status IN ('submitted', 'processing', 'upheld', 'changed', 'closed')),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  policy_id TEXT NOT NULL REFERENCES app_safety_appeal_policies(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  submitted_at TEXT NOT NULL CHECK (julianday(submitted_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  review_due_at TEXT CHECK (review_due_at IS NULL OR julianday(review_due_at) IS NOT NULL),
  supplement_due_at TEXT CHECK (supplement_due_at IS NULL OR julianday(supplement_due_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  UNIQUE (account_id, source_type, source_id, source_version),
  CHECK (original_decision_admin_id IS NULL OR assigned_admin_id IS NULL OR assigned_admin_id <> original_decision_admin_id),
  CHECK (
    (status IN ('upheld', 'changed', 'closed') AND resolved_at IS NOT NULL)
    OR (status IN ('submitted', 'triaged', 'investigating') AND resolved_at IS NULL)
  ),
  CHECK (review_state = 'evidence_insufficient' OR supplement_due_at IS NULL)
);

CREATE INDEX idx_app_service_appeals_account_time
  ON app_service_appeals (account_id, submitted_at DESC, id ASC);

CREATE INDEX idx_app_service_appeals_account_updated
  ON app_service_appeals (account_id, updated_at DESC, id ASC);

CREATE INDEX idx_app_safety_appeals_account_updated
  ON app_safety_appeals (account_id, updated_at DESC, id ASC);

CREATE INDEX idx_app_service_appeals_queue
  ON app_service_appeals (status, review_state, submitted_at ASC, id ASC);

CREATE INDEX idx_app_service_appeals_assignment
  ON app_service_appeals (assigned_admin_id, status, updated_at ASC)
  WHERE assigned_admin_id IS NOT NULL;

CREATE INDEX idx_app_service_appeals_due
  ON app_service_appeals (review_due_at, status)
  WHERE review_due_at IS NOT NULL;

CREATE TABLE app_service_appeal_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'bae_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  appeal_id TEXT NOT NULL REFERENCES app_service_appeals(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('viewer', 'admin', 'system')),
  actor_account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('submitted', 'claimed', 'supplement_requested', 'supplement_added', 'escalated', 'upheld', 'changed', 'closed')),
  status_from TEXT,
  status_to TEXT NOT NULL
    CHECK (status_to IN ('submitted', 'triaged', 'investigating', 'upheld', 'changed', 'closed')),
  review_state_from TEXT
    CHECK (review_state_from IS NULL OR review_state_from IN ('normal', 'evidence_insufficient', 'needs_escalation')),
  review_state_to TEXT NOT NULL
    CHECK (review_state_to IN ('normal', 'evidence_insufficient', 'needs_escalation')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 80),
  user_visible_status TEXT NOT NULL
    CHECK (user_visible_status IN ('submitted', 'processing', 'upheld', 'changed', 'closed')),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (appeal_id, sequence),
  CHECK (
    (actor_type = 'viewer' AND actor_account_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_account_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_account_id IS NULL AND actor_admin_id IS NULL)
  )
);

CREATE TABLE app_service_appeal_supplements (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'bas_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  appeal_id TEXT NOT NULL REFERENCES app_service_appeals(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note_text TEXT NOT NULL CHECK (length(trim(note_text)) BETWEEN 1 AND 500),
  note_sha256 TEXT NOT NULL
    CHECK (length(note_sha256) = 64 AND note_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (appeal_id, sequence)
);

CREATE TABLE app_appeal_review_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'are_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  appeal_kind TEXT NOT NULL CHECK (appeal_kind IN ('report', 'service')),
  appeal_id TEXT NOT NULL CHECK (length(appeal_id) BETWEEN 5 AND 80),
  appeal_version INTEGER NOT NULL CHECK (appeal_version > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('viewer', 'admin', 'system')),
  actor_account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('supplement_requested', 'supplement_added', 'escalated')),
  review_state_from TEXT NOT NULL
    CHECK (review_state_from IN ('normal', 'evidence_insufficient', 'needs_escalation')),
  review_state_to TEXT NOT NULL
    CHECK (review_state_to IN ('normal', 'evidence_insufficient', 'needs_escalation')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 80),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (appeal_kind, appeal_id, appeal_version),
  CHECK (
    (actor_type = 'viewer' AND actor_account_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_account_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_account_id IS NULL AND actor_admin_id IS NULL)
  )
);

CREATE INDEX idx_app_appeal_review_events_target
  ON app_appeal_review_events (appeal_kind, appeal_id, appeal_version ASC);

CREATE TABLE app_safety_appeal_supplements (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aas_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  appeal_id TEXT NOT NULL REFERENCES app_safety_appeals(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note_text TEXT NOT NULL CHECK (length(trim(note_text)) BETWEEN 1 AND 500),
  note_sha256 TEXT NOT NULL
    CHECK (length(note_sha256) = 64 AND note_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (appeal_id, sequence)
);

CREATE TABLE app_appeal_review_commands (
  actor_scope TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 3 AND 96),
  appeal_kind TEXT NOT NULL CHECK (appeal_kind IN ('report', 'service')),
  operation TEXT NOT NULL
    CHECK (operation IN ('appeal_supplement_request', 'appeal_supplement_add', 'appeal_escalate')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 5 AND 80),
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (actor_scope, operation, idempotency_key)
);

CREATE TABLE app_service_appeal_idempotency (
  actor_scope TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 3 AND 96),
  operation TEXT NOT NULL
    CHECK (operation IN ('appeal_create', 'appeal_claim', 'appeal_supplement_request', 'appeal_supplement_add', 'appeal_escalate', 'appeal_decision')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_id TEXT NOT NULL REFERENCES app_service_appeals(id) ON DELETE RESTRICT,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (actor_scope, operation, idempotency_key)
);

CREATE TRIGGER trg_app_service_appeal_events_immutable_update
BEFORE UPDATE ON app_service_appeal_events
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeal_events are immutable');
END;

CREATE TRIGGER trg_app_service_appeal_events_immutable_delete
BEFORE DELETE ON app_service_appeal_events
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeal_events are immutable');
END;

CREATE TRIGGER trg_app_service_appeal_supplements_immutable_update
BEFORE UPDATE ON app_service_appeal_supplements
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeal_supplements are immutable');
END;

CREATE TRIGGER trg_app_service_appeal_supplements_immutable_delete
BEFORE DELETE ON app_service_appeal_supplements
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeal_supplements are immutable');
END;

CREATE TRIGGER trg_app_safety_appeal_supplements_immutable_update
BEFORE UPDATE ON app_safety_appeal_supplements
BEGIN
  SELECT RAISE(ABORT, 'app_safety_appeal_supplements are immutable');
END;

CREATE TRIGGER trg_app_safety_appeal_supplements_immutable_delete
BEFORE DELETE ON app_safety_appeal_supplements
BEGIN
  SELECT RAISE(ABORT, 'app_safety_appeal_supplements are immutable');
END;

CREATE TRIGGER trg_app_appeal_review_events_immutable_update
BEFORE UPDATE ON app_appeal_review_events
BEGIN
  SELECT RAISE(ABORT, 'app_appeal_review_events are immutable');
END;

CREATE TRIGGER trg_app_appeal_review_events_immutable_delete
BEFORE DELETE ON app_appeal_review_events
BEGIN
  SELECT RAISE(ABORT, 'app_appeal_review_events are immutable');
END;

CREATE TRIGGER trg_app_appeal_review_commands_immutable_update
BEFORE UPDATE ON app_appeal_review_commands
BEGIN
  SELECT RAISE(ABORT, 'app_appeal_review_commands are immutable');
END;

CREATE TRIGGER trg_app_appeal_review_commands_immutable_delete
BEFORE DELETE ON app_appeal_review_commands
BEGIN
  SELECT RAISE(ABORT, 'app_appeal_review_commands are immutable');
END;

CREATE TRIGGER trg_app_service_appeal_idempotency_immutable_update
BEFORE UPDATE ON app_service_appeal_idempotency
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeal_idempotency rows are immutable');
END;

CREATE TRIGGER trg_app_service_appeal_idempotency_immutable_delete
BEFORE DELETE ON app_service_appeal_idempotency
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeal_idempotency rows are immutable');
END;

CREATE TRIGGER trg_app_service_appeals_identity_immutable
BEFORE UPDATE ON app_service_appeals
BEGIN
  SELECT CASE WHEN
    NEW.account_id IS NOT OLD.account_id
    OR NEW.source_type IS NOT OLD.source_type
    OR NEW.source_id IS NOT OLD.source_id
    OR NEW.source_version IS NOT OLD.source_version
    OR NEW.source_reference IS NOT OLD.source_reference
    OR NEW.source_label IS NOT OLD.source_label
    OR NEW.source_snapshot_json IS NOT OLD.source_snapshot_json
    OR NEW.source_snapshot_sha256 IS NOT OLD.source_snapshot_sha256
    OR NEW.original_decision_admin_id IS NOT OLD.original_decision_admin_id
    OR NEW.statement_text IS NOT OLD.statement_text
    OR NEW.statement_sha256 IS NOT OLD.statement_sha256
    OR NEW.policy_id IS NOT OLD.policy_id
    OR NEW.submitted_at IS NOT OLD.submitted_at
    THEN RAISE(ABORT, 'app_service_appeals immutable evidence changed') END;
END;

CREATE TRIGGER trg_app_service_appeals_no_delete
BEFORE DELETE ON app_service_appeals
BEGIN
  SELECT RAISE(ABORT, 'app_service_appeals are immutable workflow facts');
END;

CREATE TRIGGER trg_app_service_appeals_version_guard
BEFORE UPDATE ON app_service_appeals
BEGIN
  SELECT CASE WHEN NEW.version <> OLD.version + 1
    THEN RAISE(ABORT, 'app_service_appeals version must advance by one') END;
  SELECT CASE WHEN OLD.status IN ('upheld', 'changed', 'closed')
    THEN RAISE(ABORT, 'app_service_appeals final state is immutable') END;
END;
