-- App 平台话题运营组、班次与确定性自动分配。
-- 本 migration 只建立空表，不创建运营组、班次、规则或启用自动分配。

CREATE TABLE app_conversation_groups (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cgrp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  code TEXT NOT NULL UNIQUE
    CHECK (
      length(code) BETWEEN 2 AND 40
      AND code NOT GLOB '*[^a-z0-9-]*'
    ),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone = 'Asia/Shanghai'),
  max_active_assignments INTEGER NOT NULL CHECK (max_active_assignments BETWEEN 1 AND 10000),
  max_new_first_responses_per_service_day INTEGER NOT NULL
    CHECK (max_new_first_responses_per_service_day BETWEEN 1 AND 10000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE INDEX idx_app_conversation_groups_status
  ON app_conversation_groups (status, name ASC, id ASC);

CREATE TABLE app_conversation_group_members (
  group_id TEXT NOT NULL REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_role TEXT NOT NULL CHECK (member_role IN ('operator', 'lead', 'quality')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  accepts_new_assignments INTEGER NOT NULL DEFAULT 1
    CHECK (accepts_new_assignments IN (0, 1)),
  max_active_assignments INTEGER NOT NULL CHECK (max_active_assignments BETWEEN 1 AND 1000),
  max_new_first_responses_per_service_day INTEGER NOT NULL
    CHECK (max_new_first_responses_per_service_day BETWEEN 1 AND 1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (group_id, admin_id)
);

CREATE INDEX idx_app_conversation_group_members_admin
  ON app_conversation_group_members (admin_id, status, group_id);

CREATE TABLE app_conversation_group_shifts (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'csh_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  group_id TEXT NOT NULL REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (start_minute <> end_minute)
);

CREATE INDEX idx_app_conversation_group_shifts_schedule
  ON app_conversation_group_shifts (group_id, status, weekday, start_minute, end_minute);

CREATE TABLE app_conversation_assignment_policies (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'automatic')),
  strategy TEXT NOT NULL CHECK (strategy = 'least_loaded_oldest'),
  unassigned_behavior TEXT NOT NULL CHECK (unassigned_behavior = 'keep_unassigned'),
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Shanghai'),
  max_dispatch_batch INTEGER NOT NULL CHECK (max_dispatch_batch BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TABLE app_conversation_routing_rules (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'crr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  match_type TEXT NOT NULL CHECK (match_type IN ('default', 'profile', 'region')),
  match_value TEXT NOT NULL CHECK (length(match_value) BETWEEN 1 AND 80),
  group_id TEXT NOT NULL REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT CHECK (mutation_token IS NULL OR length(mutation_token) BETWEEN 16 AND 80),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (
    (match_type = 'default' AND match_value = '*')
    OR (
      match_type = 'profile'
      AND match_value GLOB 'pp_*'
      AND match_value NOT GLOB '*[^A-Za-z0-9_-]*'
    )
    OR (
      match_type = 'region'
      AND length(match_value) BETWEEN 2 AND 32
      AND match_value NOT GLOB '*[^a-z0-9-]*'
    )
  )
);

CREATE UNIQUE INDEX idx_app_conversation_routing_rules_active_match
  ON app_conversation_routing_rules (match_type, match_value)
  WHERE status = 'active';

CREATE INDEX idx_app_conversation_routing_rules_lookup
  ON app_conversation_routing_rules (status, match_type, match_value, priority, id);

CREATE TABLE app_conversation_routing_assignment_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cra_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  group_id TEXT NOT NULL REFERENCES app_conversation_groups(id) ON DELETE RESTRICT,
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  routing_rule_id TEXT NOT NULL REFERENCES app_conversation_routing_rules(id) ON DELETE RESTRICT,
  trigger_code TEXT NOT NULL CHECK (trigger_code IN ('viewer_message', 'manual_dispatch', 'manual_claim')),
  service_day TEXT NOT NULL CHECK (service_day GLOB '????-??-??'),
  is_new_first_response INTEGER NOT NULL CHECK (is_new_first_response IN (0, 1)),
  operator_active_before INTEGER NOT NULL CHECK (operator_active_before >= 0),
  operator_capacity INTEGER NOT NULL CHECK (operator_capacity > 0),
  group_active_before INTEGER NOT NULL CHECK (group_active_before >= 0),
  group_capacity INTEGER NOT NULL CHECK (group_capacity > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (conversation_id, assignment_version)
);

CREATE INDEX idx_app_conversation_routing_assignment_operator_day
  ON app_conversation_routing_assignment_events (admin_id, service_day, is_new_first_response, created_at);

CREATE INDEX idx_app_conversation_routing_assignment_group_day
  ON app_conversation_routing_assignment_events (group_id, service_day, is_new_first_response, created_at);

CREATE TABLE app_conversation_routing_idempotency (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (
    operation IN (
      'group_create',
      'group_update',
      'member_upsert',
      'shift_create',
      'shift_update',
      'policy_upsert',
      'rule_create',
      'rule_update',
      'dispatch_run'
    )
  ),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_type TEXT NOT NULL CHECK (result_type IN ('group', 'member', 'shift', 'policy', 'rule', 'dispatch')),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 1 AND 80),
  result_version INTEGER NOT NULL CHECK (result_version >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (admin_id, operation, idempotency_key)
);
