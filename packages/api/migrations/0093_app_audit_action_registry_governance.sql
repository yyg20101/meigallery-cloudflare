-- Audit-3：Action 口径治理、独立复核与未登记 Action 收口。
--
-- 边界：
-- 1. app_audit_action_registry 继续是唯一正式 Action 口径；本 migration 不 seed 或自动发布任何口径；
-- 2. 管理员审计事实仍只写 admin_audit_logs，不复制第二套事实链；
-- 3. 候选口径只能由 Owner 提交，并由另一位 Owner 独立复核后追加正式版本；
-- 4. 发布与退休都只追加版本，不修改或删除历史口径和历史审计事实；
-- 5. retention/quality 只保存已审批策略的稳定引用，本 migration 不批准保留期、不执行清理。

CREATE TABLE app_audit_governance_policy_registry (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 96),
  reference_key TEXT NOT NULL CHECK (length(reference_key) BETWEEN 3 AND 192),
  policy_type TEXT NOT NULL CHECK (policy_type IN ('retention', 'quality')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  owner_reference TEXT NOT NULL CHECK (length(owner_reference) BETWEEN 3 AND 192),
  decision_status TEXT NOT NULL CHECK (decision_status IN ('unresolved', 'approved')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  decision_evidence_reference TEXT
    CHECK (decision_evidence_reference IS NULL OR length(decision_evidence_reference) BETWEEN 3 AND 192),
  created_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  approved_at TEXT CHECK (approved_at IS NULL OR julianday(approved_at) IS NOT NULL),
  UNIQUE (reference_key, policy_type, schema_version),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (
    (decision_status = 'unresolved'
      AND production_ready = 0
      AND approved_by IS NULL
      AND approved_at IS NULL)
    OR
    (decision_status = 'approved'
      AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND decision_evidence_reference IS NOT NULL)
  ),
  CHECK (status = 'active' OR production_ready = 0)
);

CREATE INDEX idx_app_audit_governance_policy_type
  ON app_audit_governance_policy_registry(policy_type, status, reference_key);

CREATE VIEW app_audit_current_governance_policies AS
SELECT policy.*
FROM app_audit_governance_policy_registry policy
JOIN (
  SELECT reference_key, policy_type, MAX(schema_version) AS schema_version
  FROM app_audit_governance_policy_registry
  GROUP BY reference_key, policy_type
) latest
  ON latest.reference_key = policy.reference_key
 AND latest.policy_type = policy.policy_type
 AND latest.schema_version = policy.schema_version
WHERE policy.status = 'active';

-- 只有正式 Action 版本及其两类策略引用都生产就绪时，才允许进入普通管理查询和导出。
CREATE VIEW app_audit_production_action_registry AS
SELECT registry.*
FROM app_audit_current_action_registry registry
JOIN app_audit_current_governance_policies retention
  ON retention.reference_key = registry.retention_policy_reference
 AND retention.policy_type = 'retention'
 AND retention.decision_status = 'approved'
 AND retention.production_ready = 1
JOIN app_audit_current_governance_policies quality
  ON quality.reference_key = registry.quality_rule_reference
 AND quality.policy_type = 'quality'
 AND quality.decision_status = 'approved'
 AND quality.production_ready = 1
WHERE EXISTS (
  SELECT 1 FROM json_each(registry.visible_roles_json) visible_role
  WHERE visible_role.value = 'owner'
);

CREATE TABLE app_audit_registry_change_requests (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 96),
  action_key TEXT NOT NULL CHECK (length(action_key) BETWEEN 2 AND 128),
  operation TEXT NOT NULL CHECK (operation IN ('publish', 'retire')),
  proposed_schema_version INTEGER NOT NULL CHECK (proposed_schema_version > 0),
  proposed_domain TEXT NOT NULL CHECK (length(proposed_domain) BETWEEN 1 AND 48),
  proposed_display_name TEXT NOT NULL CHECK (length(trim(proposed_display_name)) BETWEEN 1 AND 120),
  proposed_owner_reference TEXT NOT NULL CHECK (length(proposed_owner_reference) BETWEEN 1 AND 192),
  proposed_sensitivity TEXT NOT NULL
    CHECK (proposed_sensitivity IN ('internal', 'restricted', 'highly_restricted')),
  proposed_risk_level TEXT NOT NULL
    CHECK (proposed_risk_level IN ('low', 'medium', 'high', 'critical')),
  proposed_visible_roles_json TEXT NOT NULL
    CHECK (
      json_valid(proposed_visible_roles_json)
      AND json_type(proposed_visible_roles_json) = 'array'
      AND json_array_length(proposed_visible_roles_json) BETWEEN 1 AND 2
    ),
  proposed_retention_policy_reference TEXT
    CHECK (
      proposed_retention_policy_reference IS NULL
      OR length(proposed_retention_policy_reference) BETWEEN 3 AND 192
    ),
  proposed_quality_rule_reference TEXT
    CHECK (
      proposed_quality_rule_reference IS NULL
      OR length(proposed_quality_rule_reference) BETWEEN 3 AND 192
    ),
  expected_current_schema_version INTEGER
    CHECK (expected_current_schema_version IS NULL OR expected_current_schema_version > 0),
  observation_digest TEXT NOT NULL CHECK (
    length(observation_digest) = 64
    AND observation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  observed_event_count INTEGER NOT NULL CHECK (observed_event_count >= 0),
  observed_first_at TEXT CHECK (observed_first_at IS NULL OR julianday(observed_first_at) IS NOT NULL),
  observed_last_at TEXT CHECK (observed_last_at IS NULL OR julianday(observed_last_at) IS NOT NULL),
  request_reason TEXT NOT NULL CHECK (length(trim(request_reason)) BETWEEN 10 AND 1000),
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected', 'stale')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT NOT NULL CHECK (length(mutation_token) BETWEEN 16 AND 96),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  review_reason_code TEXT CHECK (review_reason_code IS NULL OR length(review_reason_code) BETWEEN 3 AND 80),
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 10 AND 1000),
  result_registry_id TEXT REFERENCES app_audit_action_registry(id),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  applied_at TEXT CHECK (applied_at IS NULL OR julianday(applied_at) IS NOT NULL),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
  CHECK (
    (status = 'pending_review'
      AND reviewed_by IS NULL
      AND review_reason_code IS NULL
      AND review_note IS NULL
      AND result_registry_id IS NULL
      AND reviewed_at IS NULL
      AND applied_at IS NULL)
    OR
    (status = 'approved'
      AND reviewed_by IS NOT NULL
      AND review_reason_code IS NOT NULL
      AND review_note IS NOT NULL
      AND result_registry_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND applied_at IS NOT NULL)
    OR
    (status IN ('rejected', 'stale')
      AND reviewed_by IS NOT NULL
      AND review_reason_code IS NOT NULL
      AND review_note IS NOT NULL
      AND result_registry_id IS NULL
      AND reviewed_at IS NOT NULL
      AND applied_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_app_audit_registry_change_pending_action
  ON app_audit_registry_change_requests(action_key)
  WHERE status = 'pending_review';
CREATE INDEX idx_app_audit_registry_change_status
  ON app_audit_registry_change_requests(status, updated_at DESC, id DESC);
CREATE INDEX idx_app_audit_registry_change_requester
  ON app_audit_registry_change_requests(requested_by, created_at DESC);

CREATE TABLE app_audit_registry_change_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 96),
  request_id TEXT NOT NULL
    REFERENCES app_audit_registry_change_requests(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted', 'approved', 'rejected', 'stale')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 80),
  safe_summary_json TEXT NOT NULL
    CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, sequence)
);

CREATE INDEX idx_app_audit_registry_change_events_request
  ON app_audit_registry_change_events(request_id, sequence ASC);

CREATE TABLE app_audit_registry_commands (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 96),
  admin_id INTEGER NOT NULL REFERENCES users(id),
  command_scope TEXT NOT NULL CHECK (command_scope IN ('create', 'review')),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_id TEXT NOT NULL
    REFERENCES app_audit_registry_change_requests(id),
  result_status TEXT NOT NULL CHECK (result_status IN ('pending_review', 'approved', 'rejected', 'stale')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (admin_id, command_scope, idempotency_key_hash)
);

CREATE TRIGGER app_audit_registry_change_requests_guard_update
BEFORE UPDATE ON app_audit_registry_change_requests
WHEN
  OLD.status <> 'pending_review'
  OR NEW.status NOT IN ('approved', 'rejected', 'stale')
  OR NEW.version <> OLD.version + 1
  OR NEW.mutation_token = OLD.mutation_token
  OR NEW.id IS NOT OLD.id
  OR NEW.action_key IS NOT OLD.action_key
  OR NEW.operation IS NOT OLD.operation
  OR NEW.proposed_schema_version IS NOT OLD.proposed_schema_version
  OR NEW.proposed_domain IS NOT OLD.proposed_domain
  OR NEW.proposed_display_name IS NOT OLD.proposed_display_name
  OR NEW.proposed_owner_reference IS NOT OLD.proposed_owner_reference
  OR NEW.proposed_sensitivity IS NOT OLD.proposed_sensitivity
  OR NEW.proposed_risk_level IS NOT OLD.proposed_risk_level
  OR NEW.proposed_visible_roles_json IS NOT OLD.proposed_visible_roles_json
  OR NEW.proposed_retention_policy_reference IS NOT OLD.proposed_retention_policy_reference
  OR NEW.proposed_quality_rule_reference IS NOT OLD.proposed_quality_rule_reference
  OR NEW.expected_current_schema_version IS NOT OLD.expected_current_schema_version
  OR NEW.observation_digest IS NOT OLD.observation_digest
  OR NEW.observed_event_count IS NOT OLD.observed_event_count
  OR NEW.observed_first_at IS NOT OLD.observed_first_at
  OR NEW.observed_last_at IS NOT OLD.observed_last_at
  OR NEW.request_reason IS NOT OLD.request_reason
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'audit registry requests use one guarded terminal transition');
END;

CREATE TRIGGER app_audit_governance_policy_registry_no_update
BEFORE UPDATE ON app_audit_governance_policy_registry
BEGIN
  SELECT RAISE(ABORT, 'audit governance policies are versioned and immutable');
END;

CREATE TRIGGER app_audit_governance_policy_registry_no_delete
BEFORE DELETE ON app_audit_governance_policy_registry
BEGIN
  SELECT RAISE(ABORT, 'audit governance policies are immutable');
END;

CREATE TRIGGER app_audit_registry_change_requests_no_delete
BEFORE DELETE ON app_audit_registry_change_requests
BEGIN
  SELECT RAISE(ABORT, 'audit registry requests are immutable history');
END;

CREATE TRIGGER app_audit_registry_change_events_no_update
BEFORE UPDATE ON app_audit_registry_change_events
BEGIN
  SELECT RAISE(ABORT, 'audit registry request events are immutable');
END;

CREATE TRIGGER app_audit_registry_change_events_no_delete
BEFORE DELETE ON app_audit_registry_change_events
BEGIN
  SELECT RAISE(ABORT, 'audit registry request events are immutable');
END;

CREATE TRIGGER app_audit_registry_commands_no_update
BEFORE UPDATE ON app_audit_registry_commands
BEGIN
  SELECT RAISE(ABORT, 'audit registry commands are immutable');
END;

CREATE TRIGGER app_audit_registry_commands_no_delete
BEFORE DELETE ON app_audit_registry_commands
BEGIN
  SELECT RAISE(ABORT, 'audit registry commands are immutable');
END;
