-- Operations-1：App 运营总览、事件中心、Runbook 与跨域安全控制。
--
-- 边界：
-- 1. admin_audit_logs 继续是唯一管理审计事实源；本表族只保存运营快照、事件工作流与安全控制业务事实；
-- 2. 指标必须显式携带质量状态，缺失、延迟、未配置或不完整时不得用 0 代替；
-- 3. 安全控制只负责暂停既有服务端能力，不会把原本关闭的产品 capability 打开；
-- 4. 本 migration 不写环境配置、不创建真实事件、不执行检测或快照刷新，也不启用定时任务。

CREATE TABLE app_operational_metric_definitions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opmd_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  metric_key TEXT NOT NULL
    CHECK (
      length(metric_key) BETWEEN 3 AND 96
      AND metric_key NOT GLOB '*[^a-z0-9._-]*'
    ),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  topic TEXT NOT NULL
    CHECK (topic IN (
      'supply', 'discovery', 'messaging', 'membership', 'wallet',
      'notification', 'safety', 'audit', 'platform'
    )),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  unit TEXT NOT NULL CHECK (unit IN ('count', 'ratio', 'milliseconds', 'status')),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('d1_live_query', 'cloudflare_observability', 'manual_evidence')),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 3 AND 192),
  owner_reference TEXT NOT NULL CHECK (length(owner_reference) BETWEEN 3 AND 192),
  freshness_slo_seconds INTEGER NOT NULL CHECK (freshness_slo_seconds BETWEEN 60 AND 604800),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('internal', 'restricted')),
  visible_roles_json TEXT NOT NULL DEFAULT '["admin","owner"]'
    CHECK (json_valid(visible_roles_json) AND json_type(visible_roles_json) = 'array'),
  retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (retention_decision_status IN ('unresolved', 'approved')),
  retention_policy_reference TEXT
    CHECK (retention_policy_reference IS NULL OR length(retention_policy_reference) BETWEEN 3 AND 192),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_origin TEXT NOT NULL DEFAULT 'system' CHECK (created_origin IN ('system', 'admin')),
  created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (metric_key, schema_version),
  CHECK (
    (created_origin = 'system' AND created_by IS NULL)
    OR (created_origin = 'admin' AND created_by IS NOT NULL)
  ),
  CHECK (
    (retention_decision_status = 'unresolved' AND retention_policy_reference IS NULL AND production_ready = 0)
    OR (retention_decision_status = 'approved' AND retention_policy_reference IS NOT NULL)
  )
);

CREATE INDEX idx_app_operational_metric_definitions_topic
  ON app_operational_metric_definitions(topic, status, metric_key, schema_version DESC);

CREATE VIEW app_operational_current_metric_definitions AS
SELECT definition.*
FROM app_operational_metric_definitions definition
JOIN (
  SELECT metric_key, MAX(schema_version) AS schema_version
  FROM app_operational_metric_definitions
  GROUP BY metric_key
) latest
  ON latest.metric_key = definition.metric_key
 AND latest.schema_version = definition.schema_version
WHERE definition.status = 'active';

CREATE TABLE app_operational_metric_runs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opmr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  run_version TEXT NOT NULL CHECK (length(run_version) BETWEEN 3 AND 80),
  scope_key TEXT NOT NULL DEFAULT 'global' CHECK (scope_key = 'global'),
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  metric_count INTEGER NOT NULL CHECK (metric_count >= 0),
  known_count INTEGER NOT NULL CHECK (known_count BETWEEN 0 AND metric_count),
  quality_summary_json TEXT NOT NULL
    CHECK (json_valid(quality_summary_json) AND json_type(quality_summary_json) = 'object'),
  started_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL CHECK (julianday(started_at) IS NOT NULL),
  completed_at TEXT NOT NULL CHECK (julianday(completed_at) IS NOT NULL),
  CHECK (julianday(completed_at) >= julianday(started_at))
);

CREATE INDEX idx_app_operational_metric_runs_time
  ON app_operational_metric_runs(completed_at DESC, id DESC);

CREATE TABLE app_operational_metric_snapshots (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opms_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 112
    ),
  run_id TEXT NOT NULL REFERENCES app_operational_metric_runs(id) ON DELETE RESTRICT,
  definition_id TEXT NOT NULL REFERENCES app_operational_metric_definitions(id) ON DELETE RESTRICT,
  scope_key TEXT NOT NULL DEFAULT 'global' CHECK (scope_key = 'global'),
  quality_state TEXT NOT NULL
    CHECK (quality_state IN ('known', 'unknown', 'delayed', 'partial', 'invalid', 'unconfigured')),
  value_integer INTEGER,
  value_real REAL,
  value_text TEXT CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 120),
  source_watermark TEXT CHECK (source_watermark IS NULL OR julianday(source_watermark) IS NOT NULL),
  measured_at TEXT NOT NULL CHECK (julianday(measured_at) IS NOT NULL),
  safe_details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_details_json) AND json_type(safe_details_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (run_id, definition_id, scope_key),
  CHECK (
    (quality_state = 'known' AND (
      (value_integer IS NOT NULL) + (value_real IS NOT NULL) + (value_text IS NOT NULL) = 1
    ))
    OR (quality_state <> 'known' AND value_integer IS NULL AND value_real IS NULL AND value_text IS NULL)
  )
);

CREATE INDEX idx_app_operational_metric_snapshots_definition
  ON app_operational_metric_snapshots(definition_id, measured_at DESC, id DESC);

CREATE TABLE app_operational_runbook_versions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'oprb_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  runbook_key TEXT NOT NULL
    CHECK (
      length(runbook_key) BETWEEN 3 AND 80
      AND runbook_key NOT GLOB '*[^a-z0-9._-]*'
    ),
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100),
  safe_summary TEXT NOT NULL CHECK (length(trim(safe_summary)) BETWEEN 1 AND 500),
  document_reference TEXT NOT NULL CHECK (length(document_reference) BETWEEN 3 AND 240),
  domains_json TEXT NOT NULL
    CHECK (json_valid(domains_json) AND json_type(domains_json) = 'array'),
  control_keys_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(control_keys_json) AND json_type(control_keys_json) = 'array'),
  minimum_severity TEXT NOT NULL DEFAULT 'p2' CHECK (minimum_severity IN ('p0', 'p1', 'p2', 'p3')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_origin TEXT NOT NULL DEFAULT 'system' CHECK (created_origin IN ('system', 'admin')),
  created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (runbook_key, version),
  CHECK (
    (created_origin = 'system' AND created_by IS NULL)
    OR (created_origin = 'admin' AND created_by IS NOT NULL)
  )
);

CREATE VIEW app_operational_current_runbooks AS
SELECT runbook.*
FROM app_operational_runbook_versions runbook
JOIN (
  SELECT runbook_key, MAX(version) AS version
  FROM app_operational_runbook_versions
  GROUP BY runbook_key
) latest
  ON latest.runbook_key = runbook.runbook_key
 AND latest.version = runbook.version
WHERE runbook.status = 'active';

CREATE TABLE app_operational_detection_runs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opdr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  detector_version TEXT NOT NULL CHECK (length(detector_version) BETWEEN 3 AND 80),
  scope_key TEXT NOT NULL DEFAULT 'global' CHECK (scope_key = 'global'),
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
  incident_created_count INTEGER NOT NULL CHECK (incident_created_count >= 0),
  incident_refreshed_count INTEGER NOT NULL CHECK (incident_refreshed_count >= 0),
  unavailable_detector_count INTEGER NOT NULL CHECK (unavailable_detector_count >= 0),
  evidence_digest TEXT NOT NULL
    CHECK (
      length(evidence_digest) = 64
      AND evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
  started_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL CHECK (julianday(started_at) IS NOT NULL),
  completed_at TEXT NOT NULL CHECK (julianday(completed_at) IS NOT NULL),
  CHECK (julianday(completed_at) >= julianday(started_at))
);

CREATE INDEX idx_app_operational_detection_runs_time
  ON app_operational_detection_runs(completed_at DESC, id DESC);

CREATE TABLE app_operational_incidents (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opinc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  incident_key TEXT NOT NULL UNIQUE
    CHECK (
      length(incident_key) BETWEEN 8 AND 160
      AND incident_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  incident_type TEXT NOT NULL
    CHECK (incident_type IN (
      'unauthorized_publication',
      'operator_identity_anomaly',
      'membership_expiry_not_revoked',
      'duplicate_membership_grant',
      'wallet_balance_mismatch',
      'unreviewed_wallet_adjustment',
      'audit_integrity_gap',
      'internal_note_exposure',
      'notification_backlog',
      'data_rights_overdue',
      'platform_health_anomaly'
    )),
  domain TEXT NOT NULL
    CHECK (domain IN (
      'supply', 'discovery', 'messaging', 'membership', 'wallet',
      'notification', 'safety', 'audit', 'platform'
    )),
  severity TEXT NOT NULL CHECK (severity IN ('p0', 'p1', 'p2', 'p3')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  safe_summary TEXT NOT NULL CHECK (length(trim(safe_summary)) BETWEEN 1 AND 500),
  source_type TEXT NOT NULL CHECK (source_type IN ('detector', 'audit_check', 'manual')),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 3 AND 192),
  impact_count INTEGER CHECK (impact_count IS NULL OR impact_count >= 0),
  impact_scope_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(impact_scope_json) AND json_type(impact_scope_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'investigating', 'mitigated', 'resolved', 'false_positive')),
  owner_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  runbook_id TEXT REFERENCES app_operational_runbook_versions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  signal_count INTEGER NOT NULL DEFAULT 1 CHECK (signal_count > 0),
  first_seen_at TEXT NOT NULL CHECK (julianday(first_seen_at) IS NOT NULL),
  last_seen_at TEXT NOT NULL CHECK (julianday(last_seen_at) IS NOT NULL),
  acknowledged_at TEXT CHECK (acknowledged_at IS NULL OR julianday(acknowledged_at) IS NOT NULL),
  mitigated_at TEXT CHECK (mitigated_at IS NULL OR julianday(mitigated_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  resolution_code TEXT
    CHECK (
      resolution_code IS NULL
      OR (
        length(resolution_code) BETWEEN 3 AND 80
        AND resolution_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  resolution_summary TEXT
    CHECK (resolution_summary IS NULL OR length(trim(resolution_summary)) BETWEEN 3 AND 500),
  close_evidence_reference TEXT
    CHECK (close_evidence_reference IS NULL OR length(close_evidence_reference) BETWEEN 3 AND 192),
  postmortem_reference TEXT
    CHECK (postmortem_reference IS NULL OR length(postmortem_reference) BETWEEN 3 AND 240),
  last_detection_run_id TEXT REFERENCES app_operational_detection_runs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (julianday(last_seen_at) >= julianday(first_seen_at)),
  CHECK (
    (status IN ('resolved', 'false_positive')
      AND resolved_at IS NOT NULL
      AND resolution_code IS NOT NULL
      AND resolution_summary IS NOT NULL
      AND close_evidence_reference IS NOT NULL)
    OR (status NOT IN ('resolved', 'false_positive') AND resolved_at IS NULL)
  )
);

CREATE INDEX idx_app_operational_incidents_queue
  ON app_operational_incidents(status, severity, last_seen_at DESC, id DESC);
CREATE INDEX idx_app_operational_incidents_owner
  ON app_operational_incidents(owner_admin_id, status, updated_at DESC, id DESC);
CREATE INDEX idx_app_operational_incidents_type
  ON app_operational_incidents(incident_type, status, last_seen_at DESC, id DESC);

CREATE TABLE app_operational_incident_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opie_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  incident_id TEXT NOT NULL REFERENCES app_operational_incidents(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  incident_version INTEGER NOT NULL CHECK (incident_version > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'detected', 'signal_refreshed', 'claimed', 'note_added', 'status_changed',
      'runbook_linked', 'control_paused', 'control_restored', 'resolved',
      'false_positive', 'reopened'
    )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'admin')),
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  status_from TEXT
    CHECK (status_from IS NULL OR status_from IN ('open', 'acknowledged', 'investigating', 'mitigated', 'resolved', 'false_positive')),
  status_to TEXT
    CHECK (status_to IS NULL OR status_to IN ('open', 'acknowledged', 'investigating', 'mitigated', 'resolved', 'false_positive')),
  reason_code TEXT NOT NULL
    CHECK (
      length(reason_code) BETWEEN 3 AND 80
      AND reason_code NOT GLOB '*[^a-z0-9_]*'
    ),
  response_note TEXT CHECK (response_note IS NULL OR length(trim(response_note)) BETWEEN 2 AND 1000),
  safe_summary_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  evidence_reference TEXT
    CHECK (evidence_reference IS NULL OR length(evidence_reference) BETWEEN 3 AND 192),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (incident_id, sequence),
  CHECK (
    (actor_type = 'system' AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_admin_id IS NOT NULL)
  )
);

CREATE INDEX idx_app_operational_incident_events_incident
  ON app_operational_incident_events(incident_id, sequence ASC);

CREATE TABLE app_operational_detection_findings (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opdf_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  run_id TEXT NOT NULL REFERENCES app_operational_detection_runs(id) ON DELETE RESTRICT,
  detector_key TEXT NOT NULL
    CHECK (
      length(detector_key) BETWEEN 3 AND 96
      AND detector_key NOT GLOB '*[^a-z0-9._-]*'
    ),
  incident_id TEXT NOT NULL REFERENCES app_operational_incidents(id) ON DELETE RESTRICT,
  incident_key TEXT NOT NULL CHECK (length(incident_key) BETWEEN 8 AND 160),
  observed_count INTEGER NOT NULL CHECK (observed_count > 0),
  evidence_digest TEXT NOT NULL
    CHECK (
      length(evidence_digest) = 64
      AND evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
  safe_summary_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (run_id, detector_key, incident_key)
);

CREATE INDEX idx_app_operational_detection_findings_run
  ON app_operational_detection_findings(run_id, detector_key, incident_id);

CREATE TABLE app_operational_safety_controls (
  control_key TEXT PRIMARY KEY
    CHECK (control_key IN (
      'person_publication',
      'recommendation_delivery',
      'operator_messaging',
      'membership_grants',
      'wallet_adjustments'
    )),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'paused')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  incident_id TEXT REFERENCES app_operational_incidents(id) ON DELETE RESTRICT,
  reason_code TEXT
    CHECK (
      reason_code IS NULL
      OR (
        length(reason_code) BETWEEN 3 AND 80
        AND reason_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  reason_summary TEXT
    CHECK (reason_summary IS NULL OR length(trim(reason_summary)) BETWEEN 3 AND 500),
  changed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  changed_at TEXT NOT NULL CHECK (julianday(changed_at) IS NOT NULL),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  CHECK (
    (state = 'available' AND incident_id IS NULL AND reason_code IS NULL AND reason_summary IS NULL)
    OR (state = 'paused' AND incident_id IS NOT NULL AND reason_code IS NOT NULL AND reason_summary IS NOT NULL)
  )
);

CREATE TABLE app_operational_safety_control_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opsce_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  control_key TEXT NOT NULL REFERENCES app_operational_safety_controls(control_key) ON DELETE RESTRICT,
  control_version INTEGER NOT NULL CHECK (control_version > 0),
  action TEXT NOT NULL CHECK (action IN ('paused', 'restored')),
  state_from TEXT NOT NULL CHECK (state_from IN ('available', 'paused')),
  state_to TEXT NOT NULL CHECK (state_to IN ('available', 'paused')),
  incident_id TEXT NOT NULL REFERENCES app_operational_incidents(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (
      length(reason_code) BETWEEN 3 AND 80
      AND reason_code NOT GLOB '*[^a-z0-9_]*'
    ),
  reason_summary TEXT NOT NULL CHECK (length(trim(reason_summary)) BETWEEN 3 AND 500),
  evidence_reference TEXT
    CHECK (evidence_reference IS NULL OR length(evidence_reference) BETWEEN 3 AND 192),
  actor_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (control_key, control_version),
  CHECK (
    (action = 'paused' AND state_from = 'available' AND state_to = 'paused')
    OR (action = 'restored' AND state_from = 'paused' AND state_to = 'available' AND evidence_reference IS NOT NULL)
  )
);

CREATE INDEX idx_app_operational_safety_control_events_incident
  ON app_operational_safety_control_events(incident_id, created_at DESC, id DESC);

CREATE TABLE app_operational_admin_commands (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'opcmd_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL
    CHECK (operation IN (
      'refresh_overview', 'run_detection', 'claim_incident', 'add_incident_note',
      'change_incident_status', 'link_runbook', 'change_safety_control'
    )),
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  result_type TEXT NOT NULL CHECK (result_type IN ('metric_run', 'detection_run', 'incident', 'safety_control')),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 3 AND 160),
  result_version INTEGER CHECK (result_version IS NULL OR result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (admin_id, operation, idempotency_key)
);

-- 系统指标口径只登记稳定定义；保留决策和 production-ready 继续保持未决。
INSERT INTO app_operational_metric_definitions (
  id, metric_key, schema_version, topic, display_name, description, unit,
  source_type, source_reference, owner_reference, freshness_slo_seconds,
  sensitivity, retention_decision_status, production_ready, created_origin, created_at
) VALUES
  ('opmd_supply_public_profiles_v1', 'supply.public_profiles', 1, 'supply', '可公开人物', '当前仍满足认证、发布、用途授权、有效期与来源图库门禁的人物数量。', 'count', 'd1_live_query', 'profile_public_projections', 'product.person-supply', 900, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_supply_pending_publications_v1', 'supply.pending_publications', 1, 'supply', '待发布复核', '处于 pending_review 的人物发布工作项数量。', 'count', 'd1_live_query', 'person_profiles.publication_status', 'operations.person-review', 900, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_discovery_active_rules_v1', 'discovery.active_rules', 1, 'discovery', '生效推荐规则', '当前处于 active 且仍在有效时间范围内的推荐规则数量。', 'count', 'd1_live_query', 'app_recommendation_rule_versions', 'product.discovery', 900, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_discovery_active_editorial_v1', 'discovery.active_editorial', 1, 'discovery', '生效平台精选', '当前处于 active 且排期有效的平台精选数量。', 'count', 'd1_live_query', 'app_recommendation_editorial_placements', 'operations.discovery', 900, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_messaging_unassigned_v1', 'messaging.unassigned_conversations', 1, 'messaging', '待领取话题', '当前等待平台回复且没有有效运营租约的话题数量。', 'count', 'd1_live_query', 'app_conversations+app_conversation_assignment_state', 'operations.messaging', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_messaging_open_escalations_v1', 'messaging.open_safety_escalations', 1, 'messaging', '待处理安全升级', '尚未形成终态的运营内部安全升级案件数量。', 'count', 'd1_live_query', 'app_conversation_safety_escalations', 'safety.messaging', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_membership_active_grants_v1', 'membership.active_grants', 1, 'membership', '有效会员发放', '当前时间范围内有效且未撤销的 App 会员 grant 数量。', 'count', 'd1_live_query', 'app_membership_grants+app_membership_grant_revocations', 'operations.membership', 900, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_membership_pending_reviews_v1', 'membership.pending_reviews', 1, 'membership', '待复核会员变更', '待复核或正在执行的会员发放、续期与撤销请求数量。', 'count', 'd1_live_query', 'app_membership_change_requests', 'operations.membership', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_wallet_pending_adjustments_v1', 'wallet.pending_adjustments', 1, 'wallet', '待复核金币调整', '待复核或正在执行的管理员金币调整数量。', 'count', 'd1_live_query', 'app_wallet_adjustments', 'finance.wallet', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_wallet_integrity_mismatches_v1', 'wallet.integrity_mismatches', 1, 'wallet', '钱包快照不一致', '钱包余额或 sequence 与不可变账本末条不一致的数量。', 'count', 'd1_live_query', 'app_wallets+app_wallet_entries', 'finance.wallet', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_notification_pending_v1', 'notification.pending_deliveries', 1, 'notification', '待投递站内通知', '处于 pending 或 processing 的站内通知 Outbox 数量。', 'count', 'd1_live_query', 'app_notification_outbox', 'operations.notification', 300, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_notification_dead_letter_v1', 'notification.dead_letters', 1, 'notification', '通知死信', '处于 dead_letter 的站内通知 Outbox 数量。', 'count', 'd1_live_query', 'app_notification_outbox', 'operations.notification', 300, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_safety_open_reports_v1', 'safety.open_reports', 1, 'safety', '待处理举报', '尚未形成用户可见终态的举报案件数量。', 'count', 'd1_live_query', 'app_safety_reports', 'safety.operations', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_safety_open_appeals_v1', 'safety.open_appeals', 1, 'safety', '待处理申诉', '尚未形成终态的独立申诉复核数量。', 'count', 'd1_live_query', 'app_safety_appeals', 'safety.appeals', 300, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_audit_integrity_findings_v1', 'audit.integrity_findings', 1, 'audit', '审计完整性发现', '最近一次审计完整性检查中的发现数量；尚未执行检查时必须显示未知。', 'count', 'd1_live_query', 'app_audit_integrity_checks', 'security.audit', 3600, 'restricted', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_platform_worker_error_rate_v1', 'platform.worker_error_rate', 1, 'platform', 'Worker 错误率', '由 Cloudflare 可观测数据提供的 Worker 请求错误率；数据源未接入时显示未配置。', 'ratio', 'cloudflare_observability', 'cloudflare.workers.observability', 'platform.sre', 300, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_platform_d1_latency_v1', 'platform.d1_latency_p95', 1, 'platform', 'D1 P95 延迟', '由 Cloudflare 可观测数据提供的 D1 查询 P95 延迟；数据源未接入时显示未配置。', 'milliseconds', 'cloudflare_observability', 'cloudflare.d1.observability', 'platform.sre', 300, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z'),
  ('opmd_platform_r2_error_rate_v1', 'platform.r2_error_rate', 1, 'platform', 'R2 错误率', '由 Cloudflare 可观测数据提供的 R2 访问错误率；数据源未接入时显示未配置。', 'ratio', 'cloudflare_observability', 'cloudflare.r2.observability', 'platform.sre', 300, 'internal', 'unresolved', 0, 'system', '2026-08-10T00:00:00.000Z');

INSERT INTO app_operational_runbook_versions (
  id, runbook_key, version, title, safe_summary, document_reference,
  domains_json, control_keys_json, minimum_severity, created_origin, created_at
) VALUES
  ('oprb_publication_safety_v1', 'publication_safety', 1, '人物发布异常处置', '核对公开投影、授权、认证和来源图库资格；必要时暂停人物发布并下线异常投影。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-publication-safety', '["supply"]', '["person_publication","recommendation_delivery"]', 'p1', 'system', '2026-08-10T00:00:00.000Z'),
  ('oprb_operator_identity_v1', 'operator_identity', 1, '运营身份异常处置', '核对平台运营回复事实、租约与披露版本；异常时暂停运营消息并保留最小证据。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-operator-identity', '["messaging"]', '["operator_messaging"]', 'p1', 'system', '2026-08-10T00:00:00.000Z'),
  ('oprb_membership_integrity_v1', 'membership_integrity', 1, '会员发放完整性处置', '核对 grant、独立复核、到期与撤销事实；异常时暂停会员发放并避免重复执行。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-membership-integrity', '["membership"]', '["membership_grants"]', 'p1', 'system', '2026-08-10T00:00:00.000Z'),
  ('oprb_wallet_reconciliation_v1', 'wallet_reconciliation', 1, '钱包账本对账处置', '冻结不一致钱包，核对不可变分录与快照；禁止余额直改或自动补账。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-wallet-reconciliation', '["wallet"]', '["wallet_adjustments"]', 'p1', 'system', '2026-08-10T00:00:00.000Z'),
  ('oprb_audit_integrity_v1', 'audit_integrity', 1, '审计完整性缺口处置', '固定检查范围和清单摘要，定位缺口但不自动补写源审计事实。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-audit-integrity', '["audit"]', '[]', 'p1', 'system', '2026-08-10T00:00:00.000Z'),
  ('oprb_notification_recovery_v1', 'notification_recovery', 1, '通知积压恢复', '核对 Outbox 租约、重试和 dead letter；恢复前重新验证通知资格与必要性。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-notification-recovery', '["notification"]', '[]', 'p2', 'system', '2026-08-10T00:00:00.000Z'),
  ('oprb_privacy_response_v1', 'privacy_response', 1, '数据权利与隐私事件处置', '按最小权限固定案件证据和法务责任人，不在运营总览展示个人级数据。', 'docs/app/OPERATIONS_1_OVERVIEW_AND_INCIDENTS_INTEGRATION.md#runbook-privacy-response', '["safety","platform"]', '[]', 'p1', 'system', '2026-08-10T00:00:00.000Z');

-- 这些初始行只表示“未因运营事故暂停”，不会绕过各业务自己的 capability 或 production-ready 门禁。
INSERT INTO app_operational_safety_controls (
  control_key, display_name, state, version, changed_at
) VALUES
  ('person_publication', '人物发布', 'available', 1, '2026-08-10T00:00:00.000Z'),
  ('recommendation_delivery', '推荐投放', 'available', 1, '2026-08-10T00:00:00.000Z'),
  ('operator_messaging', '运营消息发送', 'available', 1, '2026-08-10T00:00:00.000Z'),
  ('membership_grants', '会员发放', 'available', 1, '2026-08-10T00:00:00.000Z'),
  ('wallet_adjustments', '金币调整', 'available', 1, '2026-08-10T00:00:00.000Z');

CREATE TRIGGER app_operational_metric_definitions_no_update
BEFORE UPDATE ON app_operational_metric_definitions
BEGIN
  SELECT RAISE(ABORT, 'operational metric definitions are versioned and immutable');
END;

CREATE TRIGGER app_operational_metric_definitions_no_delete
BEFORE DELETE ON app_operational_metric_definitions
BEGIN
  SELECT RAISE(ABORT, 'operational metric definitions are immutable');
END;

CREATE TRIGGER app_operational_metric_runs_no_update
BEFORE UPDATE ON app_operational_metric_runs
BEGIN
  SELECT RAISE(ABORT, 'operational metric runs are immutable');
END;

CREATE TRIGGER app_operational_metric_runs_no_delete
BEFORE DELETE ON app_operational_metric_runs
BEGIN
  SELECT RAISE(ABORT, 'operational metric runs are immutable');
END;

CREATE TRIGGER app_operational_metric_snapshots_no_update
BEFORE UPDATE ON app_operational_metric_snapshots
BEGIN
  SELECT RAISE(ABORT, 'operational metric snapshots are immutable');
END;

CREATE TRIGGER app_operational_metric_snapshots_no_delete
BEFORE DELETE ON app_operational_metric_snapshots
BEGIN
  SELECT RAISE(ABORT, 'operational metric snapshots are immutable');
END;

CREATE TRIGGER app_operational_runbooks_no_update
BEFORE UPDATE ON app_operational_runbook_versions
BEGIN
  SELECT RAISE(ABORT, 'operational runbooks are versioned and immutable');
END;

CREATE TRIGGER app_operational_runbooks_no_delete
BEFORE DELETE ON app_operational_runbook_versions
BEGIN
  SELECT RAISE(ABORT, 'operational runbooks are immutable');
END;

CREATE TRIGGER app_operational_detection_runs_no_update
BEFORE UPDATE ON app_operational_detection_runs
BEGIN
  SELECT RAISE(ABORT, 'operational detection runs are immutable');
END;

CREATE TRIGGER app_operational_detection_runs_no_delete
BEFORE DELETE ON app_operational_detection_runs
BEGIN
  SELECT RAISE(ABORT, 'operational detection runs are immutable');
END;

CREATE TRIGGER app_operational_detection_findings_no_update
BEFORE UPDATE ON app_operational_detection_findings
BEGIN
  SELECT RAISE(ABORT, 'operational detection findings are immutable');
END;

CREATE TRIGGER app_operational_detection_findings_no_delete
BEFORE DELETE ON app_operational_detection_findings
BEGIN
  SELECT RAISE(ABORT, 'operational detection findings are immutable');
END;

CREATE TRIGGER app_operational_incidents_guard_update
BEFORE UPDATE ON app_operational_incidents
BEGIN
  SELECT CASE WHEN NEW.version <> OLD.version + 1
    THEN RAISE(ABORT, 'operational incident version must advance by one') END;
  SELECT CASE WHEN NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'open' AND NEW.status IN ('acknowledged', 'investigating', 'mitigated', 'resolved', 'false_positive'))
    OR (OLD.status = 'acknowledged' AND NEW.status IN ('investigating', 'mitigated', 'resolved', 'false_positive'))
    OR (OLD.status = 'investigating' AND NEW.status IN ('mitigated', 'resolved', 'false_positive'))
    OR (OLD.status = 'mitigated' AND NEW.status IN ('investigating', 'resolved', 'false_positive'))
    OR (OLD.status IN ('resolved', 'false_positive') AND NEW.status = 'open')
  ) THEN RAISE(ABORT, 'invalid operational incident transition') END;
  SELECT CASE WHEN
       NEW.id IS NOT OLD.id
    OR NEW.incident_key IS NOT OLD.incident_key
    OR NEW.incident_type IS NOT OLD.incident_type
    OR NEW.domain IS NOT OLD.domain
    OR NEW.first_seen_at IS NOT OLD.first_seen_at
    OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'operational incident identity is immutable') END;
END;

CREATE TRIGGER app_operational_incidents_no_delete
BEFORE DELETE ON app_operational_incidents
BEGIN
  SELECT RAISE(ABORT, 'operational incidents are immutable workflow facts');
END;

CREATE TRIGGER app_operational_incident_events_no_update
BEFORE UPDATE ON app_operational_incident_events
BEGIN
  SELECT RAISE(ABORT, 'operational incident events are immutable');
END;

CREATE TRIGGER app_operational_incident_events_no_delete
BEFORE DELETE ON app_operational_incident_events
BEGIN
  SELECT RAISE(ABORT, 'operational incident events are immutable');
END;

CREATE TRIGGER app_operational_safety_controls_guard_update
BEFORE UPDATE ON app_operational_safety_controls
BEGIN
  SELECT CASE WHEN NEW.version <> OLD.version + 1
    THEN RAISE(ABORT, 'operational safety control version must advance by one') END;
  SELECT CASE WHEN NEW.control_key IS NOT OLD.control_key OR NEW.display_name IS NOT OLD.display_name
    THEN RAISE(ABORT, 'operational safety control identity is immutable') END;
  SELECT CASE WHEN NOT (
    (OLD.state = 'available' AND NEW.state = 'paused')
    OR (OLD.state = 'paused' AND NEW.state = 'available')
  ) THEN RAISE(ABORT, 'operational safety control requires an explicit state transition') END;
END;

CREATE TRIGGER app_operational_safety_controls_no_delete
BEFORE DELETE ON app_operational_safety_controls
BEGIN
  SELECT RAISE(ABORT, 'operational safety controls cannot be deleted');
END;

CREATE TRIGGER app_operational_safety_control_events_no_update
BEFORE UPDATE ON app_operational_safety_control_events
BEGIN
  SELECT RAISE(ABORT, 'operational safety control events are immutable');
END;

CREATE TRIGGER app_operational_safety_control_events_no_delete
BEFORE DELETE ON app_operational_safety_control_events
BEGIN
  SELECT RAISE(ABORT, 'operational safety control events are immutable');
END;

CREATE TRIGGER app_operational_admin_commands_no_update
BEFORE UPDATE ON app_operational_admin_commands
BEGIN
  SELECT RAISE(ABORT, 'operational admin commands are immutable');
END;

CREATE TRIGGER app_operational_admin_commands_no_delete
BEFORE DELETE ON app_operational_admin_commands
BEGIN
  SELECT RAISE(ABORT, 'operational admin commands are immutable');
END;
