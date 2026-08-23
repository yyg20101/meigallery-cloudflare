-- Recommendation-5：推荐灰度目标、反指标与自动停止控制面。
--
-- 本 migration 只建立默认关闭的数据结构，不写入真实指标、阈值、来源凭证或
-- production-ready 策略。OQ-009/OQ-020/OQ-031 未关闭前，评估与自动停止保持关闭。

CREATE TABLE app_recommendation_guardrail_controls (
  control_id TEXT PRIMARY KEY CHECK (control_id = 'recommendation_guardrails'),
  evaluation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_enabled IN (0, 1)),
  source_key TEXT NOT NULL DEFAULT 'recommendation_aggregate_v1'
    CHECK (source_key = 'recommendation_aggregate_v1'),
  source_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (source_decision_status IN ('unresolved', 'approved')),
  retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (retention_decision_status IN ('unresolved', 'approved')),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  purge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purge_enabled IN (0, 1)),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  max_snapshot_age_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (max_snapshot_age_minutes BETWEEN 5 AND 1440),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  CHECK (
    evaluation_enabled = 0
    OR (
      source_decision_status = 'approved'
      AND retention_decision_status = 'approved'
      AND retention_days IS NOT NULL
      AND purge_enabled = 1
    )
  ),
  CHECK (
    production_ready = 0
    OR (
      evaluation_enabled = 1
      AND source_decision_status = 'approved'
      AND retention_decision_status = 'approved'
      AND retention_days IS NOT NULL
      AND purge_enabled = 1
    )
  )
);

INSERT INTO app_recommendation_guardrail_controls (
  control_id, evaluation_enabled, source_key, source_decision_status,
  retention_decision_status, retention_days, purge_enabled, production_ready,
  max_snapshot_age_minutes, created_at, updated_at
) VALUES (
  'recommendation_guardrails', 0, 'recommendation_aggregate_v1', 'unresolved',
  'unresolved', NULL, 0, 0, 30,
  '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
);

CREATE TABLE app_recommendation_guardrail_policies (
  policy_id TEXT PRIMARY KEY
    CHECK (
      policy_id GLOB 'rgp_*'
      AND policy_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(policy_id) BETWEEN 5 AND 96
    ),
  state TEXT NOT NULL CHECK (state IN ('draft', 'pending_review', 'approved', 'retired')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  source_key TEXT NOT NULL CHECK (source_key = 'recommendation_aggregate_v1'),
  observation_window_minutes INTEGER NOT NULL
    CHECK (observation_window_minutes BETWEEN 5 AND 10080),
  minimum_sample_size INTEGER NOT NULL CHECK (minimum_sample_size BETWEEN 1 AND 1000000000),
  minimum_observation_count INTEGER NOT NULL
    CHECK (minimum_observation_count BETWEEN 1 AND 100),
  consecutive_breach_count INTEGER NOT NULL
    CHECK (consecutive_breach_count BETWEEN 1 AND 10),
  metric_definitions_json TEXT NOT NULL
    CHECK (
      json_valid(metric_definitions_json)
      AND json_type(metric_definitions_json) = 'array'
      AND json_array_length(metric_definitions_json) BETWEEN 2 AND 32
    ),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  mutation_token TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  retired_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  retired_at TEXT CHECK (retired_at IS NULL OR julianday(retired_at) IS NOT NULL),
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),
  CHECK (
    (state = 'retired' AND retired_by IS NOT NULL AND retired_at IS NOT NULL)
    OR (state <> 'retired' AND retired_by IS NULL AND retired_at IS NULL)
  )
);

CREATE INDEX idx_app_recommendation_guardrail_policy_state
  ON app_recommendation_guardrail_policies(state, updated_at DESC, policy_id ASC);

CREATE TABLE app_recommendation_guardrail_policy_events (
  event_id TEXT PRIMARY KEY
    CHECK (event_id GLOB 'rgpe_*' AND length(event_id) BETWEEN 6 AND 96),
  policy_id TEXT NOT NULL
    REFERENCES app_recommendation_guardrail_policies(policy_id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX idx_app_recommendation_guardrail_policy_events
  ON app_recommendation_guardrail_policy_events(policy_id, created_at DESC, event_id ASC);

ALTER TABLE app_recommendation_rule_versions
  ADD COLUMN guardrail_policy_id TEXT
    REFERENCES app_recommendation_guardrail_policies(policy_id) ON DELETE RESTRICT;

CREATE INDEX idx_app_recommendation_rule_guardrail_policy
  ON app_recommendation_rule_versions(guardrail_policy_id, state, rule_version_id);

CREATE TABLE app_recommendation_guardrail_evaluations (
  evaluation_id TEXT PRIMARY KEY
    CHECK (
      evaluation_id GLOB 'rge_*'
      AND evaluation_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(evaluation_id) BETWEEN 5 AND 96
    ),
  rule_version_id TEXT NOT NULL
    REFERENCES app_recommendation_rule_versions(rule_version_id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL
    REFERENCES app_recommendation_guardrail_policies(policy_id) ON DELETE RESTRICT,
  policy_digest TEXT NOT NULL
    CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  source_key TEXT NOT NULL CHECK (source_key = 'recommendation_aggregate_v1'),
  source_snapshot_ref TEXT NOT NULL
    CHECK (
      length(source_snapshot_ref) BETWEEN 26 AND 192
      AND source_snapshot_ref GLOB 'aggregate:recommendation:*'
      AND source_snapshot_ref NOT GLOB '*[?#]*'
      AND instr(source_snapshot_ref, '://') = 0
    ),
  source_snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(source_snapshot_sha256) = 64
      AND source_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  window_start TEXT NOT NULL CHECK (julianday(window_start) IS NOT NULL),
  window_end TEXT NOT NULL CHECK (julianday(window_end) IS NOT NULL),
  captured_at TEXT NOT NULL CHECK (julianday(captured_at) IS NOT NULL),
  sample_size INTEGER NOT NULL CHECK (sample_size BETWEEN 0 AND 1000000000),
  observation_ordinal INTEGER NOT NULL CHECK (observation_ordinal > 0),
  status TEXT NOT NULL
    CHECK (status IN ('observing', 'healthy', 'warning', 'target_missed', 'breached', 'source_incomplete')),
  blocking_reason_code TEXT
    CHECK (
      blocking_reason_code IS NULL
      OR (
        length(blocking_reason_code) BETWEEN 3 AND 80
        AND blocking_reason_code NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  target_met_count INTEGER NOT NULL CHECK (target_met_count >= 0),
  target_missed_count INTEGER NOT NULL CHECK (target_missed_count >= 0),
  warning_count INTEGER NOT NULL CHECK (warning_count >= 0),
  stop_breach_count INTEGER NOT NULL CHECK (stop_breach_count >= 0),
  evaluated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (rule_version_id, source_snapshot_ref),
  UNIQUE (rule_version_id, policy_id, observation_ordinal),
  CHECK (julianday(window_end) > julianday(window_start)),
  CHECK (julianday(captured_at) >= julianday(window_end)),
  CHECK (
    (status IN ('breached', 'source_incomplete') AND blocking_reason_code IS NOT NULL)
    OR (status NOT IN ('breached', 'source_incomplete') AND blocking_reason_code IS NULL)
  )
);

CREATE INDEX idx_app_recommendation_guardrail_evaluation_rule
  ON app_recommendation_guardrail_evaluations(
    rule_version_id, observation_ordinal DESC, evaluation_id DESC
  );

CREATE TABLE app_recommendation_guardrail_metric_results (
  evaluation_id TEXT NOT NULL
    REFERENCES app_recommendation_guardrail_evaluations(evaluation_id) ON DELETE RESTRICT,
  metric_code TEXT NOT NULL
    CHECK (
      length(metric_code) BETWEEN 3 AND 80
      AND metric_code NOT GLOB '*[^a-z0-9_]*'
    ),
  metric_kind TEXT NOT NULL CHECK (metric_kind IN ('target', 'guardrail')),
  unit TEXT NOT NULL CHECK (unit IN ('ppm', 'milliseconds')),
  comparator TEXT NOT NULL CHECK (comparator IN ('gte', 'lte')),
  threshold_value INTEGER NOT NULL CHECK (threshold_value >= 0),
  numerator INTEGER CHECK (numerator IS NULL OR numerator >= 0),
  denominator INTEGER CHECK (denominator IS NULL OR denominator > 0),
  measured_value INTEGER CHECK (measured_value IS NULL OR measured_value >= 0),
  severity TEXT CHECK (severity IS NULL OR severity IN ('warning', 'stop')),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('met', 'missed', 'healthy', 'warning', 'breached', 'unavailable')),
  PRIMARY KEY (evaluation_id, metric_code),
  CHECK (
    (
      outcome = 'unavailable'
      AND numerator IS NULL
      AND denominator IS NULL
      AND measured_value IS NULL
    )
    OR (
      unit = 'ppm'
      AND numerator IS NOT NULL
      AND denominator IS NOT NULL
      AND numerator <= denominator
      AND measured_value BETWEEN 0 AND 1000000
    )
    OR (
      unit = 'milliseconds'
      AND numerator IS NULL
      AND denominator IS NULL
      AND measured_value IS NOT NULL
    )
  ),
  CHECK (
    (
      metric_kind = 'target'
      AND severity IS NULL
      AND outcome IN ('met', 'missed', 'unavailable')
    )
    OR (
      metric_kind = 'guardrail'
      AND severity IN ('warning', 'stop')
      AND outcome IN ('healthy', 'warning', 'breached', 'unavailable')
    )
  )
);

CREATE TABLE app_recommendation_guardrail_blocks (
  block_id TEXT PRIMARY KEY
    CHECK (block_id GLOB 'rgb_*' AND length(block_id) BETWEEN 5 AND 96),
  rule_version_id TEXT NOT NULL UNIQUE
    REFERENCES app_recommendation_rule_versions(rule_version_id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL
    REFERENCES app_recommendation_guardrail_policies(policy_id) ON DELETE RESTRICT,
  evaluation_id TEXT NOT NULL UNIQUE
    REFERENCES app_recommendation_guardrail_evaluations(evaluation_id) ON DELETE RESTRICT,
  rollback_rule_version_id TEXT NOT NULL
    REFERENCES app_recommendation_rule_versions(rule_version_id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (
      length(reason_code) BETWEEN 3 AND 80
      AND reason_code NOT GLOB '*[^a-z0-9_]*'
    ),
  triggered_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  CHECK (rule_version_id <> rollback_rule_version_id)
);

CREATE INDEX idx_app_recommendation_guardrail_blocks_policy
  ON app_recommendation_guardrail_blocks(policy_id, created_at DESC, block_id ASC);

CREATE TABLE app_recommendation_guardrail_requests (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL
    CHECK (
      length(idempotency_key_hash) = 64
      AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_type TEXT NOT NULL CHECK (result_type IN ('policy', 'evaluation')),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 5 AND 96),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (admin_id, idempotency_key_hash)
);

-- 正式灰度（1–99%）必须绑定已批准守护策略，且已触发停止的版本不能再次进入投放。
CREATE TRIGGER trg_app_recommendation_guardrail_activation
BEFORE UPDATE OF state ON app_recommendation_rule_versions
WHEN NEW.state IN ('active', 'scheduled')
BEGIN
  SELECT CASE
    WHEN NEW.rollout_percent BETWEEN 1 AND 99
      AND (
        NEW.guardrail_policy_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM app_recommendation_guardrail_policies policy
          WHERE policy.policy_id = NEW.guardrail_policy_id
            AND policy.state = 'approved'
        )
      )
    THEN RAISE(ABORT, 'recommendation_guardrail_policy_required')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM app_recommendation_guardrail_blocks block
      WHERE block.rule_version_id = NEW.rule_version_id
    )
    THEN RAISE(ABORT, 'recommendation_guardrail_rule_blocked')
  END;
END;

CREATE TRIGGER trg_app_recommendation_guardrail_insert_activation
BEFORE INSERT ON app_recommendation_rule_versions
WHEN NEW.state IN ('active', 'scheduled')
BEGIN
  SELECT CASE
    WHEN NEW.rollout_percent BETWEEN 1 AND 99
      AND (
        NEW.guardrail_policy_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM app_recommendation_guardrail_policies policy
          WHERE policy.policy_id = NEW.guardrail_policy_id
            AND policy.state = 'approved'
        )
      )
    THEN RAISE(ABORT, 'recommendation_guardrail_policy_required')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM app_recommendation_guardrail_blocks block
      WHERE block.rule_version_id = NEW.rule_version_id
    )
    THEN RAISE(ABORT, 'recommendation_guardrail_rule_blocked')
  END;
END;

CREATE TRIGGER trg_app_recommendation_guardrail_live_rule_update
BEFORE UPDATE OF rollout_percent, guardrail_policy_id ON app_recommendation_rule_versions
WHEN NEW.state IN ('active', 'scheduled')
BEGIN
  SELECT CASE
    WHEN NEW.rollout_percent BETWEEN 1 AND 99
      AND (
        NEW.guardrail_policy_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM app_recommendation_guardrail_policies policy
          WHERE policy.policy_id = NEW.guardrail_policy_id
            AND policy.state = 'approved'
        )
      )
    THEN RAISE(ABORT, 'recommendation_guardrail_policy_required')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM app_recommendation_guardrail_blocks block
      WHERE block.rule_version_id = NEW.rule_version_id
    )
    THEN RAISE(ABORT, 'recommendation_guardrail_rule_blocked')
  END;
END;

CREATE TRIGGER trg_app_recommendation_guardrail_binding_immutable
BEFORE UPDATE OF guardrail_policy_id ON app_recommendation_rule_versions
WHEN OLD.state <> 'draft' OR NEW.state <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_binding_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_policy_no_delete
BEFORE DELETE ON app_recommendation_guardrail_policies
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_policy_append_only');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_policy_retire_in_use
BEFORE UPDATE OF state ON app_recommendation_guardrail_policies
WHEN NEW.state = 'retired'
  AND EXISTS (
    SELECT 1
    FROM app_recommendation_rule_versions rule
    WHERE rule.guardrail_policy_id = OLD.policy_id
      AND rule.state IN ('active', 'scheduled')
  )
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_policy_in_use');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_policy_retired_immutable
BEFORE UPDATE ON app_recommendation_guardrail_policies
WHEN OLD.state = 'retired'
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_policy_retired_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_policy_approved_immutable
BEFORE UPDATE ON app_recommendation_guardrail_policies
WHEN OLD.state = 'approved'
  AND (
    NEW.state <> 'retired'
    OR NEW.name IS NOT OLD.name
    OR NEW.description IS NOT OLD.description
    OR NEW.source_key IS NOT OLD.source_key
    OR NEW.observation_window_minutes IS NOT OLD.observation_window_minutes
    OR NEW.minimum_sample_size IS NOT OLD.minimum_sample_size
    OR NEW.minimum_observation_count IS NOT OLD.minimum_observation_count
    OR NEW.consecutive_breach_count IS NOT OLD.consecutive_breach_count
    OR NEW.metric_definitions_json IS NOT OLD.metric_definitions_json
    OR NEW.production_ready IS NOT OLD.production_ready
    OR NEW.created_by IS NOT OLD.created_by
    OR NEW.reviewed_by IS NOT OLD.reviewed_by
    OR NEW.reviewed_at IS NOT OLD.reviewed_at
  )
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_policy_approved_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_policy_event_immutable
BEFORE UPDATE ON app_recommendation_guardrail_policy_events
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_policy_event_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_policy_event_no_delete
BEFORE DELETE ON app_recommendation_guardrail_policy_events
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_policy_event_append_only');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_evaluation_binding
BEFORE INSERT ON app_recommendation_guardrail_evaluations
WHEN NOT EXISTS (
  SELECT 1
  FROM app_recommendation_rule_versions rule
  JOIN app_recommendation_guardrail_policies policy
    ON policy.policy_id = NEW.policy_id
  JOIN app_recommendation_guardrail_controls control
    ON control.control_id = 'recommendation_guardrails'
  WHERE rule.rule_version_id = NEW.rule_version_id
    AND rule.state = 'active'
    AND rule.rollout_percent BETWEEN 1 AND 99
    AND rule.rollback_rule_version_id IS NOT NULL
    AND rule.guardrail_policy_id = NEW.policy_id
    AND policy.state = 'approved'
    AND policy.source_key = NEW.source_key
    AND control.evaluation_enabled = 1
    AND control.source_decision_status = 'approved'
    AND control.retention_decision_status = 'approved'
    AND control.retention_days IS NOT NULL
    AND control.purge_enabled = 1
    AND control.source_key = NEW.source_key
)
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_evaluation_binding_invalid');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_evaluation_immutable
BEFORE UPDATE ON app_recommendation_guardrail_evaluations
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_evaluation_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_evaluation_no_delete
BEFORE DELETE ON app_recommendation_guardrail_evaluations
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_evaluation_append_only');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_metric_immutable
BEFORE UPDATE ON app_recommendation_guardrail_metric_results
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_metric_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_metric_no_delete
BEFORE DELETE ON app_recommendation_guardrail_metric_results
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_metric_append_only');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_block_immutable
BEFORE UPDATE ON app_recommendation_guardrail_blocks
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_block_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_block_binding
BEFORE INSERT ON app_recommendation_guardrail_blocks
WHEN NOT EXISTS (
  SELECT 1
  FROM app_recommendation_guardrail_evaluations evaluation
  JOIN app_recommendation_rule_versions rule
    ON rule.rule_version_id = evaluation.rule_version_id
  JOIN app_recommendation_rule_versions fallback
    ON fallback.rule_version_id = NEW.rollback_rule_version_id
  WHERE evaluation.evaluation_id = NEW.evaluation_id
    AND evaluation.rule_version_id = NEW.rule_version_id
    AND evaluation.policy_id = NEW.policy_id
    AND evaluation.status IN ('breached', 'source_incomplete')
    AND evaluation.blocking_reason_code = NEW.reason_code
    AND rule.rollback_rule_version_id = NEW.rollback_rule_version_id
    AND fallback.entry_point = rule.entry_point
    AND fallback.mode = rule.mode
    AND fallback.rollout_percent = 100
    AND fallback.activated_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_block_binding_invalid');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_block_no_delete
BEFORE DELETE ON app_recommendation_guardrail_blocks
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_block_append_only');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_request_immutable
BEFORE UPDATE ON app_recommendation_guardrail_requests
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_request_immutable');
END;

CREATE TRIGGER trg_app_recommendation_guardrail_request_no_delete
BEFORE DELETE ON app_recommendation_guardrail_requests
BEGIN
  SELECT RAISE(ABORT, 'recommendation_guardrail_request_append_only');
END;
