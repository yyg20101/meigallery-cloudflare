-- Membership-1：独立 App 的版本化五级会员目录、typed entitlement 与手动 grant。
--
-- 本 migration 只写入开发草案目录，不迁移 legacy vip/svip，不向任何账号发放会员，
-- 也不改变 production/dev 的运行时开关。grant 本体保持不可变，撤销使用独立追加记录表达。

CREATE TABLE app_membership_catalog_versions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (length(version_code) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  effective_at TEXT NOT NULL
    CHECK (
      effective_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(effective_at) IS NOT NULL
    ),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'
    CHECK (length(timezone) BETWEEN 1 AND 64),
  minimum_client_version TEXT NOT NULL DEFAULT '1.0'
    CHECK (length(minimum_client_version) BETWEEN 1 AND 32),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    )
);

CREATE TABLE app_membership_tiers (
  catalog_version_id TEXT NOT NULL REFERENCES app_membership_catalog_versions(id),
  tier_id TEXT NOT NULL
    CHECK (
      tier_id GLOB 'amt_*'
      AND tier_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(tier_id) BETWEEN 5 AND 80
    ),
  code TEXT NOT NULL CHECK (code GLOB '[a-z]*' AND length(code) BETWEEN 3 AND 48),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 32),
  tagline TEXT NOT NULL CHECK (length(trim(tagline)) BETWEEN 1 AND 120),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 1000),
  accent_token TEXT NOT NULL CHECK (length(accent_token) BETWEEN 1 AND 32),
  acquisition_label TEXT NOT NULL CHECK (length(trim(acquisition_label)) BETWEEN 1 AND 120),
  service_disclosure TEXT NOT NULL CHECK (length(trim(service_disclosure)) BETWEEN 1 AND 240),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 1 AND 1000),
  PRIMARY KEY (catalog_version_id, tier_id),
  UNIQUE (catalog_version_id, code),
  UNIQUE (catalog_version_id, rank),
  UNIQUE (catalog_version_id, sort_order)
);

CREATE TABLE app_entitlement_definitions (
  catalog_version_id TEXT NOT NULL REFERENCES app_membership_catalog_versions(id),
  entitlement_key TEXT NOT NULL
    CHECK (
      entitlement_key GLOB '[a-z]*.*'
      AND entitlement_key NOT GLOB '*[^a-z0-9._]*'
      AND length(entitlement_key) BETWEEN 3 AND 80
    ),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'integer', 'enum')),
  default_value_json TEXT NOT NULL CHECK (json_valid(default_value_json)),
  merge_strategy TEXT NOT NULL CHECK (merge_strategy IN ('highest_rank')),
  period_rule TEXT,
  client_capability TEXT NOT NULL
    CHECK (length(client_capability) BETWEEN 1 AND 80),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 48),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 240),
  unit_label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  PRIMARY KEY (catalog_version_id, entitlement_key)
);

CREATE TABLE app_membership_tier_entitlements (
  catalog_version_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  availability TEXT NOT NULL DEFAULT 'planned'
    CHECK (availability IN ('available', 'planned')),
  PRIMARY KEY (catalog_version_id, tier_id, entitlement_key),
  FOREIGN KEY (catalog_version_id, tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id),
  FOREIGN KEY (catalog_version_id, entitlement_key)
    REFERENCES app_entitlement_definitions(catalog_version_id, entitlement_key)
);

CREATE TABLE app_membership_grants (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amg_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_version_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  tier_code_snapshot TEXT NOT NULL CHECK (length(tier_code_snapshot) BETWEEN 3 AND 48),
  tier_name_snapshot TEXT NOT NULL CHECK (length(trim(tier_name_snapshot)) BETWEEN 1 AND 32),
  rank_snapshot INTEGER NOT NULL CHECK (rank_snapshot BETWEEN 1 AND 1000),
  starts_at TEXT NOT NULL
    CHECK (
      starts_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(starts_at) IS NOT NULL
    ),
  expires_at TEXT NOT NULL
    CHECK (
      expires_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(expires_at) IS NOT NULL
      AND julianday(expires_at) > julianday(starts_at)
    ),
  source_type TEXT NOT NULL DEFAULT 'manual_admin'
    CHECK (source_type IN ('manual_admin')),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('manual_review', 'customer_support', 'promotion', 'compensation')),
  user_visible_note TEXT NOT NULL
    CHECK (length(trim(user_visible_note)) BETWEEN 1 AND 240),
  internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 1000),
  business_reference TEXT NOT NULL
    CHECK (length(trim(business_reference)) BETWEEN 3 AND 100),
  granted_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  FOREIGN KEY (catalog_version_id, tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id)
);

CREATE INDEX idx_app_membership_grants_user_validity
  ON app_membership_grants (user_id, starts_at, expires_at, rank_snapshot DESC, id ASC);

CREATE UNIQUE INDEX idx_app_membership_grants_user_business_reference
  ON app_membership_grants (user_id, business_reference);

CREATE TABLE app_membership_grant_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES app_membership_grants(id),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('admin_correction', 'customer_request', 'account_restriction', 'policy_enforcement')),
  user_visible_note TEXT NOT NULL
    CHECK (length(trim(user_visible_note)) BETWEEN 1 AND 240),
  internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 1000),
  business_reference TEXT NOT NULL
    CHECK (length(trim(business_reference)) BETWEEN 3 AND 100),
  revoked_by INTEGER NOT NULL REFERENCES users(id),
  revoked_at TEXT NOT NULL
    CHECK (
      revoked_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(revoked_at) IS NOT NULL
    )
);

CREATE TABLE app_membership_admin_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  operation TEXT NOT NULL CHECK (operation IN ('grant', 'revoke')),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  grant_id TEXT NOT NULL REFERENCES app_membership_grants(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    )
);

CREATE INDEX idx_app_membership_admin_requests_target
  ON app_membership_admin_requests (target_user_id, created_at DESC);

INSERT INTO app_membership_catalog_versions (
  id,
  version_code,
  state,
  production_ready,
  effective_at,
  timezone,
  minimum_client_version
) VALUES (
  'amc_app_1_0_draft_1',
  'app-1.0-draft-1',
  'development',
  0,
  '2026-08-06T00:00:00.000Z',
  'Asia/Shanghai',
  '1.0'
);

INSERT INTO app_entitlement_definitions (
  catalog_version_id,
  entitlement_key,
  value_type,
  default_value_json,
  merge_strategy,
  period_rule,
  client_capability,
  display_name,
  description,
  unit_label
) VALUES
  ('amc_app_1_0_draft_1', 'direct_message.create', 'boolean', 'false', 'highest_rank', NULL, 'messaging.text', '发起平台话题', '是否可以创建由平台运营接收的新话题。', NULL),
  ('amc_app_1_0_draft_1', 'direct_message.send', 'boolean', 'false', 'highest_rank', NULL, 'messaging.text', '发送话题消息', '是否可以在有效话题中发送文本消息。', NULL),
  ('amc_app_1_0_draft_1', 'direct_message.new_threads_per_day', 'integer', '0', 'highest_rank', 'daily:Asia/Shanghai', 'messaging.new_threads', '每日新话题', '每日可新建的平台话题数量。', '个/日'),
  ('amc_app_1_0_draft_1', 'discovery.filter_tier', 'enum', '"none"', 'highest_rank', NULL, 'discovery.advanced_filters', '发现筛选', '可使用的发现筛选档位。', NULL),
  ('amc_app_1_0_draft_1', 'discovery.saved_filters', 'integer', '0', 'highest_rank', NULL, 'discovery.saved_filters', '保存筛选', '最多可保存的筛选方案数量。', '个'),
  ('amc_app_1_0_draft_1', 'history.retention_days', 'integer', '0', 'highest_rank', NULL, 'history.viewer', '浏览历史', '浏览历史的保留天数。', '天'),
  ('amc_app_1_0_draft_1', 'favorite.folder_count', 'integer', '0', 'highest_rank', NULL, 'favorite.folders', '收藏夹', '最多可创建的收藏夹数量。', '个');

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
) VALUES
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'heart_meet', '心遇', '从遇见开始，解锁平台话题', 10, 'rose', '联系平台，由管理员审核后发放', '当前话题由平台运营接收，不保证真人本人回复、固定时效或关系结果。', 10),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'heart_delight', '心悦', '看见更多喜欢，发现更加从容', 20, 'coral', '联系平台，由管理员审核后发放', '当前话题由平台运营接收，不保证真人本人回复、固定时效或关系结果。', 20),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'heart_insight', '心知', '更懂你的偏好，互动更进一步', 30, 'violet', '联系平台，由管理员审核后发放', '当前话题由平台运营接收，不保证真人本人回复、固定时效或关系结果。', 30),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'heart_bond', '心契', '享受高阶服务与专属体验', 40, 'plum', '联系平台，由管理员审核后发放', '当前话题由平台运营接收，不保证真人本人回复、固定时效或关系结果。', 40),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'heart_radiance', '心耀', '心享至高等级，汇集完整权益', 50, 'gold', '联系平台，由管理员审核后发放', '当前话题由平台运营接收，不保证真人本人回复、固定时效或关系结果。', 50);

INSERT INTO app_membership_tier_entitlements (
  catalog_version_id,
  tier_id,
  entitlement_key,
  value_json,
  availability
) VALUES
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'direct_message.create', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'direct_message.send', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'direct_message.new_threads_per_day', '1', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'discovery.filter_tier', '"none"', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'discovery.saved_filters', '1', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'history.retention_days', '7', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_meet', 'favorite.folder_count', '3', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'direct_message.create', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'direct_message.send', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'direct_message.new_threads_per_day', '2', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'discovery.filter_tier', '"basic"', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'discovery.saved_filters', '3', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'history.retention_days', '15', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_delight', 'favorite.folder_count', '5', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'direct_message.create', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'direct_message.send', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'direct_message.new_threads_per_day', '4', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'discovery.filter_tier', '"full"', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'discovery.saved_filters', '6', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'history.retention_days', '30', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_insight', 'favorite.folder_count', '10', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'direct_message.create', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'direct_message.send', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'direct_message.new_threads_per_day', '6', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'discovery.filter_tier', '"full"', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'discovery.saved_filters', '12', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'history.retention_days', '60', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_bond', 'favorite.folder_count', '20', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'direct_message.create', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'direct_message.send', 'true', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'direct_message.new_threads_per_day', '10', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'discovery.filter_tier', '"full"', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'discovery.saved_filters', '20', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'history.retention_days', '90', 'planned'),
  ('amc_app_1_0_draft_1', 'amt_heart_radiance', 'favorite.folder_count', '30', 'planned');
