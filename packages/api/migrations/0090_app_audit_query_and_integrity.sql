-- Audit-1：App 管理审计查询、不可变索引与完整性清单。
--
-- 边界：
-- 1. admin_audit_logs 继续是唯一审计事实源，不复制成第二套可写审计日志；
-- 2. 本 migration 不写生产策略、不配置保留期、不创建导出文件，也不执行自动清理；
-- 3. 自动索引只保存责任事实和非敏感引用，before/after 仍留在原事实表并由 API 统一脱敏；
-- 4. 完整性检查只追加清单与 finding，绝不自动修改、补写或删除原审计事件。

CREATE TABLE app_audit_event_index (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_event_id TEXT NOT NULL UNIQUE
    REFERENCES admin_audit_logs(id),
  actor_role_snapshot TEXT NOT NULL CHECK (length(actor_role_snapshot) BETWEEN 1 AND 48),
  action_domain TEXT NOT NULL CHECK (length(action_domain) BETWEEN 1 AND 48),
  risk_level TEXT NOT NULL
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  result TEXT NOT NULL DEFAULT 'succeeded'
    CHECK (result IN ('succeeded', 'denied', 'failed')),
  occurred_at TEXT NOT NULL CHECK (julianday(occurred_at) IS NOT NULL)
);

CREATE INDEX idx_app_audit_event_index_occurred
  ON app_audit_event_index(occurred_at DESC, sequence DESC);
CREATE INDEX idx_app_audit_event_index_domain
  ON app_audit_event_index(action_domain, sequence DESC);
CREATE INDEX idx_app_audit_event_index_risk
  ON app_audit_event_index(risk_level, sequence DESC);

-- 为已有事实建立稳定序号。相同时间使用 audit event ID 决定确定性顺序。
INSERT INTO app_audit_event_index (
  sequence,
  audit_event_id,
  actor_role_snapshot,
  action_domain,
  risk_level,
  result,
  occurred_at
)
SELECT
  ROW_NUMBER() OVER (ORDER BY audit.created_at ASC, audit.id ASC),
  audit.id,
  COALESCE(actor.role, 'unknown'),
  CASE
    WHEN audit.action LIKE 'app.person.%' OR audit.action LIKE 'app_person.%' THEN 'person'
    WHEN audit.action LIKE 'app.taxonomy.%' OR audit.action LIKE 'app_taxonomy.%' THEN 'taxonomy'
    WHEN audit.action LIKE 'app.recommendation.%' OR audit.action LIKE 'app_recommendation.%' THEN 'recommendation'
    WHEN audit.action LIKE 'app.conversation.%' OR audit.action LIKE 'app_conversation%' THEN 'conversation'
    WHEN audit.action LIKE 'app.messaging.%' OR audit.action LIKE 'app_messaging.%' THEN 'conversation'
    WHEN audit.action LIKE 'app.safety.%' OR audit.action LIKE 'app_safety.%'
      OR audit.action LIKE 'moderation.%' THEN 'safety'
    WHEN audit.action LIKE 'app.membership.%' OR audit.action LIKE 'app_membership_%' THEN 'membership'
    WHEN audit.action LIKE 'app.wallet.%' OR audit.action LIKE 'app_wallet_%' THEN 'wallet'
    WHEN audit.action LIKE 'app.notification.%' OR audit.action LIKE 'app_notification_%' THEN 'notification'
    WHEN audit.action LIKE 'app.audit.%' OR audit.action LIKE 'app_audit_%' THEN 'audit'
    WHEN instr(audit.action, '.') > 0 THEN substr(audit.action, 1, instr(audit.action, '.') - 1)
    ELSE 'legacy'
  END,
  CASE
    WHEN audit.action LIKE 'app.wallet.%'
      OR audit.action LIKE 'app_wallet_%'
      OR audit.action LIKE 'app.membership.%publish%'
      OR audit.action LIKE 'app.membership.%grant%'
      OR audit.action LIKE 'app.membership.%revok%'
      OR audit.action LIKE 'app_membership_%grant%'
      OR audit.action LIKE 'app_membership_%revok%'
      OR audit.action = 'app.membership.change.approve'
      OR audit.action = 'app_membership_application_approve'
      OR audit.action LIKE 'app.safety.%decide%'
      OR audit.action LIKE 'moderation.%decision%'
      OR audit.action LIKE 'app.person.%publish%'
      OR audit.action LIKE 'app_person.%publish%'
      OR audit.action LIKE 'app_person.%revoke%'
      OR audit.action LIKE 'app_person.%pause%'
      OR audit.action LIKE 'app.audit.integrity.%'
      OR audit.action LIKE 'app.audit.export.%'
    THEN 'critical'
    WHEN audit.action LIKE 'app.%'
      OR audit.action LIKE 'app_%'
      OR audit.action LIKE 'user.%'
      OR audit.action LIKE 'settings.%'
      OR audit.action LIKE 'media.%'
      OR audit.action LIKE 'import.%'
    THEN 'high'
    ELSE 'medium'
  END,
  CASE
    WHEN audit.action LIKE '%denied%' THEN 'denied'
    WHEN audit.action LIKE '%failed%'
      OR audit.action LIKE '%conflict%'
      OR audit.action LIKE '%stale%'
    THEN 'failed'
    ELSE 'succeeded'
  END,
  audit.created_at
FROM admin_audit_logs audit
LEFT JOIN users actor ON actor.id = audit.admin_id
ORDER BY audit.created_at ASC, audit.id ASC;

-- 新审计事实插入时自动建立索引，避免要求所有既有业务写路径同次改造。
CREATE TRIGGER app_audit_event_index_after_insert
AFTER INSERT ON admin_audit_logs
BEGIN
  INSERT INTO app_audit_event_index (
    audit_event_id,
    actor_role_snapshot,
    action_domain,
    risk_level,
    result,
    occurred_at
  ) VALUES (
    NEW.id,
    COALESCE((SELECT role FROM users WHERE id = NEW.admin_id), 'unknown'),
    CASE
      WHEN NEW.action LIKE 'app.person.%' OR NEW.action LIKE 'app_person.%' THEN 'person'
      WHEN NEW.action LIKE 'app.taxonomy.%' OR NEW.action LIKE 'app_taxonomy.%' THEN 'taxonomy'
      WHEN NEW.action LIKE 'app.recommendation.%' OR NEW.action LIKE 'app_recommendation.%' THEN 'recommendation'
      WHEN NEW.action LIKE 'app.conversation.%' OR NEW.action LIKE 'app_conversation%' THEN 'conversation'
      WHEN NEW.action LIKE 'app.messaging.%' OR NEW.action LIKE 'app_messaging.%' THEN 'conversation'
      WHEN NEW.action LIKE 'app.safety.%' OR NEW.action LIKE 'app_safety.%'
        OR NEW.action LIKE 'moderation.%' THEN 'safety'
      WHEN NEW.action LIKE 'app.membership.%' OR NEW.action LIKE 'app_membership_%' THEN 'membership'
      WHEN NEW.action LIKE 'app.wallet.%' OR NEW.action LIKE 'app_wallet_%' THEN 'wallet'
      WHEN NEW.action LIKE 'app.notification.%' OR NEW.action LIKE 'app_notification_%' THEN 'notification'
      WHEN NEW.action LIKE 'app.audit.%' OR NEW.action LIKE 'app_audit_%' THEN 'audit'
      WHEN instr(NEW.action, '.') > 0 THEN substr(NEW.action, 1, instr(NEW.action, '.') - 1)
      ELSE 'legacy'
    END,
    CASE
      WHEN NEW.action LIKE 'app.wallet.%'
        OR NEW.action LIKE 'app_wallet_%'
        OR NEW.action LIKE 'app.membership.%publish%'
        OR NEW.action LIKE 'app.membership.%grant%'
        OR NEW.action LIKE 'app.membership.%revok%'
        OR NEW.action LIKE 'app_membership_%grant%'
        OR NEW.action LIKE 'app_membership_%revok%'
        OR NEW.action = 'app.membership.change.approve'
        OR NEW.action = 'app_membership_application_approve'
        OR NEW.action LIKE 'app.safety.%decide%'
        OR NEW.action LIKE 'moderation.%decision%'
        OR NEW.action LIKE 'app.person.%publish%'
        OR NEW.action LIKE 'app_person.%publish%'
        OR NEW.action LIKE 'app_person.%revoke%'
        OR NEW.action LIKE 'app_person.%pause%'
        OR NEW.action LIKE 'app.audit.integrity.%'
        OR NEW.action LIKE 'app.audit.export.%'
      THEN 'critical'
      WHEN NEW.action LIKE 'app.%'
        OR NEW.action LIKE 'app_%'
        OR NEW.action LIKE 'user.%'
        OR NEW.action LIKE 'settings.%'
        OR NEW.action LIKE 'media.%'
        OR NEW.action LIKE 'import.%'
      THEN 'high'
      ELSE 'medium'
    END,
    CASE
      WHEN NEW.action LIKE '%denied%' THEN 'denied'
      WHEN NEW.action LIKE '%failed%'
        OR NEW.action LIKE '%conflict%'
        OR NEW.action LIKE '%stale%'
      THEN 'failed'
      ELSE 'succeeded'
    END,
    NEW.created_at
  );
END;

-- 新写路径可在同一事务中追加明确的 request/trace/业务引用；既有事件保持兼容。
CREATE TABLE app_audit_event_contexts (
  audit_event_id TEXT PRIMARY KEY
    REFERENCES admin_audit_logs(id),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 192),
  trace_id TEXT CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 192),
  idempotency_key_hash TEXT CHECK (
    idempotency_key_hash IS NULL
    OR (
      length(idempotency_key_hash) = 64
      AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 120),
  business_reference TEXT CHECK (
    business_reference IS NULL OR length(business_reference) BETWEEN 1 AND 192
  ),
  target_version TEXT CHECK (target_version IS NULL OR length(target_version) BETWEEN 1 AND 192),
  approval_request_id TEXT CHECK (
    approval_request_id IS NULL OR length(approval_request_id) BETWEEN 1 AND 192
  ),
  approval_step_id TEXT CHECK (
    approval_step_id IS NULL OR length(approval_step_id) BETWEEN 1 AND 192
  ),
  policy_version TEXT CHECK (policy_version IS NULL OR length(policy_version) BETWEEN 1 AND 192),
  capability TEXT CHECK (capability IS NULL OR length(capability) BETWEEN 1 AND 120),
  scope_summary TEXT CHECK (scope_summary IS NULL OR length(scope_summary) BETWEEN 1 AND 1000),
  result TEXT
    CHECK (result IS NULL OR result IN ('succeeded', 'denied', 'failed')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_audit_context_request
  ON app_audit_event_contexts(request_id);
CREATE INDEX idx_app_audit_context_trace
  ON app_audit_event_contexts(trace_id);
CREATE INDEX idx_app_audit_context_business
  ON app_audit_event_contexts(business_reference);

-- 动作定义是生产就绪门禁；本 migration 不 seed 任何未经 Owner 确认的生产口径。
CREATE TABLE app_audit_action_registry (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 5 AND 96),
  action_key TEXT NOT NULL CHECK (length(action_key) BETWEEN 2 AND 128),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 48),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  owner_reference TEXT NOT NULL CHECK (length(owner_reference) BETWEEN 1 AND 192),
  sensitivity TEXT NOT NULL
    CHECK (sensitivity IN ('internal', 'restricted', 'highly_restricted')),
  risk_level TEXT NOT NULL
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  visible_roles_json TEXT NOT NULL
    CHECK (json_valid(visible_roles_json) AND json_type(visible_roles_json) = 'array'),
  retention_policy_reference TEXT
    CHECK (retention_policy_reference IS NULL OR length(retention_policy_reference) BETWEEN 1 AND 192),
  quality_rule_reference TEXT
    CHECK (quality_rule_reference IS NULL OR length(quality_rule_reference) BETWEEN 1 AND 192),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'retired')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (action_key, schema_version)
);

CREATE INDEX idx_app_audit_action_registry_domain
  ON app_audit_action_registry(domain, status, action_key);

-- 当前定义由每个 action 的最高版本决定；最高版本为 retired 时该 action 不再登记为 active。
CREATE VIEW app_audit_current_action_registry AS
SELECT registry.*
FROM app_audit_action_registry registry
JOIN (
  SELECT action_key, MAX(schema_version) AS schema_version
  FROM app_audit_action_registry
  GROUP BY action_key
) latest
  ON latest.action_key = registry.action_key
 AND latest.schema_version = registry.schema_version
WHERE registry.status = 'active';

CREATE TABLE app_audit_integrity_checks (
  id TEXT PRIMARY KEY,
  start_sequence INTEGER NOT NULL CHECK (start_sequence > 0),
  end_sequence INTEGER NOT NULL CHECK (end_sequence >= start_sequence),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  manifest_version TEXT NOT NULL CHECK (length(manifest_version) BETWEEN 1 AND 80),
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64
    AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL
    CHECK (status IN ('passed', 'findings')),
  sequence_gap_count INTEGER NOT NULL DEFAULT 0 CHECK (sequence_gap_count >= 0),
  missing_index_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_index_count >= 0),
  malformed_payload_count INTEGER NOT NULL DEFAULT 0 CHECK (malformed_payload_count >= 0),
  sensitive_key_count INTEGER NOT NULL DEFAULT 0 CHECK (sensitive_key_count >= 0),
  unregistered_action_count INTEGER NOT NULL DEFAULT 0 CHECK (unregistered_action_count >= 0),
  business_without_audit_count INTEGER NOT NULL DEFAULT 0 CHECK (business_without_audit_count >= 0),
  previous_manifest_check_id TEXT
    REFERENCES app_audit_integrity_checks(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_audit_integrity_checks_range
  ON app_audit_integrity_checks(start_sequence, end_sequence, created_at DESC);
CREATE INDEX idx_app_audit_integrity_checks_time
  ON app_audit_integrity_checks(created_at DESC);

CREATE TABLE app_audit_integrity_findings (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL
    REFERENCES app_audit_integrity_checks(id),
  finding_type TEXT NOT NULL
    CHECK (finding_type IN (
      'sequence_gap',
      'missing_index',
      'malformed_payload',
      'sensitive_key',
      'unregistered_action',
      'business_without_audit',
      'manifest_changed'
    )),
  severity TEXT NOT NULL
    CHECK (severity IN ('info', 'warning', 'critical')),
  sequence INTEGER,
  audit_event_id TEXT,
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64
    AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  summary_code TEXT NOT NULL CHECK (length(summary_code) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_audit_integrity_findings_check
  ON app_audit_integrity_findings(check_id, severity, id);

CREATE TABLE app_audit_integrity_commands (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  check_id TEXT NOT NULL REFERENCES app_audit_integrity_checks(id),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (admin_id, idempotency_key)
);

-- 所有审计事实、索引、上下文、动作登记和完整性结果均只能追加。
CREATE TRIGGER admin_audit_logs_no_update
BEFORE UPDATE ON admin_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'admin audit events are immutable');
END;

CREATE TRIGGER admin_audit_logs_no_delete
BEFORE DELETE ON admin_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'admin audit events are immutable');
END;

CREATE TRIGGER app_audit_event_index_no_update
BEFORE UPDATE ON app_audit_event_index
BEGIN
  SELECT RAISE(ABORT, 'audit indexes are immutable');
END;

CREATE TRIGGER app_audit_event_index_no_delete
BEFORE DELETE ON app_audit_event_index
BEGIN
  SELECT RAISE(ABORT, 'audit indexes are immutable');
END;

CREATE TRIGGER app_audit_event_contexts_no_update
BEFORE UPDATE ON app_audit_event_contexts
BEGIN
  SELECT RAISE(ABORT, 'audit contexts are immutable');
END;

CREATE TRIGGER app_audit_event_contexts_no_delete
BEFORE DELETE ON app_audit_event_contexts
BEGIN
  SELECT RAISE(ABORT, 'audit contexts are immutable');
END;

CREATE TRIGGER app_audit_action_registry_no_update
BEFORE UPDATE ON app_audit_action_registry
BEGIN
  SELECT RAISE(ABORT, 'audit action definitions are versioned and immutable');
END;

CREATE TRIGGER app_audit_action_registry_no_delete
BEFORE DELETE ON app_audit_action_registry
BEGIN
  SELECT RAISE(ABORT, 'audit action definitions are immutable');
END;

CREATE TRIGGER app_audit_integrity_checks_no_update
BEFORE UPDATE ON app_audit_integrity_checks
BEGIN
  SELECT RAISE(ABORT, 'audit integrity checks are immutable');
END;

CREATE TRIGGER app_audit_integrity_checks_no_delete
BEFORE DELETE ON app_audit_integrity_checks
BEGIN
  SELECT RAISE(ABORT, 'audit integrity checks are immutable');
END;

CREATE TRIGGER app_audit_integrity_findings_no_update
BEFORE UPDATE ON app_audit_integrity_findings
BEGIN
  SELECT RAISE(ABORT, 'audit integrity findings are immutable');
END;

CREATE TRIGGER app_audit_integrity_findings_no_delete
BEFORE DELETE ON app_audit_integrity_findings
BEGIN
  SELECT RAISE(ABORT, 'audit integrity findings are immutable');
END;

CREATE TRIGGER app_audit_integrity_commands_no_update
BEFORE UPDATE ON app_audit_integrity_commands
BEGIN
  SELECT RAISE(ABORT, 'audit integrity commands are immutable');
END;

CREATE TRIGGER app_audit_integrity_commands_no_delete
BEFORE DELETE ON app_audit_integrity_commands
BEGIN
  SELECT RAISE(ABORT, 'audit integrity commands are immutable');
END;
