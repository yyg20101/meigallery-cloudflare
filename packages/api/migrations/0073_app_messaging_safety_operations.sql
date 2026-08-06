-- Message-2：默认关闭的平台话题安全与运营闭环。
--
-- 本 migration 只创建开发目录、举报/拉黑、运营分配、紧急控制和保留策略门禁：
-- - 不启用任何运行时开关；
-- - 不创建账号、会员 grant、会话、举报或拉黑业务 seed；
-- - 不执行消息/举报自动清理，保留天数仍需 OQ-020 正式决策；
-- - 不创建自动永久封禁、系统推送、实时通道或用户媒体证据能力。

INSERT INTO app_membership_catalog_versions (
  id,
  version_code,
  state,
  production_ready,
  effective_at,
  timezone,
  minimum_client_version
) VALUES (
  'amc_app_1_0_message_2_dev_1',
  'app-1.0-message-2-dev-1',
  'development',
  0,
  '2026-08-07T00:00:00.000Z',
  'Asia/Shanghai',
  '1.0'
);

INSERT INTO app_entitlement_definitions (
  catalog_version_id,
  entitlement_key,
  schema_version,
  value_type,
  default_value_json,
  merge_strategy,
  period_rule,
  client_capability,
  display_name,
  description,
  unit_label,
  created_at
)
SELECT
  'amc_app_1_0_message_2_dev_1',
  entitlement_key,
  schema_version,
  value_type,
  default_value_json,
  merge_strategy,
  period_rule,
  client_capability,
  display_name,
  description,
  unit_label,
  created_at
FROM app_entitlement_definitions
WHERE catalog_version_id = 'amc_app_1_0_message_1_dev_1';

INSERT INTO app_membership_tiers (
  catalog_version_id,
  tier_id,
  code,
  display_name,
  tagline,
  rank,
  accent_token,
  acquisition_label,
  service_disclosure,
  sort_order
)
SELECT
  'amc_app_1_0_message_2_dev_1',
  tier_id,
  code,
  display_name,
  tagline,
  rank,
  accent_token,
  acquisition_label,
  service_disclosure,
  sort_order
FROM app_membership_tiers
WHERE catalog_version_id = 'amc_app_1_0_message_1_dev_1';

INSERT INTO app_membership_tier_entitlements (
  catalog_version_id,
  tier_id,
  entitlement_key,
  value_json,
  availability
)
SELECT
  'amc_app_1_0_message_2_dev_1',
  tier_id,
  entitlement_key,
  value_json,
  availability
FROM app_membership_tier_entitlements
WHERE catalog_version_id = 'amc_app_1_0_message_1_dev_1';

CREATE TABLE app_safety_retention_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'srp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      version_code NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(version_code) BETWEEN 1 AND 80
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  decision_status TEXT NOT NULL CHECK (decision_status IN ('unresolved', 'approved')),
  message_retention_days INTEGER CHECK (message_retention_days IS NULL OR message_retention_days BETWEEN 1 AND 3650),
  report_retention_days INTEGER CHECK (report_retention_days IS NULL OR report_retention_days BETWEEN 1 AND 3650),
  evidence_retention_days INTEGER CHECK (evidence_retention_days IS NULL OR evidence_retention_days BETWEEN 1 AND 3650),
  purge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purge_enabled IN (0, 1)),
  effective_at TEXT CHECK (effective_at IS NULL OR julianday(effective_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (
    decision_status = 'unresolved'
    OR (
      message_retention_days IS NOT NULL
      AND report_retention_days IS NOT NULL
      AND evidence_retention_days IS NOT NULL
    )
  ),
  CHECK (
    production_ready = 0
    OR (state = 'published' AND decision_status = 'approved')
  )
);

INSERT INTO app_safety_retention_policies (
  id,
  version_code,
  state,
  production_ready,
  decision_status,
  message_retention_days,
  report_retention_days,
  evidence_retention_days,
  purge_enabled,
  effective_at,
  created_at
) VALUES (
  'srp_message_2_unresolved_dev_1',
  'message-2-unresolved-dev-1',
  'development',
  0,
  'unresolved',
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  '2026-08-07T00:00:00.000Z'
);

CREATE TABLE app_safety_reason_catalogs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'src_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      version_code NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(version_code) BETWEEN 1 AND 80
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  max_description_length INTEGER NOT NULL CHECK (max_description_length BETWEEN 0 AND 1000),
  retention_policy_id TEXT NOT NULL REFERENCES app_safety_retention_policies(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (production_ready = 0 OR state = 'published')
);

INSERT INTO app_safety_reason_catalogs (
  id,
  version_code,
  state,
  production_ready,
  max_description_length,
  retention_policy_id,
  created_at
) VALUES (
  'src_app_1_0_message_2_dev_1',
  'app-1.0-message-2-dev-1',
  'development',
  0,
  500,
  'srp_message_2_unresolved_dev_1',
  '2026-08-07T00:00:00.000Z'
);

CREATE TABLE app_safety_reason_definitions (
  catalog_id TEXT NOT NULL REFERENCES app_safety_reason_catalogs(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (
      reason_code NOT GLOB '*[^a-z0-9_]*'
      AND length(reason_code) BETWEEN 3 AND 64
    ),
  display_label TEXT NOT NULL CHECK (length(trim(display_label)) BETWEEN 1 AND 80),
  default_priority TEXT NOT NULL CHECK (default_priority IN ('p0', 'p1', 'p2', 'p3')),
  user_visible INTEGER NOT NULL DEFAULT 1 CHECK (user_visible IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  PRIMARY KEY (catalog_id, reason_code)
);

INSERT INTO app_safety_reason_definitions (
  catalog_id,
  reason_code,
  display_label,
  default_priority,
  user_visible,
  sort_order
) VALUES
  ('src_app_1_0_message_2_dev_1', 'authorization_impersonation', '授权或冒名问题', 'p1', 1, 10),
  ('src_app_1_0_message_2_dev_1', 'prohibited_content', '违规或不适内容', 'p2', 1, 20),
  ('src_app_1_0_message_2_dev_1', 'privacy_exposure', '隐私泄露', 'p1', 1, 30),
  ('src_app_1_0_message_2_dev_1', 'harassment', '骚扰或不当沟通', 'p2', 1, 40),
  ('src_app_1_0_message_2_dev_1', 'fraud_inducement', '诈骗或诱导', 'p1', 1, 50),
  ('src_app_1_0_message_2_dev_1', 'minor_coercion', '疑似未成年人或胁迫', 'p0', 1, 60),
  ('src_app_1_0_message_2_dev_1', 'imminent_danger', '现实人身安全风险', 'p0', 1, 70),
  ('src_app_1_0_message_2_dev_1', 'other', '其他问题', 'p3', 1, 80);

CREATE TABLE app_profile_blocks (
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('blocked', 'unblocked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT NOT NULL CHECK (length(mutation_token) BETWEEN 16 AND 80),
  blocked_at TEXT NOT NULL CHECK (julianday(blocked_at) IS NOT NULL),
  unblocked_at TEXT CHECK (unblocked_at IS NULL OR julianday(unblocked_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (account_id, profile_id),
  CHECK (
    (state = 'blocked' AND unblocked_at IS NULL)
    OR (state = 'unblocked' AND unblocked_at IS NOT NULL)
  )
);

CREATE INDEX idx_app_profile_blocks_account_state
  ON app_profile_blocks (account_id, state, updated_at DESC, profile_id ASC);

CREATE TABLE app_profile_block_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ble_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('blocked', 'unblocked')),
  occurred_at TEXT NOT NULL CHECK (julianday(occurred_at) IS NOT NULL),
  UNIQUE (account_id, profile_id, version)
);

CREATE TABLE app_safety_reports (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'rpt_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('person_profile', 'media', 'conversation', 'message')),
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  media_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
  conversation_id TEXT REFERENCES app_conversations(id) ON DELETE RESTRICT,
  message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  reason_catalog_id TEXT NOT NULL REFERENCES app_safety_reason_catalogs(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL,
  description_text TEXT NOT NULL DEFAULT '' CHECK (length(description_text) <= 500),
  description_sha256 TEXT NOT NULL
    CHECK (
      length(description_sha256) = 64
      AND description_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'triaged', 'investigating', 'actioned', 'no_violation', 'closed')),
  user_visible_status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (user_visible_status IN ('submitted', 'processing', 'actioned', 'no_violation', 'closed')),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT
    CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  retention_policy_id TEXT NOT NULL REFERENCES app_safety_retention_policies(id) ON DELETE RESTRICT,
  submitted_at TEXT NOT NULL CHECK (julianday(submitted_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  FOREIGN KEY (reason_catalog_id, reason_code)
    REFERENCES app_safety_reason_definitions(catalog_id, reason_code),
  CHECK (
    (target_type = 'person_profile' AND media_id IS NULL AND conversation_id IS NULL AND message_id IS NULL)
    OR (target_type = 'media' AND media_id IS NOT NULL AND conversation_id IS NULL AND message_id IS NULL)
    OR (target_type = 'conversation' AND media_id IS NULL AND conversation_id IS NOT NULL AND message_id IS NULL)
    OR (target_type = 'message' AND media_id IS NULL AND conversation_id IS NOT NULL AND message_id IS NOT NULL)
  )
);

CREATE INDEX idx_app_safety_reports_account_time
  ON app_safety_reports (account_id, submitted_at DESC, id ASC);

CREATE INDEX idx_app_safety_reports_queue
  ON app_safety_reports (status, priority ASC, submitted_at ASC, id ASC);

CREATE INDEX idx_app_safety_reports_assignment
  ON app_safety_reports (assigned_admin_id, status, updated_at ASC)
  WHERE assigned_admin_id IS NOT NULL;

CREATE TABLE app_safety_report_evidence (
  report_id TEXT PRIMARY KEY REFERENCES app_safety_reports(id) ON DELETE CASCADE,
  profile_content_version INTEGER CHECK (profile_content_version IS NULL OR profile_content_version > 0),
  profile_projection_version INTEGER CHECK (profile_projection_version IS NULL OR profile_projection_version > 0),
  media_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT,
  conversation_id TEXT REFERENCES app_conversations(id) ON DELETE RESTRICT,
  message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  message_sequence INTEGER CHECK (message_sequence IS NULL OR message_sequence > 0),
  message_sender_type TEXT CHECK (message_sender_type IS NULL OR message_sender_type IN ('viewer', 'platform_operator', 'system')),
  message_body_sha256 TEXT
    CHECK (
      message_body_sha256 IS NULL
      OR (
        length(message_body_sha256) = 64
        AND message_body_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  context_before_message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  context_after_message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  evidence_digest TEXT NOT NULL
    CHECK (
      length(evidence_digest) = 64
      AND evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
  captured_at TEXT NOT NULL CHECK (julianday(captured_at) IS NOT NULL)
);

CREATE TABLE app_safety_report_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'rpe_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  report_id TEXT NOT NULL REFERENCES app_safety_reports(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('viewer', 'admin', 'system')),
  actor_account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('submitted', 'claimed', 'released', 'triaged', 'investigating', 'actioned', 'no_violation', 'closed')),
  status_from TEXT,
  status_to TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  user_visible_status TEXT NOT NULL,
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (report_id, sequence),
  CHECK (
    (actor_type = 'viewer' AND actor_account_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_account_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_account_id IS NULL AND actor_admin_id IS NULL)
  )
);

CREATE TABLE app_safety_idempotency (
  actor_scope TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 3 AND 96),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'report_create',
      'profile_block',
      'profile_unblock',
      'conversation_viewer_close',
      'report_claim',
      'report_release',
      'report_decision',
      'assignment_claim',
      'assignment_release',
      'conversation_admin_close',
      'runtime_control_update'
    )
  ),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  result_type TEXT NOT NULL CHECK (result_type IN ('report', 'profile_block', 'conversation', 'assignment', 'runtime_control')),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 1 AND 96),
  result_version INTEGER NOT NULL CHECK (result_version >= 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (actor_scope, operation, idempotency_key)
);

CREATE TABLE app_conversation_assignment_state (
  conversation_id TEXT PRIMARY KEY REFERENCES app_conversations(id) ON DELETE CASCADE,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('unassigned', 'active', 'released')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  mutation_token TEXT
    CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  assigned_at TEXT CHECK (assigned_at IS NULL OR julianday(assigned_at) IS NOT NULL),
  released_at TEXT CHECK (released_at IS NULL OR julianday(released_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (
    (status = 'active' AND assigned_admin_id IS NOT NULL AND lease_expires_at IS NOT NULL AND assigned_at IS NOT NULL AND released_at IS NULL)
    OR (status IN ('unassigned', 'released') AND assigned_admin_id IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_app_conversation_assignment_admin
  ON app_conversation_assignment_state (assigned_admin_id, lease_expires_at ASC)
  WHERE status = 'active' AND assigned_admin_id IS NOT NULL;

CREATE TABLE app_conversation_assignment_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cae_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('claimed', 'renewed', 'released', 'expired')),
  subject_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'admin' CHECK (actor_type IN ('admin', 'system')),
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (conversation_id, version),
  CHECK (
    (actor_type = 'admin' AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_admin_id IS NULL)
  )
);

CREATE TABLE app_messaging_runtime_controls (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  new_conversations_paused INTEGER NOT NULL DEFAULT 0 CHECK (new_conversations_paused IN (0, 1)),
  viewer_sends_paused INTEGER NOT NULL DEFAULT 0 CHECK (viewer_sends_paused IN (0, 1)),
  operator_sends_paused INTEGER NOT NULL DEFAULT 0 CHECK (operator_sends_paused IN (0, 1)),
  emergency_reason_code TEXT CHECK (emergency_reason_code IS NULL OR length(emergency_reason_code) BETWEEN 1 AND 80),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  max_open_conversations INTEGER NOT NULL CHECK (max_open_conversations BETWEEN 1 AND 100000),
  max_active_assignments_per_operator INTEGER NOT NULL CHECK (max_active_assignments_per_operator BETWEEN 1 AND 1000),
  assignment_lease_minutes INTEGER NOT NULL CHECK (assignment_lease_minutes BETWEEN 5 AND 1440),
  retention_policy_id TEXT NOT NULL REFERENCES app_safety_retention_policies(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT
    CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

INSERT INTO app_messaging_runtime_controls (
  scope,
  new_conversations_paused,
  viewer_sends_paused,
  operator_sends_paused,
  emergency_reason_code,
  user_visible_message,
  max_open_conversations,
  max_active_assignments_per_operator,
  assignment_lease_minutes,
  retention_policy_id,
  version,
  updated_by,
  updated_at
) VALUES (
  'global',
  0,
  0,
  0,
  NULL,
  '平台话题服务正常；如遇安全或容量事件，平台可能临时停止新话题或发送。',
  100,
  10,
  30,
  'srp_message_2_unresolved_dev_1',
  1,
  NULL,
  '2026-08-07T00:00:00.000Z'
);

ALTER TABLE app_conversations ADD COLUMN restriction_reason_code TEXT
  CHECK (restriction_reason_code IS NULL OR length(restriction_reason_code) BETWEEN 1 AND 80);

ALTER TABLE app_conversations ADD COLUMN restriction_source TEXT
  CHECK (restriction_source IS NULL OR restriction_source IN ('viewer_block', 'admin_safety', 'runtime_control'));

ALTER TABLE app_conversations ADD COLUMN closed_reason_code TEXT
  CHECK (closed_reason_code IS NULL OR length(closed_reason_code) BETWEEN 1 AND 80);

ALTER TABLE app_conversations ADD COLUMN closed_by_type TEXT
  CHECK (closed_by_type IS NULL OR closed_by_type IN ('viewer', 'admin', 'system'));
