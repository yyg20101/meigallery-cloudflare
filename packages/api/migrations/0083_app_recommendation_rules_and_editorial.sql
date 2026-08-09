-- App Recommendation-1：版本化推荐规则、主动偏好、运营精选与最小化解释证据。
--
-- 本 migration 只建立 development 数据骨架，不修改 Wrangler 配置、不启用公开或
-- 后台 capability、不导入真实偏好/曝光，也不把既有 recommendation_score/heat_score
-- 宣布为正式生产公式。OQ-009/OQ-020/OQ-023 未关闭前，production 不得发布本策略。

CREATE TABLE app_recommendation_policies (
  policy_id TEXT PRIMARY KEY
    CHECK (
      policy_id GLOB 'rcp_*'
      AND policy_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(policy_id) BETWEEN 5 AND 96
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  feed_enabled INTEGER NOT NULL DEFAULT 0 CHECK (feed_enabled IN (0, 1)),
  admin_operations_enabled INTEGER NOT NULL DEFAULT 0 CHECK (admin_operations_enabled IN (0, 1)),
  preference_enabled INTEGER NOT NULL DEFAULT 0 CHECK (preference_enabled IN (0, 1)),
  personalization_enabled INTEGER NOT NULL DEFAULT 0 CHECK (personalization_enabled IN (0, 1)),
  personalization_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (personalization_decision_status IN ('unresolved', 'approved')),
  evidence_recording_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (evidence_recording_enabled IN (0, 1)),
  evidence_retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (evidence_retention_decision_status IN ('unresolved', 'approved')),
  evidence_retention_days INTEGER
    CHECK (evidence_retention_days IS NULL OR evidence_retention_days BETWEEN 1 AND 3650),
  purge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purge_enabled IN (0, 1)),
  default_page_size INTEGER NOT NULL DEFAULT 20 CHECK (default_page_size BETWEEN 1 AND 40),
  max_page_size INTEGER NOT NULL DEFAULT 40 CHECK (max_page_size BETWEEN 1 AND 40),
  max_candidate_pool INTEGER NOT NULL DEFAULT 200 CHECK (max_candidate_pool BETWEEN 40 AND 500),
  max_editorial_items INTEGER NOT NULL DEFAULT 3 CHECK (max_editorial_items BETWEEN 0 AND 10),
  minimum_client_version TEXT NOT NULL DEFAULT '1.0'
    CHECK (length(minimum_client_version) BETWEEN 1 AND 40),
  effective_at TEXT NOT NULL
    CHECK (
      effective_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(effective_at) IS NOT NULL
    ),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  CHECK (
    personalization_enabled = 0
    OR personalization_decision_status = 'approved'
  ),
  CHECK (
    evidence_recording_enabled = 0
    OR (
      evidence_retention_decision_status = 'approved'
      AND evidence_retention_days IS NOT NULL
      AND purge_enabled = 1
    )
  )
);

INSERT INTO app_recommendation_policies (
  policy_id,
  state,
  production_ready,
  feed_enabled,
  admin_operations_enabled,
  preference_enabled,
  personalization_enabled,
  personalization_decision_status,
  evidence_recording_enabled,
  evidence_retention_decision_status,
  evidence_retention_days,
  purge_enabled,
  default_page_size,
  max_page_size,
  max_candidate_pool,
  max_editorial_items,
  minimum_client_version,
  effective_at,
  created_at
) VALUES (
  'rcp_app_1_0_recommendation_1_dev_1',
  'development',
  0,
  1,
  1,
  1,
  0,
  'unresolved',
  0,
  'unresolved',
  NULL,
  0,
  20,
  40,
  200,
  3,
  '1.0',
  '2026-08-09T00:00:00.000Z',
  '2026-08-09T00:00:00.000Z'
);

-- 热度公式和计算结果使用不可变版本；当前只创建未批准草稿，不生成分数。
CREATE TABLE app_recommendation_heat_versions (
  heat_version_id TEXT PRIMARY KEY
    CHECK (
      heat_version_id GLOB 'rhv_*'
      AND heat_version_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(heat_version_id) BETWEEN 5 AND 96
    ),
  version_code TEXT NOT NULL UNIQUE CHECK (length(version_code) BETWEEN 1 AND 80),
  state TEXT NOT NULL CHECK (state IN ('draft', 'approved', 'active', 'paused', 'retired')),
  formula_json TEXT NOT NULL CHECK (json_valid(formula_json) AND json_type(formula_json) = 'object'),
  observation_window_days INTEGER NOT NULL CHECK (observation_window_days BETWEEN 1 AND 365),
  minimum_sample_size INTEGER NOT NULL CHECK (minimum_sample_size BETWEEN 1 AND 1000000),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  approved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

INSERT INTO app_recommendation_heat_versions (
  heat_version_id,
  version_code,
  state,
  formula_json,
  observation_window_days,
  minimum_sample_size,
  production_ready,
  lock_version,
  created_by,
  approved_by,
  created_at,
  approved_at
) VALUES (
  'rhv_app_1_0_recommendation_1_dev_1',
  'app-1.0-recommendation-1-dev-1',
  'draft',
  '{"signals":[],"timeDecay":"unresolved","antiAbuse":"unresolved"}',
  30,
  20,
  0,
  1,
  NULL,
  NULL,
  '2026-08-09T00:00:00.000Z',
  NULL
);

CREATE TABLE app_recommendation_heat_scores (
  heat_version_id TEXT NOT NULL
    REFERENCES app_recommendation_heat_versions(heat_version_id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL
    REFERENCES profile_public_projections(profile_id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1000000),
  sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
  score_bucket TEXT NOT NULL CHECK (score_bucket IN ('insufficient', 'normal', 'popular')),
  computed_at TEXT NOT NULL,
  source_window_start TEXT NOT NULL,
  source_window_end TEXT NOT NULL,
  PRIMARY KEY (heat_version_id, profile_id)
);

CREATE INDEX idx_app_recommendation_heat_scores_rank
  ON app_recommendation_heat_scores (heat_version_id, score DESC, profile_id ASC);

-- 每一行都是不可变业务版本；仅 draft/validating 可在原行上以 expectedVersion 编辑。
CREATE TABLE app_recommendation_rule_versions (
  rule_version_id TEXT PRIMARY KEY
    CHECK (
      rule_version_id GLOB 'rrv_*'
      AND rule_version_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(rule_version_id) BETWEEN 5 AND 96
    ),
  rule_set_id TEXT NOT NULL
    CHECK (
      rule_set_id GLOB 'rrs_*'
      AND rule_set_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(rule_set_id) BETWEEN 5 AND 96
    ),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  state TEXT NOT NULL
    CHECK (state IN (
      'draft', 'validating', 'approved', 'scheduled', 'active',
      'paused', 'retired', 'rolled_back'
    )),
  entry_point TEXT NOT NULL DEFAULT 'discovery_home'
    CHECK (entry_point IN ('discovery_home')),
  mode TEXT NOT NULL CHECK (mode IN ('non_personalized', 'personalized')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  taxonomy_catalog_id TEXT
    REFERENCES app_taxonomy_catalogs(catalog_id) ON DELETE RESTRICT,
  heat_version_id TEXT
    REFERENCES app_recommendation_heat_versions(heat_version_id) ON DELETE RESTRICT,
  weights_json TEXT NOT NULL
    CHECK (json_valid(weights_json) AND json_type(weights_json) = 'object'),
  reason_map_json TEXT NOT NULL
    CHECK (json_valid(reason_map_json) AND json_type(reason_map_json) = 'object'),
  target_region_codes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(target_region_codes_json) AND json_type(target_region_codes_json) = 'array'),
  target_channels_json TEXT NOT NULL DEFAULT '["app"]'
    CHECK (json_valid(target_channels_json) AND json_type(target_channels_json) = 'array'),
  max_consecutive_same_region INTEGER NOT NULL DEFAULT 3
    CHECK (max_consecutive_same_region BETWEEN 1 AND 20),
  max_consecutive_same_term INTEGER NOT NULL DEFAULT 3
    CHECK (max_consecutive_same_term BETWEEN 1 AND 20),
  repeat_exposure_cap INTEGER NOT NULL DEFAULT 3 CHECK (repeat_exposure_cap BETWEEN 1 AND 100),
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  minimum_client_version TEXT NOT NULL DEFAULT '1.0'
    CHECK (length(minimum_client_version) BETWEEN 1 AND 40),
  effective_at TEXT CHECK (effective_at IS NULL OR julianday(effective_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL),
  rollback_rule_version_id TEXT
    REFERENCES app_recommendation_rule_versions(rule_version_id) ON DELETE RESTRICT,
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  last_dry_run_json TEXT
    CHECK (last_dry_run_json IS NULL OR (json_valid(last_dry_run_json) AND json_type(last_dry_run_json) = 'object')),
  last_dry_run_at TEXT,
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  mutation_token TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  activated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  activated_at TEXT,
  paused_at TEXT,
  UNIQUE (rule_set_id, version_number),
  CHECK (expires_at IS NULL OR effective_at IS NULL OR datetime(expires_at) > datetime(effective_at)),
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),
  CHECK (
    mode = 'personalized'
    OR COALESCE(json_extract(weights_json, '$.preferredTaxonomy'), 0) = 0
  )
);

CREATE UNIQUE INDEX idx_app_recommendation_one_active_mode
  ON app_recommendation_rule_versions (entry_point, mode)
  WHERE state = 'active';

CREATE UNIQUE INDEX idx_app_recommendation_one_scheduled_mode
  ON app_recommendation_rule_versions (entry_point, mode)
  WHERE state = 'scheduled';

CREATE INDEX idx_app_recommendation_rule_list
  ON app_recommendation_rule_versions (entry_point, state, updated_at DESC, rule_version_id ASC);

CREATE INDEX idx_app_recommendation_rule_set_versions
  ON app_recommendation_rule_versions (rule_set_id, version_number DESC);

-- 当前仅提供可 dry-run 的开发草稿；不会成为公开 active 规则。
INSERT INTO app_recommendation_rule_versions (
  rule_version_id,
  rule_set_id,
  version_number,
  state,
  entry_point,
  mode,
  name,
  description,
  taxonomy_catalog_id,
  heat_version_id,
  weights_json,
  reason_map_json,
  target_region_codes_json,
  target_channels_json,
  max_consecutive_same_region,
  max_consecutive_same_term,
  repeat_exposure_cap,
  rollout_percent,
  minimum_client_version,
  effective_at,
  expires_at,
  rollback_rule_version_id,
  production_ready,
  last_dry_run_json,
  last_dry_run_at,
  lock_version,
  mutation_token,
  created_by,
  updated_by,
  reviewed_by,
  activated_by,
  created_at,
  updated_at,
  reviewed_at,
  activated_at,
  paused_at
) SELECT
  'rrv_app_1_0_recommendation_1_dev_1',
  'rrs_app_1_0_recommendation_1_dev_1',
  1,
  'draft',
  'discovery_home',
  'non_personalized',
  'App 1.0 非个性化推荐开发草稿',
  'OQ-009 未关闭；当前权重只用于开发 Dry-run，不代表正式热度或生产排序。',
  NULL,
  NULL,
  '{"quality":70,"heat":0,"freshness":30,"region":0,"preferredTaxonomy":0}',
  '{"editorial":"PLATFORM_SELECTED","region":"REGION_RELEVANT","popular":"RECENTLY_POPULAR","fresh":"RECENTLY_PUBLISHED","default":"DISCOVERY_NEUTRAL"}',
  '[]',
  '["app"]',
  3,
  3,
  3,
  0,
  '1.0',
  NULL,
  NULL,
  NULL,
  0,
  NULL,
  NULL,
  1,
  NULL,
  owner.id,
  owner.id,
  NULL,
  NULL,
  '2026-08-09T00:00:00.000Z',
  '2026-08-09T00:00:00.000Z',
  NULL,
  NULL,
  NULL
FROM users owner
WHERE owner.role = 'owner'
ORDER BY owner.id ASC
LIMIT 1;

CREATE TABLE app_recommendation_rule_events (
  event_id TEXT PRIMARY KEY
    CHECK (event_id GLOB 'rre_*' AND length(event_id) BETWEEN 5 AND 96),
  rule_version_id TEXT NOT NULL
    REFERENCES app_recommendation_rule_versions(rule_version_id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_app_recommendation_rule_events_timeline
  ON app_recommendation_rule_events (rule_version_id, created_at DESC, event_id ASC);

CREATE TABLE app_recommendation_preferences (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  personalization_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (personalization_enabled IN (0, 1)),
  taxonomy_catalog_id TEXT
    REFERENCES app_taxonomy_catalogs(catalog_id) ON DELETE RESTRICT,
  preferred_term_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(preferred_term_ids_json)
      AND json_type(preferred_term_ids_json) = 'array'
      AND json_array_length(preferred_term_ids_json) BETWEEN 0 AND 20
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    personalization_enabled = 0
    OR (taxonomy_catalog_id IS NOT NULL AND json_array_length(preferred_term_ids_json) > 0)
  )
);

CREATE TABLE app_recommendation_editorial_placements (
  placement_id TEXT PRIMARY KEY
    CHECK (
      placement_id GLOB 'rep_*'
      AND placement_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(placement_id) BETWEEN 5 AND 96
    ),
  state TEXT NOT NULL
    CHECK (state IN ('draft', 'pending_review', 'approved', 'scheduled', 'active', 'paused', 'expired', 'retired')),
  entry_point TEXT NOT NULL DEFAULT 'discovery_home'
    CHECK (entry_point IN ('discovery_home')),
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  position_key TEXT NOT NULL DEFAULT 'discovery_feed'
    CHECK (position_key IN ('discovery_feed')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 1000),
  region_code TEXT
    CHECK (region_code IS NULL OR (length(region_code) BETWEEN 2 AND 32 AND region_code NOT GLOB '*[^a-z0-9-]*')),
  channel TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app')),
  disclosure_code TEXT NOT NULL DEFAULT 'PLATFORM_SELECTED'
    CHECK (disclosure_code IN ('PLATFORM_SELECTED')),
  disclosure_label TEXT NOT NULL DEFAULT '平台精选'
    CHECK (disclosure_label = '平台精选'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  starts_at TEXT NOT NULL CHECK (julianday(starts_at) IS NOT NULL),
  ends_at TEXT NOT NULL CHECK (julianday(ends_at) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  activated_at TEXT,
  paused_at TEXT,
  CHECK (datetime(ends_at) > datetime(starts_at)),
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by)
);

CREATE INDEX idx_app_recommendation_editorial_schedule
  ON app_recommendation_editorial_placements (
    entry_point, channel, state, starts_at, ends_at, priority ASC, placement_id ASC
  );

CREATE INDEX idx_app_recommendation_editorial_profile
  ON app_recommendation_editorial_placements (profile_id, state, starts_at, ends_at);

-- 推荐会话只在 evidence policy 完整批准且运行时开启时写入；账号仅保存不可逆摘要。
CREATE TABLE app_recommendation_sessions (
  session_id TEXT PRIMARY KEY
    CHECK (
      session_id GLOB 'rcs_*'
      AND length(session_id) = 68
      AND substr(session_id, 5) NOT GLOB '*[^0-9a-f]*'
    ),
  account_hash TEXT
    CHECK (account_hash IS NULL OR (length(account_hash) = 64 AND account_hash NOT GLOB '*[^0-9a-f]*')),
  mode TEXT NOT NULL CHECK (mode IN ('non_personalized', 'personalized')),
  rule_version_id TEXT NOT NULL
    REFERENCES app_recommendation_rule_versions(rule_version_id) ON DELETE RESTRICT,
  heat_version_id TEXT
    REFERENCES app_recommendation_heat_versions(heat_version_id) ON DELETE RESTRICT,
  context_hash TEXT NOT NULL
    CHECK (length(context_hash) = 64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (datetime(expires_at) > datetime(created_at))
);

CREATE INDEX idx_app_recommendation_sessions_expiry
  ON app_recommendation_sessions (expires_at, session_id);

CREATE TABLE app_recommendation_session_items (
  session_id TEXT NOT NULL
    REFERENCES app_recommendation_sessions(session_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank > 0),
  profile_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  source TEXT NOT NULL CHECK (source IN ('rule', 'editorial')),
  placement_id TEXT,
  PRIMARY KEY (session_id, rank),
  UNIQUE (session_id, profile_id)
);

CREATE TABLE app_recommendation_admin_requests (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL
    CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_type TEXT NOT NULL CHECK (result_type IN ('rule_version', 'placement')),
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 5 AND 96),
  created_at TEXT NOT NULL,
  PRIMARY KEY (admin_id, idempotency_key_hash)
);
