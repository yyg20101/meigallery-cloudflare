-- ADM-MSG-02：平台话题内部协作。
--
-- 本 migration 只增加内部备注、显式转派和管理员幂等事实：
-- - 不开启消息、后台或安全运行时开关；
-- - 不创建账号、话题、备注或转派业务 seed；
-- - 内部备注不进入用户响应、通用分析或通用审计正文；
-- - 不在本阶段实现运营组、班次、自动分配或安全升级案件。

CREATE TABLE app_conversation_internal_notes (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cin_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  note_type TEXT NOT NULL CHECK (note_type IN ('operation', 'handoff', 'quality')),
  body_text TEXT NOT NULL CHECK (length(trim(body_text)) BETWEEN 1 AND 1000),
  body_sha256 TEXT NOT NULL
    CHECK (
      length(body_sha256) = 64
      AND body_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  body_length INTEGER NOT NULL CHECK (body_length BETWEEN 1 AND 1000),
  author_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_conversation_internal_notes_timeline
  ON app_conversation_internal_notes (conversation_id, created_at DESC, id DESC);

CREATE TABLE app_conversation_transfer_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cte_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  from_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (reason_code IN (
      'workload_balance',
      'expertise_required',
      'shift_handoff',
      'supervisor_review',
      'other'
    )),
  handoff_note_id TEXT REFERENCES app_conversation_internal_notes(id) ON DELETE SET NULL,
  lease_expires_at TEXT NOT NULL CHECK (julianday(lease_expires_at) IS NOT NULL),
  actor_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (conversation_id, assignment_version),
  CHECK (from_admin_id <> to_admin_id),
  CHECK (actor_admin_id = from_admin_id)
);

CREATE INDEX idx_app_conversation_transfer_events_timeline
  ON app_conversation_transfer_events (conversation_id, created_at DESC, id DESC);

CREATE INDEX idx_app_conversation_transfer_events_target
  ON app_conversation_transfer_events (to_admin_id, created_at DESC, id DESC);

CREATE TABLE app_conversation_admin_idempotency (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('internal_note_create', 'assignment_transfer')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 5 AND 80),
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (admin_id, operation, idempotency_key)
);

CREATE INDEX idx_app_conversation_admin_idempotency_result
  ON app_conversation_admin_idempotency (conversation_id, operation, result_id);
