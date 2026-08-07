-- Safety-2：默认关闭的举报“未发现违规”结论独立复核。
--
-- 本 migration 只创建开发策略、申诉当前投影、仅追加事件和幂等表：
-- - 不启用任何运行时开关；
-- - 不创建申诉业务 seed，不回填既有举报；
-- - 不支持账号限制、金币或其他来源申诉；
-- - 不执行自动清理，生产仍受 Message-2 未决保留策略阻断。

CREATE TABLE app_safety_appeal_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'sap_*'
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
  appeal_window_days INTEGER NOT NULL CHECK (appeal_window_days BETWEEN 1 AND 365),
  max_statement_length INTEGER NOT NULL CHECK (max_statement_length BETWEEN 1 AND 500),
  max_per_report_decision INTEGER NOT NULL CHECK (max_per_report_decision = 1),
  retention_policy_id TEXT NOT NULL REFERENCES app_safety_retention_policies(id) ON DELETE RESTRICT,
  effective_at TEXT CHECK (effective_at IS NULL OR julianday(effective_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (production_ready = 0 OR (state = 'published' AND effective_at IS NOT NULL))
);

INSERT INTO app_safety_appeal_policies (
  id,
  version_code,
  state,
  production_ready,
  appeal_window_days,
  max_statement_length,
  max_per_report_decision,
  retention_policy_id,
  effective_at,
  created_at
) VALUES (
  'sap_app_1_0_safety_2_dev_1',
  'app-1.0-safety-2-dev-1',
  'development',
  0,
  30,
  500,
  1,
  'srp_message_2_unresolved_dev_1',
  NULL,
  '2026-08-07T00:00:00.000Z'
);

CREATE TABLE app_safety_appeals (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'apl_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  report_id TEXT NOT NULL REFERENCES app_safety_reports(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  appeal_type TEXT NOT NULL CHECK (appeal_type = 'report_no_violation_review'),
  original_report_version INTEGER NOT NULL CHECK (original_report_version > 0),
  original_decision_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  statement_text TEXT NOT NULL CHECK (length(trim(statement_text)) BETWEEN 1 AND 500),
  statement_sha256 TEXT NOT NULL
    CHECK (
      length(statement_sha256) = 64
      AND statement_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'triaged', 'investigating', 'upheld', 'changed', 'closed')),
  user_visible_status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (user_visible_status IN ('submitted', 'processing', 'upheld', 'changed', 'closed')),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  policy_id TEXT NOT NULL REFERENCES app_safety_appeal_policies(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  submitted_at TEXT NOT NULL CHECK (julianday(submitted_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  UNIQUE (report_id, original_report_version, appeal_type),
  CHECK (assigned_admin_id IS NULL OR assigned_admin_id <> original_decision_admin_id),
  CHECK (
    (status IN ('upheld', 'changed', 'closed') AND resolved_at IS NOT NULL)
    OR (status IN ('submitted', 'triaged', 'investigating') AND resolved_at IS NULL)
  )
);

CREATE INDEX idx_app_safety_appeals_account_time
  ON app_safety_appeals (account_id, submitted_at DESC, id ASC);

CREATE INDEX idx_app_safety_appeals_queue
  ON app_safety_appeals (status, submitted_at ASC, id ASC);

CREATE INDEX idx_app_safety_appeals_assignment
  ON app_safety_appeals (assigned_admin_id, status, updated_at ASC)
  WHERE assigned_admin_id IS NOT NULL;

CREATE TABLE app_safety_appeal_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ape_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  appeal_id TEXT NOT NULL REFERENCES app_safety_appeals(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('viewer', 'admin', 'system')),
  actor_account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted', 'claimed', 'upheld', 'changed', 'closed')),
  status_from TEXT,
  status_to TEXT NOT NULL CHECK (status_to IN ('submitted', 'triaged', 'investigating', 'upheld', 'changed', 'closed')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  user_visible_status TEXT NOT NULL CHECK (user_visible_status IN ('submitted', 'processing', 'upheld', 'changed', 'closed')),
  user_visible_message TEXT NOT NULL CHECK (length(trim(user_visible_message)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (appeal_id, sequence),
  CHECK (
    (actor_type = 'viewer' AND actor_account_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_account_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_account_id IS NULL AND actor_admin_id IS NULL)
  )
);

CREATE TABLE app_safety_appeal_idempotency (
  actor_scope TEXT NOT NULL CHECK (length(actor_scope) BETWEEN 3 AND 96),
  operation TEXT NOT NULL CHECK (operation IN ('appeal_create', 'appeal_claim', 'appeal_decision')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  result_id TEXT NOT NULL REFERENCES app_safety_appeals(id) ON DELETE RESTRICT,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (actor_scope, operation, idempotency_key)
);
