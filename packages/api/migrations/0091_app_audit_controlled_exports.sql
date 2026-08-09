-- Audit-2：受控审计导出申请、独立复核、强认证与一次性下载票据。
--
-- 边界：
-- 1. admin_audit_logs 继续是唯一管理审计事实源；本表族只保存导出工作流业务事实；
-- 2. 导出对象固定写入私有 R2 audit/exports/{requestId}/events.csv，不保存公开 URL；
-- 3. step-up 与下载凭证只保存 SHA-256，明文只在单次响应中返回；
-- 4. 本 migration 不创建真实导出、不配置保留期、不执行 R2 清理，也不启用任何生产能力。

CREATE TABLE app_audit_export_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aexr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN (
      'pending_review',
      'rejected',
      'scope_changed',
      'generating',
      'ready',
      'failed',
      'expired',
      'revoked'
    )),
  purpose TEXT NOT NULL
    CHECK (purpose IN (
      'operational_investigation',
      'security_review',
      'financial_reconciliation',
      'compliance_audit'
    )),
  case_reference TEXT NOT NULL
    CHECK (
      length(case_reference) BETWEEN 3 AND 100
      AND case_reference NOT GLOB '*[^A-Za-z0-9._:/-]*'
    ),
  request_explanation TEXT NOT NULL
    CHECK (length(trim(request_explanation)) BETWEEN 10 AND 500),
  range_from TEXT NOT NULL CHECK (julianday(range_from) IS NOT NULL),
  range_to TEXT NOT NULL CHECK (julianday(range_to) IS NOT NULL),
  scope_query_json TEXT NOT NULL
    CHECK (json_valid(scope_query_json) AND json_type(scope_query_json) = 'object'),
  scope_fingerprint TEXT NOT NULL CHECK (
    length(scope_fingerprint) = 64
    AND scope_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  scope_event_count INTEGER NOT NULL CHECK (scope_event_count BETWEEN 1 AND 5000),
  scope_first_sequence INTEGER NOT NULL CHECK (scope_first_sequence > 0),
  scope_last_sequence INTEGER NOT NULL CHECK (scope_last_sequence >= scope_first_sequence),
  scope_digest TEXT NOT NULL CHECK (
    length(scope_digest) = 64
    AND scope_digest NOT GLOB '*[^0-9a-f]*'
  ),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_role_snapshot TEXT NOT NULL CHECK (length(requested_role_snapshot) BETWEEN 1 AND 48),
  requested_at TEXT NOT NULL CHECK (julianday(requested_at) IS NOT NULL),
  review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('approve', 'reject')),
  review_reason_code TEXT CHECK (
    review_reason_code IS NULL
    OR review_reason_code IN (
      'approved_business_need',
      'insufficient_business_need',
      'scope_too_broad',
      'wrong_scope',
      'policy_restriction'
    )
  ),
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 2 AND 500),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_role_snapshot TEXT
    CHECK (reviewed_role_snapshot IS NULL OR length(reviewed_role_snapshot) BETWEEN 1 AND 48),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  generation_token TEXT,
  r2_key TEXT CHECK (
    r2_key IS NULL OR r2_key = 'audit/exports/' || id || '/events.csv'
  ),
  r2_etag TEXT CHECK (r2_etag IS NULL OR length(r2_etag) BETWEEN 1 AND 160),
  file_sha256 TEXT CHECK (
    file_sha256 IS NULL
    OR (
      length(file_sha256) = 64
      AND file_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  file_size INTEGER CHECK (file_size IS NULL OR file_size BETWEEN 1 AND 25000000),
  row_count INTEGER CHECK (row_count IS NULL OR row_count BETWEEN 1 AND 5000),
  generated_at TEXT CHECK (generated_at IS NULL OR julianday(generated_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (julianday(range_from) <= julianday(range_to)),
  CHECK (julianday(range_to) - julianday(range_from) <= 31),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
  CHECK (
    (status = 'pending_review'
      AND review_decision IS NULL AND reviewed_by IS NULL
      AND reviewed_role_snapshot IS NULL AND reviewed_at IS NULL)
    OR
    (status <> 'pending_review'
      AND review_decision IS NOT NULL AND review_reason_code IS NOT NULL
      AND review_note IS NOT NULL AND reviewed_by IS NOT NULL
      AND reviewed_role_snapshot IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('generating', 'ready', 'failed', 'expired', 'revoked')
    OR review_decision = 'approve'
  ),
  CHECK (
    status NOT IN ('ready', 'expired', 'revoked')
    OR (
      r2_key IS NOT NULL AND r2_etag IS NOT NULL AND file_sha256 IS NOT NULL
      AND file_size IS NOT NULL AND row_count IS NOT NULL
      AND generated_at IS NOT NULL AND expires_at IS NOT NULL
      AND julianday(expires_at) > julianday(generated_at)
    )
  )
);

CREATE INDEX idx_app_audit_export_requests_queue
  ON app_audit_export_requests(status, requested_at ASC, id ASC);
CREATE INDEX idx_app_audit_export_requests_requester
  ON app_audit_export_requests(requested_by, requested_at DESC, id DESC);
CREATE INDEX idx_app_audit_export_requests_expiry
  ON app_audit_export_requests(status, expires_at ASC)
  WHERE expires_at IS NOT NULL;

CREATE TABLE app_audit_export_request_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aexe_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  request_id TEXT NOT NULL REFERENCES app_audit_export_requests(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'requested',
      'review_rejected',
      'scope_changed',
      'generation_started',
      'ready',
      'generation_failed',
      'download_ticket_issued',
      'downloaded',
      'expired',
      'revoked'
    )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'system')),
  actor_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  actor_role_snapshot TEXT
    CHECK (actor_role_snapshot IS NULL OR length(actor_role_snapshot) BETWEEN 1 AND 48),
  result_code TEXT NOT NULL CHECK (length(result_code) BETWEEN 1 AND 120),
  safe_summary_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, sequence),
  CHECK (
    (actor_type = 'admin' AND actor_id IS NOT NULL AND actor_role_snapshot IS NOT NULL)
    OR (actor_type = 'system' AND actor_id IS NULL AND actor_role_snapshot IS NULL)
  )
);

CREATE INDEX idx_app_audit_export_events_request
  ON app_audit_export_request_events(request_id, sequence ASC);

CREATE TABLE app_audit_export_review_decisions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aexd_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  request_id TEXT NOT NULL REFERENCES app_audit_export_requests(id) ON DELETE RESTRICT,
  reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'scope_changed')),
  expected_request_version INTEGER NOT NULL CHECK (expected_request_version > 0),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 120),
  note_sha256 TEXT NOT NULL CHECK (
    length(note_sha256) = 64
    AND note_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_scope_digest TEXT NOT NULL CHECK (
    length(observed_scope_digest) = 64
    AND observed_scope_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, reviewer_id)
);

CREATE TABLE app_audit_export_step_up_tokens (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aexs_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_scope TEXT NOT NULL CHECK (action_scope IN ('request', 'review', 'download_ticket')),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  consumed_operation_id TEXT CHECK (
    consumed_operation_id IS NULL OR length(consumed_operation_id) BETWEEN 6 AND 96
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK ((consumed_at IS NULL) = (consumed_operation_id IS NULL))
);

CREATE INDEX idx_app_audit_export_step_up_active
  ON app_audit_export_step_up_tokens(admin_id, action_scope, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE app_audit_export_download_tickets (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aext_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_id TEXT NOT NULL REFERENCES app_audit_export_requests(id) ON DELETE RESTRICT,
  request_version INTEGER NOT NULL CHECK (request_version > 0),
  created_for INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_for_role_snapshot TEXT NOT NULL
    CHECK (length(created_for_role_snapshot) BETWEEN 1 AND 48),
  file_sha256_snapshot TEXT NOT NULL CHECK (
    length(file_sha256_snapshot) = 64
    AND file_sha256_snapshot NOT GLOB '*[^0-9a-f]*'
  ),
  scope_digest_snapshot TEXT NOT NULL CHECK (
    length(scope_digest_snapshot) = 64
    AND scope_digest_snapshot NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  consumed_request_id TEXT CHECK (
    consumed_request_id IS NULL OR length(consumed_request_id) BETWEEN 1 AND 192
  ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK ((consumed_at IS NULL) = (consumed_request_id IS NULL))
);

CREATE INDEX idx_app_audit_export_tickets_active
  ON app_audit_export_download_tickets(created_for, expires_at)
  WHERE consumed_at IS NULL;

-- 命令表放在下载票据之后创建，确保所有外键目标已存在。
CREATE TABLE app_audit_export_commands (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'aexc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('request', 'review', 'download_ticket')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_request_id TEXT NOT NULL REFERENCES app_audit_export_requests(id) ON DELETE RESTRICT,
  result_ticket_id TEXT REFERENCES app_audit_export_download_tickets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (admin_id, operation, idempotency_key)
);

-- 工作流请求仅允许显式前向状态迁移；查询范围与申请事实一经创建不可修改。
CREATE TRIGGER app_audit_export_requests_guard_update
BEFORE UPDATE ON app_audit_export_requests
BEGIN
  SELECT CASE WHEN NEW.version <> OLD.version + 1
    THEN RAISE(ABORT, 'audit export request version must advance by one') END;
  SELECT CASE WHEN NOT (
    (OLD.status = 'pending_review' AND NEW.status IN ('rejected', 'scope_changed', 'generating'))
    OR (OLD.status = 'generating' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status IN ('scope_changed', 'failed', 'expired', 'revoked'))
  ) THEN RAISE(ABORT, 'invalid audit export request transition') END;
  SELECT CASE WHEN
       NEW.id IS NOT OLD.id
    OR NEW.purpose IS NOT OLD.purpose
    OR NEW.case_reference IS NOT OLD.case_reference
    OR NEW.request_explanation IS NOT OLD.request_explanation
    OR NEW.range_from IS NOT OLD.range_from
    OR NEW.range_to IS NOT OLD.range_to
    OR NEW.scope_query_json IS NOT OLD.scope_query_json
    OR NEW.scope_fingerprint IS NOT OLD.scope_fingerprint
    OR NEW.scope_event_count IS NOT OLD.scope_event_count
    OR NEW.scope_first_sequence IS NOT OLD.scope_first_sequence
    OR NEW.scope_last_sequence IS NOT OLD.scope_last_sequence
    OR NEW.scope_digest IS NOT OLD.scope_digest
    OR NEW.requested_by IS NOT OLD.requested_by
    OR NEW.requested_role_snapshot IS NOT OLD.requested_role_snapshot
    OR NEW.requested_at IS NOT OLD.requested_at
    OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'audit export request scope is immutable') END;
  SELECT CASE WHEN OLD.status <> 'pending_review' AND (
       NEW.review_decision IS NOT OLD.review_decision
    OR NEW.review_reason_code IS NOT OLD.review_reason_code
    OR NEW.review_note IS NOT OLD.review_note
    OR NEW.reviewed_by IS NOT OLD.reviewed_by
    OR NEW.reviewed_role_snapshot IS NOT OLD.reviewed_role_snapshot
    OR NEW.reviewed_at IS NOT OLD.reviewed_at
  ) THEN RAISE(ABORT, 'audit export review fact is immutable') END;
END;

CREATE TRIGGER app_audit_export_requests_no_delete
BEFORE DELETE ON app_audit_export_requests
BEGIN
  SELECT RAISE(ABORT, 'audit export requests are immutable workflow facts');
END;

CREATE TRIGGER app_audit_export_events_no_update
BEFORE UPDATE ON app_audit_export_request_events
BEGIN
  SELECT RAISE(ABORT, 'audit export events are immutable');
END;

CREATE TRIGGER app_audit_export_events_no_delete
BEFORE DELETE ON app_audit_export_request_events
BEGIN
  SELECT RAISE(ABORT, 'audit export events are immutable');
END;

CREATE TRIGGER app_audit_export_commands_no_update
BEFORE UPDATE ON app_audit_export_commands
BEGIN
  SELECT RAISE(ABORT, 'audit export commands are immutable');
END;

CREATE TRIGGER app_audit_export_commands_no_delete
BEFORE DELETE ON app_audit_export_commands
BEGIN
  SELECT RAISE(ABORT, 'audit export commands are immutable');
END;

CREATE TRIGGER app_audit_export_review_decisions_no_update
BEFORE UPDATE ON app_audit_export_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'audit export review decisions are immutable');
END;

CREATE TRIGGER app_audit_export_review_decisions_no_delete
BEFORE DELETE ON app_audit_export_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'audit export review decisions are immutable');
END;

CREATE TRIGGER app_audit_export_step_up_tokens_guard_update
BEFORE UPDATE ON app_audit_export_step_up_tokens
WHEN NOT (
  OLD.consumed_at IS NULL
  AND OLD.consumed_operation_id IS NULL
  AND NEW.consumed_at IS NOT NULL
  AND NEW.consumed_operation_id IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.token_hash IS OLD.token_hash
  AND NEW.admin_id IS OLD.admin_id
  AND NEW.action_scope IS OLD.action_scope
  AND NEW.expires_at IS OLD.expires_at
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'step-up token can only be consumed once');
END;

CREATE TRIGGER app_audit_export_step_up_tokens_no_delete
BEFORE DELETE ON app_audit_export_step_up_tokens
BEGIN
  SELECT RAISE(ABORT, 'step-up tokens are immutable');
END;

CREATE TRIGGER app_audit_export_download_tickets_guard_update
BEFORE UPDATE ON app_audit_export_download_tickets
WHEN NOT (
  OLD.consumed_at IS NULL
  AND OLD.consumed_request_id IS NULL
  AND NEW.consumed_at IS NOT NULL
  AND NEW.consumed_request_id IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.token_hash IS OLD.token_hash
  AND NEW.request_id IS OLD.request_id
    AND NEW.request_version IS OLD.request_version
    AND NEW.created_for IS OLD.created_for
    AND NEW.created_for_role_snapshot IS OLD.created_for_role_snapshot
  AND NEW.file_sha256_snapshot IS OLD.file_sha256_snapshot
  AND NEW.scope_digest_snapshot IS OLD.scope_digest_snapshot
  AND NEW.expires_at IS OLD.expires_at
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'download ticket can only be consumed once');
END;

CREATE TRIGGER app_audit_export_download_tickets_no_delete
BEFORE DELETE ON app_audit_export_download_tickets
BEGIN
  SELECT RAISE(ABORT, 'download tickets are immutable');
END;
