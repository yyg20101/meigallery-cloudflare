-- Privacy-2B：账号不可逆注销 profile、可恢复执行检查点与不可变完成证据。
--
-- 安全边界：
-- 1. 本 migration 不启用任何环境、策略或 Queue；唯一 seed 为 development + production_ready=0；
-- 2. OQ-020/OQ-024/OQ-025 对应的保留、备份/第三方、身份复用和证据治理全部批准前，
--    profile 不能成为生产就绪，管理员也不能启动不可逆执行；
-- 3. 管理员只能启动或重试，只有执行器在全部步骤完成并核对不可变证据后才能写 completed；
-- 4. 失败只允许前向修复，不恢复账号、会话或产品写能力；取消仍只允许在 scheduled 冷静期内；
-- 5. users 作为审计、钱包、安全和数据权利事实的 FK 锚点保留，但会删除登录身份并改写为不可登录墓碑；
-- 6. 原始邮箱不会写入本表族。若批准 identity seal，只保存独立密钥 HMAC 与到期时间。

CREATE TABLE app_data_rights_deletion_profiles (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drdp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_data_rights_policies(id) ON DELETE RESTRICT,
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      length(version_code) BETWEEN 3 AND 80
      AND version_code NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  executor_version TEXT NOT NULL
    CHECK (
      length(executor_version) BETWEEN 3 AND 80
      AND executor_version NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  expected_step_count INTEGER NOT NULL CHECK (expected_step_count = 9),
  retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (retention_decision_status IN ('unresolved', 'approved')),
  backup_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (backup_decision_status IN ('unresolved', 'approved')),
  third_party_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (third_party_decision_status IN ('unresolved', 'approved')),
  identity_reuse_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (identity_reuse_decision_status IN ('unresolved', 'approved')),
  evidence_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (evidence_decision_status IN ('unresolved', 'approved')),
  identity_reuse_mode TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (identity_reuse_mode IN ('unresolved', 'release', 'seal')),
  identity_seal_days INTEGER
    CHECK (identity_seal_days IS NULL OR identity_seal_days BETWEEN 1 AND 3650),
  retention_policy_reference TEXT
    CHECK (retention_policy_reference IS NULL OR length(retention_policy_reference) BETWEEN 3 AND 192),
  backup_policy_reference TEXT
    CHECK (backup_policy_reference IS NULL OR length(backup_policy_reference) BETWEEN 3 AND 192),
  third_party_policy_reference TEXT
    CHECK (third_party_policy_reference IS NULL OR length(third_party_policy_reference) BETWEEN 3 AND 192),
  identity_reuse_policy_reference TEXT
    CHECK (identity_reuse_policy_reference IS NULL OR length(identity_reuse_policy_reference) BETWEEN 3 AND 192),
  evidence_policy_reference TEXT
    CHECK (evidence_policy_reference IS NULL OR length(evidence_policy_reference) BETWEEN 3 AND 192),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (
    (identity_reuse_mode = 'unresolved' AND identity_seal_days IS NULL)
    OR (identity_reuse_mode = 'release' AND identity_seal_days IS NULL)
    OR (identity_reuse_mode = 'seal' AND identity_seal_days IS NOT NULL)
  ),
  CHECK (
    production_ready = 0
    OR (
      state = 'published'
      AND retention_decision_status = 'approved'
      AND backup_decision_status = 'approved'
      AND third_party_decision_status = 'approved'
      AND identity_reuse_decision_status = 'approved'
      AND evidence_decision_status = 'approved'
      AND identity_reuse_mode IN ('release', 'seal')
      AND retention_policy_reference IS NOT NULL
      AND backup_policy_reference IS NOT NULL
      AND third_party_policy_reference IS NOT NULL
      AND identity_reuse_policy_reference IS NOT NULL
      AND evidence_policy_reference IS NOT NULL
    )
  )
);

CREATE INDEX idx_app_data_rights_deletion_profiles_policy
  ON app_data_rights_deletion_profiles(policy_id, production_ready DESC, created_at DESC, id DESC);

CREATE TABLE app_data_rights_deletion_profile_steps (
  profile_id TEXT NOT NULL REFERENCES app_data_rights_deletion_profiles(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 8),
  step_code TEXT NOT NULL
    CHECK (
      length(step_code) BETWEEN 3 AND 64
      AND step_code NOT GLOB '*[^a-z0-9_]*'
    ),
  handler_code TEXT NOT NULL
    CHECK (
      length(handler_code) BETWEEN 3 AND 64
      AND handler_code NOT GLOB '*[^a-z0-9_]*'
    ),
  disposition TEXT NOT NULL
    CHECK (disposition IN ('delete', 'anonymize', 'revoke', 'close', 'retain_isolated', 'external_purge')),
  decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (decision_status IN ('unresolved', 'approved')),
  governance_reference TEXT
    CHECK (governance_reference IS NULL OR length(governance_reference) BETWEEN 3 AND 192),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (profile_id, ordinal),
  UNIQUE (profile_id, step_code),
  CHECK (
    (decision_status = 'unresolved' AND governance_reference IS NULL)
    OR (decision_status = 'approved' AND governance_reference IS NOT NULL)
  )
);

INSERT INTO app_data_rights_deletion_profiles (
  id, policy_id, version_code, state, production_ready, schema_version,
  executor_version, expected_step_count,
  retention_decision_status, backup_decision_status, third_party_decision_status,
  identity_reuse_decision_status, evidence_decision_status,
  identity_reuse_mode, identity_seal_days,
  retention_policy_reference, backup_policy_reference, third_party_policy_reference,
  identity_reuse_policy_reference, evidence_policy_reference, created_at
) VALUES (
  'drdp_app_1_0_privacy_2b_dev_1',
  'drp_app_1_0_privacy_1_dev_1',
  'app-1.0-privacy-2b-dev-1',
  'development',
  0,
  1,
  'privacy-2b-v1',
  9,
  'unresolved',
  'unresolved',
  'unresolved',
  'unresolved',
  'unresolved',
  'unresolved',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  '2026-08-20T00:00:00.000Z'
);

INSERT INTO app_data_rights_deletion_profile_steps (
  profile_id, ordinal, step_code, handler_code, disposition,
  decision_status, governance_reference, created_at
) VALUES
  ('drdp_app_1_0_privacy_2b_dev_1', 0, 'revoke_access', 'revoke_access', 'revoke', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 1, 'purge_private_exports', 'purge_private_exports', 'external_purge', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 2, 'purge_notifications', 'purge_notifications', 'delete', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 3, 'purge_discovery_activity', 'purge_discovery_activity', 'delete', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 4, 'purge_account_preferences', 'purge_account_preferences', 'delete', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 5, 'anonymize_analytics', 'anonymize_analytics', 'anonymize', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 6, 'close_managed_conversations', 'close_managed_conversations', 'close', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 7, 'isolate_regulated_records', 'isolate_regulated_records', 'retain_isolated', 'unresolved', NULL, '2026-08-20T00:00:00.000Z'),
  ('drdp_app_1_0_privacy_2b_dev_1', 8, 'tombstone_account', 'tombstone_account', 'anonymize', 'unresolved', NULL, '2026-08-20T00:00:00.000Z');

CREATE TABLE app_data_rights_deletion_executions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drde_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  request_id TEXT NOT NULL UNIQUE REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  request_version_snapshot INTEGER NOT NULL CHECK (request_version_snapshot > 0),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES app_data_rights_deletion_profiles(id) ON DELETE RESTRICT,
  profile_version_snapshot TEXT NOT NULL CHECK (length(profile_version_snapshot) BETWEEN 3 AND 80),
  executor_version_snapshot TEXT NOT NULL CHECK (length(executor_version_snapshot) BETWEEN 3 AND 80),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  execution_token TEXT NOT NULL UNIQUE CHECK (length(execution_token) BETWEEN 16 AND 96),
  current_step_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (current_step_ordinal BETWEEN 0 AND 9),
  expected_step_count INTEGER NOT NULL CHECK (expected_step_count = 9),
  completed_step_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_step_count BETWEEN 0 AND 9),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 96),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  last_error_code TEXT
    CHECK (
      last_error_code IS NULL
      OR (
        length(last_error_code) BETWEEN 3 AND 120
        AND last_error_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  started_at TEXT CHECK (started_at IS NULL OR julianday(started_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  failed_at TEXT CHECK (failed_at IS NULL OR julianday(failed_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (completed_step_count = current_step_ordinal),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_step_count = expected_step_count),
  CHECK (status <> 'failed' OR failed_at IS NOT NULL)
);

CREATE INDEX idx_app_data_rights_deletion_executions_recovery
  ON app_data_rights_deletion_executions(status, lease_expires_at, updated_at ASC, id ASC);

CREATE TABLE app_data_rights_deletion_steps (
  execution_id TEXT NOT NULL REFERENCES app_data_rights_deletion_executions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 8),
  step_code TEXT NOT NULL
    CHECK (length(step_code) BETWEEN 3 AND 64 AND step_code NOT GLOB '*[^a-z0-9_]*'),
  handler_code TEXT NOT NULL
    CHECK (length(handler_code) BETWEEN 3 AND 64 AND handler_code NOT GLOB '*[^a-z0-9_]*'),
  disposition_snapshot TEXT NOT NULL
    CHECK (disposition_snapshot IN ('delete', 'anonymize', 'revoke', 'close', 'retain_isolated', 'external_purge')),
  governance_reference_snapshot TEXT NOT NULL CHECK (length(governance_reference_snapshot) BETWEEN 3 AND 192),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  initial_item_count INTEGER CHECK (initial_item_count IS NULL OR initial_item_count >= 0),
  final_item_count INTEGER CHECK (final_item_count IS NULL OR final_item_count >= 0),
  affected_item_count INTEGER CHECK (affected_item_count IS NULL OR affected_item_count >= 0),
  evidence_digest TEXT
    CHECK (
      evidence_digest IS NULL
      OR (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*')
    ),
  started_at TEXT CHECK (started_at IS NULL OR julianday(started_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (execution_id, ordinal),
  UNIQUE (execution_id, step_code),
  CHECK ((status = 'pending') = (started_at IS NULL)),
  CHECK (
    (status = 'completed'
      AND completed_at IS NOT NULL
      AND initial_item_count IS NOT NULL
      AND final_item_count IS NOT NULL
      AND affected_item_count IS NOT NULL
      AND evidence_digest IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL AND evidence_digest IS NULL)
  )
);

CREATE TABLE app_data_rights_deletion_evidence (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'drdv_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  execution_id TEXT NOT NULL REFERENCES app_data_rights_deletion_executions(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  step_ordinal INTEGER NOT NULL CHECK (step_ordinal BETWEEN 0 AND 8),
  step_code TEXT NOT NULL CHECK (length(step_code) BETWEEN 3 AND 64),
  handler_code TEXT NOT NULL CHECK (length(handler_code) BETWEEN 3 AND 64),
  disposition_snapshot TEXT NOT NULL
    CHECK (disposition_snapshot IN ('delete', 'anonymize', 'revoke', 'close', 'retain_isolated', 'external_purge')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  initial_item_count INTEGER NOT NULL CHECK (initial_item_count >= 0),
  final_item_count INTEGER NOT NULL CHECK (final_item_count >= 0),
  affected_item_count INTEGER NOT NULL CHECK (affected_item_count >= 0),
  result_digest TEXT NOT NULL
    CHECK (length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
  safe_summary_json TEXT NOT NULL
    CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (execution_id, step_ordinal),
  UNIQUE (execution_id, result_digest)
);

CREATE INDEX idx_app_data_rights_deletion_evidence_request
  ON app_data_rights_deletion_evidence(request_id, step_ordinal ASC);

CREATE TABLE app_data_rights_retained_domains (
  execution_id TEXT NOT NULL REFERENCES app_data_rights_deletion_executions(id) ON DELETE RESTRICT,
  domain_code TEXT NOT NULL
    CHECK (domain_code IN (
      'consent', 'membership', 'wallet', 'messaging_evidence',
      'safety', 'data_rights', 'security_audit'
    )),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  access_scope TEXT NOT NULL DEFAULT 'compliance_only' CHECK (access_scope = 'compliance_only'),
  governance_reference TEXT NOT NULL CHECK (length(governance_reference) BETWEEN 3 AND 192),
  count_digest TEXT NOT NULL
    CHECK (length(count_digest) = 64 AND count_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (execution_id, domain_code)
);

CREATE TABLE app_data_rights_identity_seals (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'dris_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  provider TEXT NOT NULL CHECK (provider = 'email'),
  subject_hmac TEXT NOT NULL UNIQUE
    CHECK (length(subject_hmac) = 64 AND subject_hmac NOT GLOB '*[^0-9a-f]*'),
  request_id TEXT NOT NULL UNIQUE REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES app_data_rights_deletion_profiles(id) ON DELETE RESTRICT,
  release_after TEXT CHECK (release_after IS NULL OR julianday(release_after) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_data_rights_identity_seals_lookup
  ON app_data_rights_identity_seals(provider, subject_hmac, release_after);

CREATE TABLE app_data_rights_account_tombstones (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE REFERENCES app_data_rights_requests(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL UNIQUE REFERENCES app_data_rights_deletion_executions(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES app_data_rights_deletion_profiles(id) ON DELETE RESTRICT,
  account_public_id_snapshot TEXT NOT NULL CHECK (length(account_public_id_snapshot) BETWEEN 5 AND 96),
  identity_reuse_mode TEXT NOT NULL CHECK (identity_reuse_mode IN ('release', 'seal')),
  evidence_root_sha256 TEXT NOT NULL
    CHECK (length(evidence_root_sha256) = 64 AND evidence_root_sha256 NOT GLOB '*[^0-9a-f]*'),
  retained_domain_count INTEGER NOT NULL CHECK (retained_domain_count >= 0),
  completed_at TEXT NOT NULL CHECK (julianday(completed_at) IS NOT NULL)
);

CREATE TRIGGER app_data_rights_deletion_profiles_no_update
BEFORE UPDATE ON app_data_rights_deletion_profiles
BEGIN
  SELECT RAISE(ABORT, 'app data rights deletion profiles are immutable');
END;

CREATE TRIGGER app_data_rights_deletion_profiles_no_delete
BEFORE DELETE ON app_data_rights_deletion_profiles
BEGIN
  SELECT RAISE(ABORT, 'app data rights deletion profiles are immutable');
END;

CREATE TRIGGER app_data_rights_deletion_profile_steps_no_update
BEFORE UPDATE ON app_data_rights_deletion_profile_steps
BEGIN
  SELECT RAISE(ABORT, 'app data rights deletion profile steps are immutable');
END;

CREATE TRIGGER app_data_rights_deletion_profile_steps_no_delete
BEFORE DELETE ON app_data_rights_deletion_profile_steps
BEGIN
  SELECT RAISE(ABORT, 'app data rights deletion profile steps are immutable');
END;

CREATE TRIGGER app_data_rights_deletion_evidence_no_update
BEFORE UPDATE ON app_data_rights_deletion_evidence
BEGIN
  SELECT RAISE(ABORT, 'app data rights deletion evidence is immutable');
END;

CREATE TRIGGER app_data_rights_deletion_evidence_no_delete
BEFORE DELETE ON app_data_rights_deletion_evidence
BEGIN
  SELECT RAISE(ABORT, 'app data rights deletion evidence is immutable');
END;

CREATE TRIGGER app_data_rights_retained_domains_no_update
BEFORE UPDATE ON app_data_rights_retained_domains
BEGIN
  SELECT RAISE(ABORT, 'app data rights retained domains are immutable');
END;

CREATE TRIGGER app_data_rights_retained_domains_no_delete
BEFORE DELETE ON app_data_rights_retained_domains
BEGIN
  SELECT RAISE(ABORT, 'app data rights retained domains are immutable');
END;

CREATE TRIGGER app_data_rights_identity_seals_no_update
BEFORE UPDATE ON app_data_rights_identity_seals
BEGIN
  SELECT RAISE(ABORT, 'app data rights identity seals are immutable');
END;

CREATE TRIGGER app_data_rights_identity_seals_no_delete
BEFORE DELETE ON app_data_rights_identity_seals
BEGIN
  SELECT RAISE(ABORT, 'app data rights identity seals are immutable');
END;

CREATE TRIGGER app_data_rights_account_tombstones_no_update
BEFORE UPDATE ON app_data_rights_account_tombstones
BEGIN
  SELECT RAISE(ABORT, 'app data rights account tombstones are immutable');
END;

CREATE TRIGGER app_data_rights_account_tombstones_no_delete
BEFORE DELETE ON app_data_rights_account_tombstones
BEGIN
  SELECT RAISE(ABORT, 'app data rights account tombstones are immutable');
END;

-- Privacy-1 已阻断主要互动、收藏、历史、会话、会员申请和钱包写入。
-- Privacy-2B 补齐后续模块与旧图库喜欢入口，避免删除检查点完成后被并发任务重新写回。
CREATE TRIGGER app_data_rights_deletion_block_gallery_like_insert
BEFORE INSERT ON gallery_likes
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_identity_insert
BEFORE INSERT ON app_account_identities
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_identity_update
BEFORE UPDATE ON app_account_identities
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_device_insert
BEFORE INSERT ON app_devices
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_device_reactivation
BEFORE UPDATE ON app_devices
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
AND (NEW.status <> 'revoked' OR NEW.installation_hash NOT GLOB 'deleted:*')
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_session_insert
BEFORE INSERT ON app_sessions
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_session_reactivation
BEFORE UPDATE ON app_sessions
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
AND (NEW.status <> 'revoked' OR NEW.revoke_reason NOT IN ('account_deletion_requested', 'account_deletion'))
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_profile_block_insert
BEFORE INSERT ON app_profile_blocks
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_profile_block_event_insert
BEFORE INSERT ON app_profile_block_events
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_recommendation_preferences_insert
BEFORE INSERT ON app_recommendation_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_recommendation_preferences_update
BEFORE UPDATE ON app_recommendation_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_view_history_preferences_insert
BEFORE INSERT ON app_view_history_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_view_history_preferences_update
BEFORE UPDATE ON app_view_history_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_search_history_preferences_insert
BEFORE INSERT ON app_search_history_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_search_history_preferences_update
BEFORE UPDATE ON app_search_history_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_saved_filter_insert
BEFORE INSERT ON app_saved_person_filters
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_saved_filter_update
BEFORE UPDATE ON app_saved_person_filters
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_account_preferences_insert
BEFORE INSERT ON app_account_profile_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_account_preferences_update
BEFORE UPDATE ON app_account_profile_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_conversation_settings_insert
BEFORE INSERT ON app_conversation_viewer_settings
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_conversation_settings_update
BEFORE UPDATE ON app_conversation_viewer_settings
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_notification_preferences_insert
BEFORE INSERT ON app_notification_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_notification_preferences_update
BEFORE UPDATE ON app_notification_preferences
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = OLD.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_notification_preference_event_insert
BEFORE INSERT ON app_notification_preference_events
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

-- 业务事实自身仍可完成合规处置；只忽略面向已注销账号的新通知投递副作用。
CREATE TRIGGER app_data_rights_deletion_suppress_notification_outbox_insert
BEFORE INSERT ON app_notification_outbox
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_notification_insert
BEFORE INSERT ON app_notifications
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_block_notification_read_event_insert
BEFORE INSERT ON app_notification_read_events
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_export_artifact_insert
BEFORE INSERT ON app_data_rights_export_artifacts
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_export_ticket_insert
BEFORE INSERT ON app_data_rights_export_download_tickets
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

CREATE TRIGGER app_data_rights_deletion_block_export_download_command_insert
BEFORE INSERT ON app_data_rights_export_download_commands
WHEN EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.account_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(ABORT, 'account deletion pending');
END;

-- 过期埋点或归因任务不得在匿名化检查点之后重新绑定已注销账号；匿名事实仍可用 NULL 主体写入。
CREATE TRIGGER app_data_rights_deletion_suppress_analytics_visitor_insert
BEFORE INSERT ON analytics_visitors
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_visitor_update
BEFORE UPDATE ON analytics_visitors
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_session_insert
BEFORE INSERT ON analytics_sessions
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_session_update
BEFORE UPDATE ON analytics_sessions
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_page_summary_insert
BEFORE INSERT ON analytics_page_summaries
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_page_summary_update
BEFORE UPDATE ON analytics_page_summaries
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_session_summary_insert
BEFORE INSERT ON analytics_session_summaries
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_session_summary_update
BEFORE UPDATE ON analytics_session_summaries
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_event_insert
BEFORE INSERT ON analytics_events
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_event_update
BEFORE UPDATE ON analytics_events
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_conversion_insert
BEFORE INSERT ON analytics_conversion_actions
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER app_data_rights_deletion_suppress_analytics_conversion_update
BEFORE UPDATE ON analytics_conversion_actions
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM app_account_security security
  WHERE security.account_id = NEW.user_id AND security.status = 'deletion_pending'
)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- Privacy-1 允许 failed -> scheduled。Privacy-2B 的前向修复直接恢复到 processing，
-- 避免已开始不可逆动作后重新出现“可取消等待期”的错误语义。
DROP TRIGGER app_data_rights_requests_guard_update;

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
      OR (OLD.status = 'failed' AND NEW.status = 'processing')
      OR (OLD.status = NEW.status)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid app data rights request transition');
END;
