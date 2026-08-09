-- ADM-MSG-04：平台话题质量抽检、改进任务与安全转介。
--
-- 本 migration 只创建空表，不创建抽检样本、评分、任务或业务配置：
-- - 回复正文只继续保存在 app_conversation_messages；
-- - 队列、审计和通用分析不得复制消息正文；
-- - 质检员必须领取样本并提交稳定访问理由后，才能读取固定的最小证据窗口；
-- - 抽检人与实际回复操作员强制隔离；
-- - 不启用任何运行时开关，不执行历史回复回填或自动抽样。

CREATE TABLE app_conversation_operator_message_facts (
  message_id TEXT PRIMARY KEY
    REFERENCES app_conversation_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL
    REFERENCES app_conversations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL
    REFERENCES person_profiles(id) ON DELETE RESTRICT,
  group_id TEXT
    REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  disclosure_version TEXT NOT NULL CHECK (length(disclosure_version) BETWEEN 1 AND 80),
  actual_operator_admin_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  approved_script_version_id TEXT
    CHECK (
      approved_script_version_id IS NULL
      OR (
        length(approved_script_version_id) BETWEEN 5 AND 80
        AND approved_script_version_id NOT GLOB '*[^A-Za-z0-9._-]*'
      )
    ),
  message_body_sha256 TEXT NOT NULL
    CHECK (
      length(message_body_sha256) = 64
      AND message_body_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (conversation_id, message_id)
);

CREATE INDEX idx_app_conversation_operator_message_facts_sampling
  ON app_conversation_operator_message_facts (group_id, created_at ASC, message_id ASC);

CREATE INDEX idx_app_conversation_operator_message_facts_operator
  ON app_conversation_operator_message_facts (actual_operator_admin_id, created_at DESC, message_id DESC);

CREATE TABLE app_conversation_quality_selection_runs (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cqsr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  group_id TEXT
    REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('group', 'unscoped')),
  window_start TEXT NOT NULL CHECK (julianday(window_start) IS NOT NULL),
  window_end TEXT NOT NULL CHECK (julianday(window_end) IS NOT NULL),
  requested_sample_size INTEGER NOT NULL CHECK (requested_sample_size BETWEEN 1 AND 50),
  eligible_count INTEGER NOT NULL CHECK (eligible_count >= 0),
  selected_count INTEGER NOT NULL CHECK (selected_count BETWEEN 0 AND requested_sample_size),
  selection_strategy TEXT NOT NULL CHECK (selection_strategy = 'operator_round_robin_oldest'),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('routine_quality_review', 'disclosure_focus', 'coaching_follow_up', 'policy_follow_up')
  ),
  selected_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (datetime(window_start) < datetime(window_end)),
  CHECK (
    (scope_type = 'group' AND group_id IS NOT NULL)
    OR (scope_type = 'unscoped' AND group_id IS NULL)
  )
);

CREATE INDEX idx_app_conversation_quality_selection_runs_scope
  ON app_conversation_quality_selection_runs (group_id, created_at DESC, id DESC);

CREATE TABLE app_conversation_quality_samples (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cqs_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  selection_run_id TEXT NOT NULL
    REFERENCES app_conversation_quality_selection_runs(id) ON DELETE RESTRICT,
  conversation_id TEXT NOT NULL
    REFERENCES app_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL
    REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL
    REFERENCES person_profiles(id) ON DELETE RESTRICT,
  group_id TEXT
    REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  actual_operator_admin_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  disclosure_version TEXT NOT NULL CHECK (length(disclosure_version) BETWEEN 1 AND 80),
  approved_script_version_id TEXT
    CHECK (
      approved_script_version_id IS NULL
      OR (
        length(approved_script_version_id) BETWEEN 5 AND 80
        AND approved_script_version_id NOT GLOB '*[^A-Za-z0-9._-]*'
      )
    ),
  disclosure_integrity_status TEXT NOT NULL
    CHECK (disclosure_integrity_status IN ('verified', 'missing', 'mismatch', 'unverifiable')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_review', 'completed', 'voided')),
  assigned_reviewer_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_lease_expires_at TEXT
    CHECK (reviewer_lease_expires_at IS NULL OR julianday(reviewer_lease_expires_at) IS NOT NULL),
  review_reason_code TEXT
    CHECK (
      review_reason_code IS NULL
      OR review_reason_code IN ('routine_quality_review', 'disclosure_investigation', 'coaching_follow_up')
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  identity_disclosure_rating TEXT
    CHECK (identity_disclosure_rating IS NULL OR identity_disclosure_rating IN ('pass', 'fail')),
  service_quality_rating TEXT
    CHECK (service_quality_rating IS NULL OR service_quality_rating IN ('pass', 'needs_improvement', 'fail')),
  policy_language_rating TEXT
    CHECK (policy_language_rating IS NULL OR policy_language_rating IN ('pass', 'needs_improvement', 'fail')),
  overall_score INTEGER CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100),
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN ('pass', 'coaching_required', 'safety_referral')),
  issue_codes_json TEXT
    CHECK (issue_codes_json IS NULL OR (json_valid(issue_codes_json) AND json_type(issue_codes_json) = 'array')),
  reviewer_summary_text TEXT
    CHECK (reviewer_summary_text IS NULL OR length(trim(reviewer_summary_text)) BETWEEN 1 AND 1000),
  reviewer_summary_sha256 TEXT
    CHECK (
      reviewer_summary_sha256 IS NULL
      OR (
        length(reviewer_summary_sha256) = 64
        AND reviewer_summary_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  reviewer_summary_length INTEGER
    CHECK (reviewer_summary_length IS NULL OR reviewer_summary_length BETWEEN 1 AND 1000),
  linked_safety_escalation_id TEXT
    REFERENCES app_conversation_safety_escalations(id) ON DELETE RESTRICT,
  void_reason_code TEXT
    CHECK (void_reason_code IS NULL OR void_reason_code IN ('evidence_unavailable', 'scope_invalid', 'duplicate_sample')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  UNIQUE (message_id),
  CHECK (assigned_reviewer_admin_id IS NULL OR assigned_reviewer_admin_id <> actual_operator_admin_id),
  CHECK (
    (status = 'pending' AND assigned_reviewer_admin_id IS NULL AND reviewer_lease_expires_at IS NULL
      AND review_reason_code IS NULL AND completed_at IS NULL AND outcome IS NULL AND void_reason_code IS NULL)
    OR (status = 'in_review' AND assigned_reviewer_admin_id IS NOT NULL AND reviewer_lease_expires_at IS NOT NULL
      AND review_reason_code IS NOT NULL AND completed_at IS NULL AND outcome IS NULL AND void_reason_code IS NULL)
    OR (status = 'completed' AND assigned_reviewer_admin_id IS NOT NULL AND reviewer_lease_expires_at IS NULL
      AND review_reason_code IS NOT NULL AND completed_at IS NOT NULL AND outcome IS NOT NULL
      AND identity_disclosure_rating IS NOT NULL AND service_quality_rating IS NOT NULL
      AND policy_language_rating IS NOT NULL AND overall_score IS NOT NULL
      AND issue_codes_json IS NOT NULL AND reviewer_summary_text IS NOT NULL
      AND reviewer_summary_sha256 IS NOT NULL AND reviewer_summary_length IS NOT NULL
      AND void_reason_code IS NULL)
    OR (status = 'voided' AND completed_at IS NOT NULL AND outcome IS NULL AND void_reason_code IS NOT NULL)
  ),
  CHECK (
    (outcome = 'safety_referral' AND linked_safety_escalation_id IS NOT NULL)
    OR (
      (outcome IS NULL OR outcome IN ('pass', 'coaching_required'))
      AND linked_safety_escalation_id IS NULL
    )
  )
);

CREATE INDEX idx_app_conversation_quality_samples_queue
  ON app_conversation_quality_samples (status, group_id, created_at ASC, id ASC);

CREATE INDEX idx_app_conversation_quality_samples_reviewer
  ON app_conversation_quality_samples (assigned_reviewer_admin_id, status, reviewer_lease_expires_at ASC);

CREATE INDEX idx_app_conversation_quality_samples_operator
  ON app_conversation_quality_samples (actual_operator_admin_id, status, completed_at DESC);

CREATE TABLE app_conversation_quality_sample_evidence (
  sample_id TEXT PRIMARY KEY
    REFERENCES app_conversation_quality_samples(id) ON DELETE CASCADE,
  context_before_message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  context_before_body_sha256 TEXT
    CHECK (context_before_body_sha256 IS NULL OR length(context_before_body_sha256) = 64),
  target_message_id TEXT NOT NULL REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  target_message_body_sha256 TEXT NOT NULL CHECK (length(target_message_body_sha256) = 64),
  context_after_message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  context_after_body_sha256 TEXT
    CHECK (context_after_body_sha256 IS NULL OR length(context_after_body_sha256) = 64),
  disclosure_message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE RESTRICT,
  disclosure_message_body_sha256 TEXT
    CHECK (disclosure_message_body_sha256 IS NULL OR length(disclosure_message_body_sha256) = 64),
  expected_disclosure_body_sha256 TEXT
    CHECK (expected_disclosure_body_sha256 IS NULL OR length(expected_disclosure_body_sha256) = 64),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  captured_at TEXT NOT NULL CHECK (julianday(captured_at) IS NOT NULL)
);

CREATE TABLE app_conversation_quality_sample_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cqse_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  sample_id TEXT NOT NULL REFERENCES app_conversation_quality_samples(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('selected', 'claimed', 'renewed', 'completed', 'voided', 'improvement_task_created')),
  status_from TEXT CHECK (status_from IS NULL OR status_from IN ('pending', 'in_review', 'completed')),
  status_to TEXT NOT NULL CHECK (status_to IN ('pending', 'in_review', 'completed', 'voided')),
  reason_code TEXT NOT NULL
    CHECK (
      reason_code NOT GLOB '*[^a-z0-9_]*'
      AND length(reason_code) BETWEEN 3 AND 80
    ),
  actor_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (sample_id, sequence)
);

CREATE TABLE app_conversation_quality_improvement_tasks (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cqit_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  sample_id TEXT NOT NULL REFERENCES app_conversation_quality_samples(id) ON DELETE RESTRICT,
  group_id TEXT REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  assignee_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issue_code TEXT NOT NULL
    CHECK (
      issue_code NOT GLOB '*[^a-z0-9_]*'
      AND length(issue_code) BETWEEN 3 AND 80
    ),
  title_text TEXT NOT NULL CHECK (length(trim(title_text)) BETWEEN 1 AND 120),
  guidance_text TEXT NOT NULL CHECK (length(trim(guidance_text)) BETWEEN 1 AND 1000),
  guidance_sha256 TEXT NOT NULL CHECK (length(guidance_sha256) = 64),
  guidance_length INTEGER NOT NULL CHECK (guidance_length BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  due_at TEXT NOT NULL CHECK (julianday(due_at) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  completion_note_text TEXT
    CHECK (completion_note_text IS NULL OR length(trim(completion_note_text)) BETWEEN 1 AND 1000),
  completion_note_sha256 TEXT CHECK (completion_note_sha256 IS NULL OR length(completion_note_sha256) = 64),
  completion_note_length INTEGER CHECK (completion_note_length IS NULL OR completion_note_length BETWEEN 1 AND 1000),
  created_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  CHECK (
    (status IN ('open', 'in_progress') AND completed_at IS NULL AND completion_note_text IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND completion_note_text IS NOT NULL
      AND completion_note_sha256 IS NOT NULL AND completion_note_length IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_app_conversation_quality_tasks_assignee
  ON app_conversation_quality_improvement_tasks (assignee_admin_id, status, due_at ASC, id ASC);

CREATE INDEX idx_app_conversation_quality_tasks_group
  ON app_conversation_quality_improvement_tasks (group_id, status, due_at ASC, id ASC);

CREATE TABLE app_conversation_quality_improvement_task_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cqite_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 80
    ),
  task_id TEXT NOT NULL
    REFERENCES app_conversation_quality_improvement_tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'started', 'completed', 'cancelled')),
  status_from TEXT CHECK (status_from IS NULL OR status_from IN ('open', 'in_progress')),
  status_to TEXT NOT NULL CHECK (status_to IN ('open', 'in_progress', 'completed', 'cancelled')),
  reason_code TEXT NOT NULL
    CHECK (
      reason_code NOT GLOB '*[^a-z0-9_]*'
      AND length(reason_code) BETWEEN 3 AND 80
    ),
  actor_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (task_id, sequence)
);

CREATE TABLE app_conversation_quality_idempotency (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL
    CHECK (operation IN ('selection_run_create', 'sample_claim', 'sample_decision', 'sample_void', 'task_update')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_type TEXT NOT NULL CHECK (result_type IN ('selection_run', 'sample', 'task')),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 5 AND 80),
  result_version INTEGER NOT NULL CHECK (result_version >= 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (admin_id, operation, idempotency_key)
);

CREATE INDEX idx_app_conversation_quality_idempotency_result
  ON app_conversation_quality_idempotency (result_type, result_id, created_at DESC);
