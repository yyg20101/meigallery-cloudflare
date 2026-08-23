-- Message-8：默认关闭的文本审核策略、人工复核队列与消息状态通知。
--
-- 本 migration 只创建治理结构和 development 策略：
-- - 不启用文本扫描，不写入任何审核规则，不回填历史消息；
-- - 不复制消息正文，审核事实只保存正文 SHA-256 与长度；
-- - 不开放召回 API，OQ-033 与正式 Figma 动作仍未关闭；
-- - 通知仍同时受 app_notification_policies.generation_enabled 与运行时开关约束。

CREATE TABLE app_message_moderation_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'mmp_*'
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
  decision_status TEXT NOT NULL CHECK (decision_status IN ('unresolved', 'approved')),
  evaluation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_enabled IN (0, 1)),
  default_action TEXT NOT NULL DEFAULT 'accept' CHECK (default_action = 'accept'),
  effective_at TEXT CHECK (effective_at IS NULL OR julianday(effective_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (
    production_ready = 0
    OR (
      state = 'published'
      AND decision_status = 'approved'
      AND evaluation_enabled = 1
      AND effective_at IS NOT NULL
    )
  ),
  CHECK (
    evaluation_enabled = 0
    OR (state IN ('development', 'published') AND effective_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_app_message_moderation_single_enabled
  ON app_message_moderation_policies (evaluation_enabled)
  WHERE evaluation_enabled = 1;

INSERT INTO app_message_moderation_policies (
  id, version_code, state, production_ready, decision_status,
  evaluation_enabled, default_action, effective_at, created_at
) VALUES (
  'mmp_message_8_dev_1',
  'message-8-dev-1',
  'development',
  0,
  'unresolved',
  0,
  'accept',
  NULL,
  '2026-08-20T00:00:00.000Z'
);

CREATE TABLE app_message_moderation_rules (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'mmr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  policy_id TEXT NOT NULL REFERENCES app_message_moderation_policies(id) ON DELETE RESTRICT,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('viewer', 'operator', 'both')),
  match_type TEXT NOT NULL CHECK (match_type IN ('contains', 'exact', 'url', 'email', 'phone')),
  normalized_pattern TEXT
    CHECK (normalized_pattern IS NULL OR length(normalized_pattern) BETWEEN 1 AND 240),
  action TEXT NOT NULL CHECK (action IN ('review', 'reject')),
  reason_code TEXT NOT NULL
    CHECK (
      reason_code GLOB '[a-z0-9]*'
      AND reason_code NOT GLOB '*[^a-z0-9_]*'
      AND length(reason_code) BETWEEN 2 AND 80
    ),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (id, policy_id),
  CHECK (
    (match_type IN ('contains', 'exact') AND normalized_pattern IS NOT NULL)
    OR match_type IN ('url', 'email', 'phone')
  )
);

CREATE UNIQUE INDEX idx_app_message_moderation_rule_identity
  ON app_message_moderation_rules (
    policy_id,
    actor_scope,
    match_type,
    COALESCE(normalized_pattern, '*'),
    action
  );

CREATE INDEX idx_app_message_moderation_rule_evaluation
  ON app_message_moderation_rules (policy_id, active, actor_scope, priority, id);

CREATE TRIGGER trg_app_message_moderation_rule_update_guard
BEFORE UPDATE ON app_message_moderation_rules
BEGIN
  SELECT RAISE(ABORT, 'message moderation rules are immutable');
END;

CREATE TRIGGER trg_app_message_moderation_rule_delete_guard
BEFORE DELETE ON app_message_moderation_rules
BEGIN
  SELECT RAISE(ABORT, 'message moderation rules are immutable');
END;

CREATE TABLE app_message_moderation_evaluations (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'mme_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  message_id TEXT NOT NULL UNIQUE REFERENCES app_conversation_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES app_message_moderation_policies(id) ON DELETE RESTRICT,
  rule_id TEXT,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('viewer', 'platform_operator')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'review_pending', 'rejected')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 2 AND 80),
  body_sha256 TEXT NOT NULL
    CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  body_length INTEGER NOT NULL CHECK (body_length BETWEEN 1 AND 1000),
  evaluated_at TEXT NOT NULL CHECK (julianday(evaluated_at) IS NOT NULL),
  FOREIGN KEY (rule_id, policy_id)
    REFERENCES app_message_moderation_rules(id, policy_id) ON DELETE RESTRICT
);

CREATE INDEX idx_app_message_moderation_evaluation_policy_time
  ON app_message_moderation_evaluations (policy_id, evaluated_at DESC, id DESC);

CREATE TABLE app_message_moderation_cases (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'mmc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  evaluation_id TEXT NOT NULL UNIQUE REFERENCES app_message_moderation_evaluations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES app_conversation_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES app_message_moderation_policies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_review', 'accepted', 'rejected', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 2 AND 80),
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_reason_code TEXT CHECK (
    decision_reason_code IS NULL OR length(decision_reason_code) BETWEEN 2 AND 80
  ),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  claimed_at TEXT CHECK (claimed_at IS NULL OR julianday(claimed_at) IS NOT NULL),
  decided_at TEXT CHECK (decided_at IS NULL OR julianday(decided_at) IS NOT NULL),
  CHECK (
    (status = 'pending'
      AND assigned_admin_id IS NULL
      AND reviewed_by IS NULL
      AND lease_expires_at IS NULL
      AND decision_reason_code IS NULL
      AND claimed_at IS NULL
      AND decided_at IS NULL)
    OR (status = 'in_review'
      AND assigned_admin_id IS NOT NULL
      AND reviewed_by IS NULL
      AND lease_expires_at IS NOT NULL
      AND decision_reason_code IS NULL
      AND claimed_at IS NOT NULL
      AND decided_at IS NULL)
    OR (status IN ('accepted', 'rejected')
      AND assigned_admin_id IS NOT NULL
      AND reviewed_by = assigned_admin_id
      AND lease_expires_at IS NULL
      AND decision_reason_code IS NOT NULL
      AND claimed_at IS NOT NULL
      AND decided_at IS NOT NULL)
    OR (status = 'cancelled'
      AND assigned_admin_id IS NULL
      AND reviewed_by IS NULL
      AND lease_expires_at IS NULL
      AND decision_reason_code IS NOT NULL
      AND decided_at IS NOT NULL)
  )
);

CREATE INDEX idx_app_message_moderation_case_queue
  ON app_message_moderation_cases (status, updated_at ASC, id ASC);

CREATE INDEX idx_app_message_moderation_case_assignment
  ON app_message_moderation_cases (assigned_admin_id, status, lease_expires_at);

CREATE TRIGGER trg_app_message_moderation_case_transition_guard
BEFORE UPDATE ON app_message_moderation_cases
WHEN
  NEW.evaluation_id <> OLD.evaluation_id
  OR NEW.message_id <> OLD.message_id
  OR NEW.conversation_id <> OLD.conversation_id
  OR NEW.policy_id <> OLD.policy_id
  OR NEW.reason_code <> OLD.reason_code
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
  OR NOT (
    (OLD.status = 'pending' AND NEW.status = 'in_review')
    OR (OLD.status = 'pending' AND NEW.status = 'cancelled')
    OR (OLD.status = 'in_review' AND NEW.status IN ('in_review', 'accepted', 'rejected', 'cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid message moderation case transition');
END;

CREATE TRIGGER trg_app_message_moderation_case_author_separation
BEFORE UPDATE OF assigned_admin_id, status ON app_message_moderation_cases
WHEN NEW.status IN ('in_review', 'accepted', 'rejected')
  AND EXISTS (
    SELECT 1
    FROM app_conversation_messages message
    WHERE message.id = NEW.message_id
      AND message.sender_type = 'platform_operator'
      AND message.actor_admin_id = NEW.assigned_admin_id
  )
BEGIN
  SELECT RAISE(ABORT, 'message author cannot review own moderation case');
END;

CREATE TRIGGER trg_app_message_moderation_message_transition_guard
BEFORE UPDATE OF status ON app_conversation_messages
WHEN OLD.status = 'review_pending'
  AND (
    NEW.status NOT IN ('accepted', 'rejected')
    OR NOT EXISTS (
      SELECT 1
      FROM app_message_moderation_cases review_case
      WHERE review_case.message_id = OLD.id
        AND review_case.status = NEW.status
        AND review_case.reviewed_by IS NOT NULL
        AND review_case.decided_at IS NOT NULL
    )
    OR (NEW.status = 'accepted' AND NEW.sequence <= OLD.sequence)
    OR (NEW.status = 'rejected' AND NEW.sequence <> OLD.sequence)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid moderated message transition');
END;

CREATE TABLE app_message_moderation_case_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'mmce_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  case_id TEXT NOT NULL REFERENCES app_message_moderation_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'claimed', 'accepted', 'rejected', 'cancelled')),
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_version INTEGER NOT NULL CHECK (from_version >= 0),
  to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 2 AND 80),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (case_id, to_version)
);

CREATE TRIGGER trg_app_message_moderation_case_event_update_guard
BEFORE UPDATE ON app_message_moderation_case_events
BEGIN
  SELECT RAISE(ABORT, 'message moderation case events are immutable');
END;

CREATE TRIGGER trg_app_message_moderation_case_event_delete_guard
BEFORE DELETE ON app_message_moderation_case_events
BEGIN
  SELECT RAISE(ABORT, 'message moderation case events are immutable');
END;

CREATE TABLE app_message_moderation_idempotency (
  actor_scope TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 8 AND 96),
  operation TEXT NOT NULL CHECK (operation IN ('case_claim', 'case_decision')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  case_id TEXT NOT NULL REFERENCES app_message_moderation_cases(id) ON DELETE CASCADE,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (actor_scope, operation, idempotency_key)
);

-- 以下事件定义只扩充既有 development 通知策略；generation_enabled 仍默认为 0。
INSERT INTO app_notification_event_definitions (
  id, policy_id, event_type, category, necessity, preference_key, source_domain,
  target_type, action, privacy_level, active, created_at
) VALUES
  ('nde_message_review_accepted', 'ntp_app_1_0_message_3_dev_1', 'message.review_accepted', 'message', 'optional', 'message', 'messaging', 'conversation', 'open_conversation', 'sensitive', 1, '2026-08-20T00:00:00.000Z'),
  ('nde_message_review_rejected', 'ntp_app_1_0_message_3_dev_1', 'message.review_rejected', 'message', 'optional', 'message', 'messaging', 'conversation', 'open_conversation', 'sensitive', 1, '2026-08-20T00:00:00.000Z'),
  ('nde_message_conversation_restricted', 'ntp_app_1_0_message_3_dev_1', 'message.conversation_restricted', 'system_security', 'required', NULL, 'messaging', 'conversation', 'open_conversation', 'sensitive', 1, '2026-08-20T00:00:00.000Z'),
  ('nde_message_conversation_closed', 'ntp_app_1_0_message_3_dev_1', 'message.conversation_closed', 'system_security', 'required', NULL, 'messaging', 'conversation', 'open_conversation', 'sensitive', 1, '2026-08-20T00:00:00.000Z');

INSERT INTO app_notification_template_versions (
  id, event_definition_id, version_code, state, title_text, summary_text, body_text, created_at
) VALUES
  ('ntv_message_review_accepted_v1', 'nde_message_review_accepted', 'message-review-accepted-v1', 'development', '消息审核已完成', '你提交的消息已通过审核，请进入话题查看。', '通知不会展示消息正文；打开平台话题后请以消息当前状态为准。', '2026-08-20T00:00:00.000Z'),
  ('ntv_message_review_rejected_v1', 'nde_message_review_rejected', 'message-review-rejected-v1', 'development', '消息未通过审核', '你提交的消息未通过审核，请进入话题查看状态。', '通知不会展示消息正文、匹配规则或内部审核备注；请以平台话题中的用户可见状态为准。', '2026-08-20T00:00:00.000Z'),
  ('ntv_message_conversation_restricted_v1', 'nde_message_conversation_restricted', 'message-conversation-restricted-v1', 'development', '平台话题已转为只读', '平台因安全处理限制了当前话题，请查看最新状态。', '历史消息仍可查看；通知不包含内部安全证据或审核备注，请以话题与安全中心的权威状态为准。', '2026-08-20T00:00:00.000Z'),
  ('ntv_message_conversation_closed_v1', 'nde_message_conversation_closed', 'message-conversation-closed-v1', 'development', '平台话题已关闭', '平台已结束当前话题，请查看最新状态。', '历史消息仍可查看；通知不包含内部安全证据或审核备注，请以话题与安全中心的权威状态为准。', '2026-08-20T00:00:00.000Z');

-- 运营消息从待审转为通过时，补发原本只在 INSERT accepted 时触发的平台回复事件。
CREATE TRIGGER app_notification_from_approved_platform_reply
AFTER UPDATE OF status ON app_conversation_messages
WHEN OLD.status = 'review_pending'
  AND NEW.status = 'accepted'
  AND NEW.sender_type = 'platform_operator'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_mpa_' || NEW.id,
    policy.id,
    definition.id,
    conversation.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.conversation_id,
    'pending',
    0,
    COALESCE((SELECT decided_at FROM app_message_moderation_cases WHERE message_id = NEW.id), NEW.created_at),
    COALESCE((SELECT decided_at FROM app_message_moderation_cases WHERE message_id = NEW.id), NEW.created_at)
  FROM app_conversations conversation
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'message.platform_reply'
   AND definition.active = 1
  WHERE conversation.id = NEW.conversation_id;
END;

CREATE TRIGGER app_notification_from_immediate_message_rejection
AFTER INSERT ON app_conversation_messages
WHEN NEW.sender_type = 'viewer' AND NEW.status = 'rejected'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_mrj_' || NEW.id,
    policy.id,
    definition.id,
    conversation.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.conversation_id,
    'pending',
    0,
    NEW.created_at,
    NEW.created_at
  FROM app_conversations conversation
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = 'message.review_rejected'
   AND definition.active = 1
  WHERE conversation.id = NEW.conversation_id;
END;

CREATE TRIGGER app_notification_from_message_review_result
AFTER UPDATE OF status ON app_conversation_messages
WHEN OLD.status = 'review_pending'
  AND NEW.status IN ('accepted', 'rejected')
  AND NEW.sender_type = 'viewer'
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    'nto_mrv_' || NEW.id,
    policy.id,
    definition.id,
    conversation.account_id,
    definition.event_type,
    NEW.id,
    definition.target_type,
    NEW.conversation_id,
    'pending',
    0,
    COALESCE(review_case.decided_at, NEW.created_at),
    COALESCE(review_case.decided_at, NEW.created_at)
  FROM app_conversations conversation
  JOIN app_notification_policies policy ON policy.generation_enabled = 1
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = CASE NEW.status
     WHEN 'accepted' THEN 'message.review_accepted'
     ELSE 'message.review_rejected'
   END
   AND definition.active = 1
  LEFT JOIN app_message_moderation_cases review_case ON review_case.message_id = NEW.id
  WHERE conversation.id = NEW.conversation_id;
END;

CREATE TRIGGER app_notification_from_admin_conversation_restriction
AFTER UPDATE OF status ON app_conversations
WHEN OLD.status <> NEW.status
  AND NEW.status IN ('restricted', 'closed')
  AND (
    (NEW.status = 'restricted' AND NEW.restriction_source = 'admin_safety')
    OR (NEW.status = 'closed' AND NEW.closed_by_type = 'admin')
  )
BEGIN
  INSERT OR IGNORE INTO app_notification_outbox (
    id, policy_id, event_definition_id, account_id, event_type, event_ref,
    target_type, target_id, status, attempts, next_attempt_at, created_at
  )
  SELECT
    CASE NEW.status
      WHEN 'restricted' THEN 'nto_mcr_'
      ELSE 'nto_mcc_'
    END || NEW.id,
    policy.id,
    definition.id,
    NEW.account_id,
    definition.event_type,
    NEW.id || '.' || NEW.status,
    definition.target_type,
    NEW.id,
    'pending',
    0,
    NEW.updated_at,
    NEW.updated_at
  FROM app_notification_policies policy
  JOIN app_notification_event_definitions definition
    ON definition.policy_id = policy.id
   AND definition.event_type = CASE NEW.status
     WHEN 'restricted' THEN 'message.conversation_restricted'
     ELSE 'message.conversation_closed'
   END
   AND definition.active = 1
  WHERE policy.generation_enabled = 1;
END;
