-- Privacy-1：App 数据权利二次验证、导出/注销申请与受控处置控制面。
--
-- 边界：
-- 1. 本 migration 只建立默认关闭的请求控制面，不生成导出包、不执行不可逆删除；
-- 2. 保留期、目标地区、数据责任人和 SLA 未批准前，production_ready 必须保持 0；
-- 3. 二次验证、状态访问凭证只保存 SHA-256，明文只在单次响应中返回；
-- 4. 注销申请进入 scheduled 后立即撤销会话并阻断新互动、话题、会员发放和调币；
-- 5. 管理员业务审计继续只写 admin_audit_logs，本表族保存数据权利 Workflow 事实。

CREATE TABLE app_data_rights_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      length(version_code) BETWEEN 3 AND 80
      AND version_code NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  requests_enabled INTEGER NOT NULL DEFAULT 0 CHECK (requests_enabled IN (0, 1)),
  export_requests_enabled INTEGER NOT NULL DEFAULT 0 CHECK (export_requests_enabled IN (0, 1)),
  deletion_requests_enabled INTEGER NOT NULL DEFAULT 0 CHECK (deletion_requests_enabled IN (0, 1)),
  export_processing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (export_processing_enabled IN (0, 1)),
  deletion_processing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (deletion_processing_enabled IN (0, 1)),
  cancellation_enabled INTEGER NOT NULL DEFAULT 1 CHECK (cancellation_enabled IN (0, 1)),
  retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (retention_decision_status IN ('unresolved', 'approved')),
  owner_sla_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (owner_sla_decision_status IN ('unresolved', 'approved')),
  region_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (region_decision_status IN ('unresolved', 'approved')),
  retention_policy_reference TEXT
    CHECK (retention_policy_reference IS NULL OR length(retention_policy_reference) BETWEEN 3 AND 192),
  owner_reference TEXT
    CHECK (owner_reference IS NULL OR length(owner_reference) BETWEEN 3 AND 192),
  region_policy_reference TEXT
    CHECK (region_policy_reference IS NULL OR length(region_policy_reference) BETWEEN 3 AND 192),
  request_sla_hours INTEGER CHECK (request_sla_hours IS NULL OR request_sla_hours BETWEEN 1 AND 2160),
  deletion_cooling_off_hours INTEGER
    CHECK (deletion_cooling_off_hours IS NULL OR deletion_cooling_off_hours BETWEEN 0 AND 720),
  status_access_ttl_hours INTEGER NOT NULL DEFAULT 720
    CHECK (status_access_ttl_hours BETWEEN 1 AND 2160),
  step_up_ttl_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (step_up_ttl_seconds BETWEEN 60 AND 900),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (requests_enabled = 1 OR (export_requests_enabled = 0 AND deletion_requests_enabled = 0)),
  CHECK (export_requests_enabled = 1 OR export_processing_enabled = 0),
  CHECK (deletion_requests_enabled = 1 OR deletion_processing_enabled = 0),
  CHECK (deletion_requests_enabled = 0 OR deletion_cooling_off_hours IS NOT NULL),
  CHECK (
    (retention_decision_status = 'unresolved' AND retention_policy_reference IS NULL)
    OR (retention_decision_status = 'approved' AND retention_policy_reference IS NOT NULL)
  ),
  CHECK (
    (owner_sla_decision_status = 'unresolved' AND owner_reference IS NULL AND request_sla_hours IS NULL)
    OR (owner_sla_decision_status = 'approved' AND owner_reference IS NOT NULL AND request_sla_hours IS NOT NULL)
  ),
  CHECK (
    (region_decision_status = 'unresolved' AND region_policy_reference IS NULL)
    OR (region_decision_status = 'approved' AND region_policy_reference IS NOT NULL)
  ),
  CHECK (
    production_ready = 0
    OR (
      state = 'published'
      AND requests_enabled = 1
      AND retention_decision_status = 'approved'
      AND owner_sla_decision_status = 'approved'
      AND region_decision_status = 'approved'
    )
  ),
  CHECK (
    export_processing_enabled = 0
    OR (production_ready = 1 AND export_requests_enabled = 1)
  ),
  CHECK (
    deletion_processing_enabled = 0
    OR (production_ready = 1 AND deletion_requests_enabled = 1)
  )
);

INSERT INTO app_data_rights_policies (
  id, version_code, state, production_ready, requests_enabled,
  export_requests_enabled, deletion_requests_enabled,
  export_processing_enabled, deletion_processing_enabled, cancellation_enabled,
  retention_decision_status, owner_sla_decision_status, region_decision_status,
  retention_policy_reference, owner_reference, region_policy_reference,
  request_sla_hours, deletion_cooling_off_hours,
  status_access_ttl_hours, step_up_ttl_seconds, created_at
) VALUES (
  'drp_app_1_0_privacy_1_dev_1',
  'app-1.0-privacy-1-dev-1',
  'development',
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  'unresolved',
  'unresolved',
  'unresolved',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  720,
  300,
  '2026-08-10T00:00:00.000Z'
);

CREATE TABLE app_data_rights_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  request_type TEXT NOT NULL CHECK (request_type IN ('export', 'deletion')),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL REFERENCES app_data_rights_policies(id) ON DELETE RESTRICT,
  policy_version_snapshot TEXT NOT NULL CHECK (length(policy_version_snapshot) BETWEEN 3 AND 80),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'verification_required', 'collecting', 'ready', 'expired',
    'scheduled', 'processing', 'completed', 'cancelled', 'failed'
  )),
  status_message_code TEXT NOT NULL
    CHECK (
      length(status_message_code) BETWEEN 3 AND 80
      AND status_message_code NOT GLOB '*[^a-z0-9_]*'
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT NOT NULL CHECK (length(mutation_token) BETWEEN 16 AND 96),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  requested_session_id TEXT REFERENCES app_sessions(id) ON DELETE SET NULL,
  requested_device_id TEXT REFERENCES app_devices(id) ON DELETE SET NULL,
  account_security_status_before TEXT NOT NULL
    CHECK (account_security_status_before IN ('active', 'restricted')),
  account_restriction_reason_before TEXT
    CHECK (
      account_restriction_reason_before IS NULL
      OR length(account_restriction_reason_before) BETWEEN 1 AND 120
    ),
  account_restricted_until_before TEXT
    CHECK (
      account_restricted_until_before IS NULL
      OR julianday(account_restricted_until_before) IS NOT NULL
    ),
  user_status_before TEXT NOT NULL CHECK (length(user_status_before) BETWEEN 1 AND 48),
  assigned_to INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at TEXT CHECK (assigned_at IS NULL OR julianday(assigned_at) IS NOT NULL),
  deadline_at TEXT CHECK (deadline_at IS NULL OR julianday(deadline_at) IS NOT NULL),
  scheduled_for TEXT CHECK (scheduled_for IS NULL OR julianday(scheduled_for) IS NOT NULL),
  processing_started_at TEXT
    CHECK (processing_started_at IS NULL OR julianday(processing_started_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  cancelled_at TEXT CHECK (cancelled_at IS NULL OR julianday(cancelled_at) IS NOT NULL),
  failure_code TEXT
    CHECK (
      failure_code IS NULL
      OR (
        length(failure_code) BETWEEN 3 AND 80
        AND failure_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  requested_at TEXT NOT NULL CHECK (julianday(requested_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (
    (request_type = 'export' AND status IN (
      'requested', 'verification_required', 'collecting', 'ready', 'expired', 'cancelled', 'failed'
    ))
    OR
    (request_type = 'deletion' AND status IN (
      'requested', 'verification_required', 'scheduled', 'processing', 'completed', 'cancelled', 'failed'
    ))
  ),
  CHECK (request_type = 'deletion' OR scheduled_for IS NULL),
  CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL),
  CHECK (status NOT IN ('processing', 'collecting') OR processing_started_at IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL),
  CHECK (assigned_to IS NULL OR assigned_at IS NOT NULL),
  CHECK (deadline_at IS NULL OR julianday(deadline_at) >= julianday(requested_at)),
  CHECK (scheduled_for IS NULL OR julianday(scheduled_for) >= julianday(requested_at))
);

CREATE UNIQUE INDEX idx_app_data_rights_one_active_export
  ON app_data_rights_requests(account_id)
  WHERE request_type = 'export' AND status IN ('requested', 'verification_required', 'collecting', 'ready');

CREATE UNIQUE INDEX idx_app_data_rights_one_active_deletion
  ON app_data_rights_requests(account_id)
  WHERE request_type = 'deletion' AND status IN (
    'requested', 'verification_required', 'scheduled', 'processing', 'failed'
  );

CREATE INDEX idx_app_data_rights_account_time
  ON app_data_rights_requests(account_id, requested_at DESC, id DESC);

CREATE INDEX idx_app_data_rights_queue
  ON app_data_rights_requests(request_type, status, deadline_at, requested_at, id);

CREATE INDEX idx_app_data_rights_assignee
  ON app_data_rights_requests(assigned_to, status, updated_at DESC, id DESC)
  WHERE assigned_to IS NOT NULL;

CREATE TABLE app_data_rights_request_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'dre_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  request_version INTEGER NOT NULL CHECK (request_version > 0),
  status_snapshot TEXT NOT NULL CHECK (status_snapshot IN (
    'requested', 'verification_required', 'collecting', 'ready', 'expired',
    'scheduled', 'processing', 'completed', 'cancelled', 'failed'
  )),
  event_type TEXT NOT NULL
    CHECK (
      length(event_type) BETWEEN 3 AND 80
      AND event_type NOT GLOB '*[^a-z0-9_]*'
    ),
  visibility TEXT NOT NULL DEFAULT 'user' CHECK (visibility IN ('user', 'internal')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('account', 'admin', 'system')),
  actor_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (
      length(reason_code) BETWEEN 3 AND 80
      AND reason_code NOT GLOB '*[^a-z0-9_]*'
    ),
  user_message TEXT CHECK (user_message IS NULL OR length(trim(user_message)) BETWEEN 2 AND 300),
  internal_note TEXT CHECK (internal_note IS NULL OR length(trim(internal_note)) BETWEEN 2 AND 1000),
  safe_summary_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, sequence),
  CHECK (
    (actor_type IN ('account', 'admin') AND actor_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_id IS NULL)
  ),
  CHECK (visibility = 'internal' OR internal_note IS NULL)
);

CREATE INDEX idx_app_data_rights_events_request
  ON app_data_rights_request_events(request_id, sequence ASC);

CREATE TABLE app_data_rights_verification_attempts (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drva_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES app_sessions(id) ON DELETE SET NULL,
  request_id TEXT REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'export_request', 'deletion_request', 'export_cancel', 'deletion_cancel', 'export_download'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'rate_limited')),
  request_trace_id TEXT NOT NULL CHECK (length(request_trace_id) BETWEEN 8 AND 128),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_data_rights_verification_rate
  ON app_data_rights_verification_attempts(account_id, created_at DESC, outcome);

CREATE TABLE app_data_rights_step_up_tokens (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drsu_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT REFERENCES app_sessions(id) ON DELETE SET NULL,
  request_id TEXT REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'export_request', 'deletion_request', 'export_cancel', 'deletion_cancel', 'export_download'
  )),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  consumed_operation_id TEXT
    CHECK (consumed_operation_id IS NULL OR length(consumed_operation_id) BETWEEN 5 AND 128),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK ((consumed_at IS NULL) = (consumed_operation_id IS NULL)),
  CHECK (
    (purpose IN ('export_request', 'deletion_request') AND request_id IS NULL)
    OR (purpose IN ('deletion_cancel', 'export_cancel', 'export_download') AND request_id IS NOT NULL)
  )
);

CREATE INDEX idx_app_data_rights_step_up_active
  ON app_data_rights_step_up_tokens(account_id, purpose, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE app_data_rights_status_tokens (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drst_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  revoked_at TEXT CHECK (revoked_at IS NULL OR julianday(revoked_at) IS NOT NULL),
  last_used_at TEXT CHECK (last_used_at IS NULL OR julianday(last_used_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_data_rights_status_token_active
  ON app_data_rights_status_tokens(request_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE app_data_rights_commands (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  actor_scope TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 3 AND 112),
  operation TEXT NOT NULL
    CHECK (
      length(operation) BETWEEN 3 AND 80
      AND operation NOT GLOB '*[^a-z0-9_]*'
    ),
  idempotency_key_hash TEXT NOT NULL
    CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (actor_scope, operation, idempotency_key_hash)
);

CREATE TRIGGER app_data_rights_policies_no_update
BEFORE UPDATE ON app_data_rights_policies
BEGIN
  SELECT RAISE(ABORT, 'app data rights policies are immutable');
END;

CREATE TRIGGER app_data_rights_policies_no_delete
BEFORE DELETE ON app_data_rights_policies
BEGIN
  SELECT RAISE(ABORT, 'app data rights policies are immutable');
END;

CREATE TRIGGER app_data_rights_requests_guard_update
BEFORE UPDATE ON app_data_rights_requests
WHEN
  NEW.version <> OLD.version + 1
  OR NEW.mutation_token = OLD.mutation_token
  OR NEW.id IS NOT OLD.id
  OR NEW.request_type IS NOT OLD.request_type
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.policy_id IS NOT OLD.policy_id
  OR NEW.policy_version_snapshot IS NOT OLD.policy_version_snapshot
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.requested_session_id IS NOT OLD.requested_session_id
  OR NEW.requested_device_id IS NOT OLD.requested_device_id
  OR NEW.account_security_status_before IS NOT OLD.account_security_status_before
  OR NEW.account_restriction_reason_before IS NOT OLD.account_restriction_reason_before
  OR NEW.account_restricted_until_before IS NOT OLD.account_restricted_until_before
  OR NEW.user_status_before IS NOT OLD.user_status_before
  OR NEW.deadline_at IS NOT OLD.deadline_at
  OR NEW.scheduled_for IS NOT OLD.scheduled_for
  OR NEW.requested_at IS NOT OLD.requested_at
  OR (
    OLD.request_type = 'export'
    AND NOT (
      (OLD.status = 'requested' AND NEW.status IN ('collecting', 'cancelled', 'failed'))
      OR (OLD.status = 'verification_required' AND NEW.status IN ('requested', 'cancelled', 'failed'))
      OR (OLD.status = 'collecting' AND NEW.status IN ('ready', 'cancelled', 'failed'))
      OR (OLD.status = 'ready' AND NEW.status = 'expired')
      OR (OLD.status = 'failed' AND NEW.status = 'requested')
      OR (OLD.status = NEW.status)
    )
  )
  OR (
    OLD.request_type = 'deletion'
    AND NOT (
      (OLD.status = 'requested' AND NEW.status IN ('scheduled', 'cancelled', 'failed'))
      OR (OLD.status = 'verification_required' AND NEW.status IN ('scheduled', 'cancelled', 'failed'))
      OR (OLD.status = 'scheduled' AND NEW.status IN ('processing', 'cancelled', 'failed'))
      OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'failed'))
      OR (OLD.status = 'failed' AND NEW.status = 'scheduled')
      OR (OLD.status = NEW.status)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid app data rights request transition');
END;

CREATE TRIGGER app_data_rights_requests_no_delete
BEFORE DELETE ON app_data_rights_requests
BEGIN
  SELECT RAISE(ABORT, 'app data rights requests are workflow facts');
END;

CREATE TRIGGER app_data_rights_events_no_update
BEFORE UPDATE ON app_data_rights_request_events
BEGIN
  SELECT RAISE(ABORT, 'app data rights events are immutable');
END;

CREATE TRIGGER app_data_rights_events_no_delete
BEFORE DELETE ON app_data_rights_request_events
BEGIN
  SELECT RAISE(ABORT, 'app data rights events are immutable');
END;

CREATE TRIGGER app_data_rights_commands_no_update
BEFORE UPDATE ON app_data_rights_commands
BEGIN
  SELECT RAISE(ABORT, 'app data rights commands are immutable');
END;

CREATE TRIGGER app_data_rights_commands_no_delete
BEFORE DELETE ON app_data_rights_commands
BEGIN
  SELECT RAISE(ABORT, 'app data rights commands are immutable');
END;

-- 注销待处理期间，阻断所有会扩大产品数据的新写入。查询、撤回和合规处置继续由服务端控制。
CREATE TRIGGER app_data_rights_block_interaction_insert
BEFORE INSERT ON app_viewer_interactions
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_favorite_folder_insert
BEFORE INSERT ON app_favorite_folders
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_favorite_item_insert
BEFORE INSERT ON app_favorite_folder_items
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_view_history_insert
BEFORE INSERT ON app_profile_view_history
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_search_history_insert
BEFORE INSERT ON app_person_search_history
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_conversation_insert
BEFORE INSERT ON app_conversations
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_viewer_message_insert
BEFORE INSERT ON app_conversation_messages
WHEN NEW.sender_type = 'viewer' AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.actor_account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_membership_application_insert
BEFORE INSERT ON app_membership_applications
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_membership_grant_insert
BEFORE INSERT ON app_membership_grants
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_block_wallet_adjustment_insert
BEFORE INSERT ON app_wallet_adjustments
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;
