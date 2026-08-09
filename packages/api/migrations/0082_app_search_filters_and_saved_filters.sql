-- App Search-2：结构化筛选、结果预估、保存条件与可执行会员权益开发基线。
--
-- 本 migration 不启用环境开关、不切换当前会员/分类目录、不迁移 grant，
-- 也不创建任何用户保存条件。自由搜索词不得进入保存条件；保存条件只记录
-- taxonomy stable term ID 与来源目录版本。

ALTER TABLE app_person_search_policies
  ADD COLUMN structured_filters_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (structured_filters_enabled IN (0, 1));

ALTER TABLE app_person_search_policies
  ADD COLUMN filter_preview_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (filter_preview_enabled IN (0, 1));

ALTER TABLE app_person_search_policies
  ADD COLUMN saved_filters_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (saved_filters_enabled IN (0, 1));

ALTER TABLE app_person_search_policies
  ADD COLUMN max_filter_terms INTEGER NOT NULL DEFAULT 12
    CHECK (max_filter_terms BETWEEN 1 AND 30);

ALTER TABLE app_person_search_policies
  ADD COLUMN max_saved_filter_name_length INTEGER NOT NULL DEFAULT 40
    CHECK (max_saved_filter_name_length BETWEEN 1 AND 80);

INSERT INTO app_person_search_policies (
  id,
  state,
  production_ready,
  person_search_enabled,
  history_enabled,
  history_production_ready,
  default_history_recording_enabled,
  history_retention_decision_status,
  purge_enabled,
  max_query_length,
  max_history_items,
  history_retention_days,
  effective_at,
  created_at,
  structured_filters_enabled,
  filter_preview_enabled,
  saved_filters_enabled,
  max_filter_terms,
  max_saved_filter_name_length
) VALUES (
  'sqp_app_1_0_search_2_dev_1',
  'development',
  0,
  1,
  1,
  0,
  0,
  'unresolved',
  0,
  50,
  50,
  90,
  '2026-08-09T00:00:00.000Z',
  '2026-08-09T00:00:00.000Z',
  1,
  1,
  1,
  12,
  40
);

-- 同一 catalog 内的父子层级和 merged redirect 都投影为 ancestor -> descendant，
-- 使父级筛选可匹配后代，并使合并目标继续匹配仍引用旧 stable ID 的公开资料。
CREATE TABLE app_taxonomy_catalog_closure (
  catalog_id TEXT NOT NULL,
  ancestor_term_id TEXT NOT NULL,
  descendant_term_id TEXT NOT NULL,
  PRIMARY KEY (catalog_id, ancestor_term_id, descendant_term_id),
  FOREIGN KEY (catalog_id, ancestor_term_id)
    REFERENCES app_taxonomy_catalog_items(catalog_id, term_id) ON DELETE RESTRICT,
  FOREIGN KEY (catalog_id, descendant_term_id)
    REFERENCES app_taxonomy_catalog_items(catalog_id, term_id) ON DELETE RESTRICT
);

CREATE INDEX idx_app_taxonomy_catalog_closure_descendant
  ON app_taxonomy_catalog_closure (catalog_id, descendant_term_id, ancestor_term_id);

INSERT INTO app_taxonomy_catalog_closure (
  catalog_id,
  ancestor_term_id,
  descendant_term_id
)
WITH RECURSIVE closure(catalog_id, ancestor_term_id, descendant_term_id) AS (
  SELECT catalog_id, term_id, term_id
  FROM app_taxonomy_catalog_items

  UNION

  SELECT catalog_id, parent_term_id, term_id
  FROM app_taxonomy_catalog_items
  WHERE parent_term_id IS NOT NULL

  UNION

  SELECT catalog_id, redirect_target_term_id, term_id
  FROM app_taxonomy_catalog_items
  WHERE public_state = 'redirect' AND redirect_target_term_id IS NOT NULL

  UNION

  SELECT c.catalog_id, c.ancestor_term_id, edge.descendant_term_id
  FROM closure c
  JOIN (
    SELECT catalog_id, parent_term_id AS ancestor_term_id, term_id AS descendant_term_id
    FROM app_taxonomy_catalog_items
    WHERE parent_term_id IS NOT NULL
    UNION
    SELECT catalog_id, redirect_target_term_id AS ancestor_term_id, term_id AS descendant_term_id
    FROM app_taxonomy_catalog_items
    WHERE public_state = 'redirect' AND redirect_target_term_id IS NOT NULL
  ) edge
    ON edge.catalog_id = c.catalog_id
   AND edge.ancestor_term_id = c.descendant_term_id
)
SELECT catalog_id, ancestor_term_id, descendant_term_id
FROM closure;

CREATE TABLE app_saved_person_filters (
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filter_id TEXT NOT NULL
    CHECK (
      filter_id GLOB 'sf_*'
      AND length(filter_id) = 67
      AND substr(filter_id, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 80),
  catalog_id TEXT NOT NULL REFERENCES app_taxonomy_catalogs(catalog_id) ON DELETE RESTRICT,
  term_ids_json TEXT NOT NULL
    CHECK (
      json_valid(term_ids_json)
      AND json_type(term_ids_json) = 'array'
      AND json_array_length(term_ids_json) BETWEEN 0 AND 12
    ),
  default_sort TEXT NOT NULL CHECK (default_sort IN ('popular', 'latest')),
  idempotency_key_hash TEXT NOT NULL
    CHECK (
      length(idempotency_key_hash) = 64
      AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  updated_at TEXT NOT NULL
    CHECK (
      updated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(updated_at) IS NOT NULL
    ),
  deleted_at TEXT
    CHECK (
      deleted_at IS NULL
      OR (
        deleted_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(deleted_at) IS NOT NULL
      )
    ),
  PRIMARY KEY (account_id, filter_id),
  UNIQUE (account_id, idempotency_key_hash),
  CHECK (
    (deleted_at IS NULL AND json_array_length(term_ids_json) BETWEEN 1 AND 12)
    OR (deleted_at IS NOT NULL AND json_array_length(term_ids_json) = 0)
  )
);

CREATE UNIQUE INDEX idx_app_saved_person_filters_active_name
  ON app_saved_person_filters (account_id, normalized_name)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_app_saved_person_filters_account_list
  ON app_saved_person_filters (account_id, updated_at DESC, filter_id ASC)
  WHERE deleted_at IS NULL;

-- Membership Search-2 新目录保持不可变目录原则：复制既有五级展示和非搜索权益，
-- 仅把冻结后的 canonical entitlement key 加入为 available。运行时不会自动切换。
INSERT INTO app_membership_catalog_versions (
  id,
  version_code,
  state,
  production_ready,
  effective_at,
  timezone,
  minimum_client_version
) VALUES (
  'amc_app_1_0_search_2_dev_1',
  'app-1.0-search-2-dev-1',
  'development',
  0,
  '2026-08-09T00:00:00.000Z',
  'Asia/Shanghai',
  '1.0'
);

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
  'amc_app_1_0_search_2_dev_1',
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
WHERE catalog_version_id = 'amc_app_1_0_draft_1';

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
  unit_label
)
SELECT
  'amc_app_1_0_search_2_dev_1',
  entitlement_key,
  schema_version,
  value_type,
  default_value_json,
  merge_strategy,
  period_rule,
  client_capability,
  display_name,
  description,
  unit_label
FROM app_entitlement_definitions
WHERE catalog_version_id = 'amc_app_1_0_draft_1'
  AND entitlement_key NOT IN ('discovery.filter_tier', 'discovery.saved_filters');

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
  unit_label
) VALUES
  (
    'amc_app_1_0_search_2_dev_1',
    'discovery.filter.advanced',
    1,
    'enum',
    '"none"',
    'highest_rank',
    NULL,
    'discovery.advanced_filters',
    '高级筛选',
    '可使用的高级结构化筛选档位：none、basic 或 full。',
    NULL
  ),
  (
    'amc_app_1_0_search_2_dev_1',
    'discovery.saved_filter.max',
    1,
    'integer',
    '0',
    'highest_rank',
    NULL,
    'discovery.saved_filters',
    '保存条件',
    '最多可保存的结构化筛选条件数量。',
    '个'
  );

INSERT INTO app_membership_tier_entitlements (
  catalog_version_id,
  tier_id,
  entitlement_key,
  value_json,
  availability
)
SELECT
  'amc_app_1_0_search_2_dev_1',
  tier_id,
  entitlement_key,
  value_json,
  availability
FROM app_membership_tier_entitlements
WHERE catalog_version_id = 'amc_app_1_0_draft_1'
  AND entitlement_key NOT IN ('discovery.filter_tier', 'discovery.saved_filters');

INSERT INTO app_membership_tier_entitlements (
  catalog_version_id,
  tier_id,
  entitlement_key,
  value_json,
  availability
)
SELECT
  'amc_app_1_0_search_2_dev_1',
  tier_id,
  'discovery.filter.advanced',
  value_json,
  'available'
FROM app_membership_tier_entitlements
WHERE catalog_version_id = 'amc_app_1_0_draft_1'
  AND entitlement_key = 'discovery.filter_tier';

INSERT INTO app_membership_tier_entitlements (
  catalog_version_id,
  tier_id,
  entitlement_key,
  value_json,
  availability
)
SELECT
  'amc_app_1_0_search_2_dev_1',
  tier_id,
  'discovery.saved_filter.max',
  value_json,
  'available'
FROM app_membership_tier_entitlements
WHERE catalog_version_id = 'amc_app_1_0_draft_1'
  AND entitlement_key = 'discovery.saved_filters';
