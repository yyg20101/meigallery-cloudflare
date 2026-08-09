-- ADM-MSG-02 / ADM-SAF-01：平台运营发起的内部安全升级案件。
--
-- 本 migration 只创建内部案件、最小证据引用、时间线和幂等事实：
-- - 不把运营升级伪装成观看者举报；
-- - 不向观看者暴露内部说明、操作员身份或审核结论；
-- - 不开启消息或安全运行时开关，不创建业务 seed；
-- - 不实现自动处置、外部告警、媒体证据上传或质量抽检。

CREATE TABLE app_conversation_safety_escalations (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cse_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (reason_code IN (
      'suspected_impersonation',
      'harassment_threat',
      'fraud_inducement',
      'privacy_exposure',
      'minor_safety',
      'imminent_danger',
      'other'
    )),
  priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) BETWEEN 1 AND 1000),
  summary_sha256 TEXT NOT NULL
    CHECK (
      length(summary_sha256) = 64
      AND summary_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  summary_length INTEGER NOT NULL CHECK (summary_length BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'investigating', 'actioned', 'no_action')),
  raised_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT
    CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  action_type TEXT
    CHECK (action_type IS NULL OR action_type IN ('none', 'conversation_restricted', 'conversation_closed')),
  decision_reason_code TEXT
    CHECK (
      decision_reason_code IS NULL
      OR (
        decision_reason_code NOT GLOB '*[^a-z0-9_]*'
        AND length(decision_reason_code) BETWEEN 3 AND 80
      )
    ),
  decision_summary_text TEXT
    CHECK (decision_summary_text IS NULL OR length(trim(decision_summary_text)) BETWEEN 1 AND 1000),
  decision_summary_sha256 TEXT
    CHECK (
      decision_summary_sha256 IS NULL
      OR (
        length(decision_summary_sha256) = 64
        AND decision_summary_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  decision_summary_length INTEGER
    CHECK (decision_summary_length IS NULL OR decision_summary_length BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  CHECK (assigned_admin_id IS NULL OR assigned_admin_id <> raised_by_admin_id),
  CHECK (
    (status = 'submitted' AND assigned_admin_id IS NULL AND resolved_at IS NULL)
    OR (status = 'investigating' AND assigned_admin_id IS NOT NULL AND resolved_at IS NULL)
    OR (
      status IN ('actioned', 'no_action')
      AND assigned_admin_id IS NOT NULL
      AND resolved_at IS NOT NULL
      AND action_type IS NOT NULL
      AND decision_reason_code IS NOT NULL
      AND decision_summary_text IS NOT NULL
      AND decision_summary_sha256 IS NOT NULL
      AND decision_summary_length IS NOT NULL
    )
  ),
  CHECK (
    (status = 'actioned' AND action_type IN ('conversation_restricted', 'conversation_closed'))
    OR (status = 'no_action' AND action_type = 'none')
    OR status IN ('submitted', 'investigating')
  )
);

CREATE INDEX idx_app_conversation_safety_escalations_queue
  ON app_conversation_safety_escalations (status, priority, created_at ASC, id ASC);

CREATE INDEX idx_app_conversation_safety_escalations_assignee
  ON app_conversation_safety_escalations (assigned_admin_id, status, updated_at ASC)
  WHERE assigned_admin_id IS NOT NULL;

CREATE INDEX idx_app_conversation_safety_escalations_conversation
  ON app_conversation_safety_escalations (conversation_id, created_at DESC, id DESC);

CREATE TABLE app_conversation_safety_escalation_evidence (
  escalation_id TEXT PRIMARY KEY
    REFERENCES app_conversation_safety_escalations(id) ON DELETE CASCADE,
  target_message_id TEXT
    CHECK (
      target_message_id IS NULL
      OR (
        target_message_id GLOB 'msg_*'
        AND target_message_id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(target_message_id) BETWEEN 6 AND 80
      )
    ),
  target_message_sequence INTEGER CHECK (target_message_sequence IS NULL OR target_message_sequence > 0),
  target_message_body_sha256 TEXT
    CHECK (
      target_message_body_sha256 IS NULL
      OR (
        length(target_message_body_sha256) = 64
        AND target_message_body_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  context_before_message_id TEXT
    CHECK (
      context_before_message_id IS NULL
      OR (
        context_before_message_id GLOB 'msg_*'
        AND context_before_message_id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(context_before_message_id) BETWEEN 6 AND 80
      )
    ),
  context_after_message_id TEXT
    CHECK (
      context_after_message_id IS NULL
      OR (
        context_after_message_id GLOB 'msg_*'
        AND context_after_message_id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND length(context_after_message_id) BETWEEN 6 AND 80
      )
    ),
  conversation_last_sequence INTEGER NOT NULL CHECK (conversation_last_sequence > 0),
  evidence_digest TEXT NOT NULL
    CHECK (
      length(evidence_digest) = 64
      AND evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
  captured_at TEXT NOT NULL CHECK (julianday(captured_at) IS NOT NULL),
  CHECK (
    (
      target_message_id IS NULL
      AND target_message_sequence IS NULL
      AND target_message_body_sha256 IS NULL
      AND context_before_message_id IS NULL
      AND context_after_message_id IS NULL
    )
    OR (
      target_message_id IS NOT NULL
      AND target_message_sequence IS NOT NULL
      AND target_message_body_sha256 IS NOT NULL
    )
  )
);

CREATE TABLE app_conversation_safety_escalation_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'csee_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  escalation_id TEXT NOT NULL
    REFERENCES app_conversation_safety_escalations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted', 'claimed', 'actioned', 'no_action')),
  status_from TEXT CHECK (status_from IS NULL OR status_from IN ('submitted', 'investigating')),
  status_to TEXT NOT NULL CHECK (status_to IN ('submitted', 'investigating', 'actioned', 'no_action')),
  reason_code TEXT NOT NULL
    CHECK (
      reason_code NOT GLOB '*[^a-z0-9_]*'
      AND length(reason_code) BETWEEN 3 AND 80
    ),
  actor_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (escalation_id, sequence)
);

CREATE TABLE app_conversation_safety_escalation_idempotency (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'claim', 'decision')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  escalation_id TEXT NOT NULL
    REFERENCES app_conversation_safety_escalations(id) ON DELETE CASCADE,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (admin_id, operation, idempotency_key)
);

CREATE INDEX idx_app_conversation_safety_escalation_idempotency_result
  ON app_conversation_safety_escalation_idempotency (escalation_id, operation, created_at DESC);
