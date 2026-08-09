-- App Taxonomy-1：稳定分类词条、不可变目录快照与人物关联开发基线。
--
-- 本 migration 只建立默认关闭的数据结构与空开发目录，不导入 legacy tags，
-- 不启用环境开关，也不把未知词自动公开。公开客户端只读取已发布目录快照；
-- 人物发布投影只复制管理员显式关联、且在目录快照中可用于人物资料的稳定 term_id。

CREATE TABLE app_taxonomy_terms (
  term_id TEXT PRIMARY KEY
    CHECK (
      term_id GLOB 'txt_*'
      AND term_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(term_id) BETWEEN 8 AND 96
    ),
  type TEXT NOT NULL CHECK (type IN (
    'region_scope',
    'region_group',
    'city_country',
    'identity',
    'personality',
    'style',
    'occupation',
    'hair',
    'clothing',
    'scene',
    'content_type'
  )),
  parent_term_id TEXT REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  slug TEXT NOT NULL UNIQUE
    CHECK (
      length(slug) BETWEEN 1 AND 64
      AND slug GLOB '[a-z0-9]*'
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND slug NOT GLOB '*--*'
      AND substr(slug, 1, 1) <> '-'
      AND substr(slug, -1, 1) <> '-'
    ),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 300),
  aliases_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(aliases_json)
      AND json_type(aliases_json) = 'array'
      AND json_array_length(aliases_json) <= 20
    ),
  lifecycle_status TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_status IN (
    'draft',
    'pending_review',
    'active',
    'hidden',
    'deprecated',
    'merged',
    'archived'
  )),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
  allowed_for_profile INTEGER NOT NULL DEFAULT 1 CHECK (allowed_for_profile IN (0, 1)),
  sensitivity TEXT NOT NULL DEFAULT 'standard' CHECK (sensitivity IN ('standard', 'restricted')),
  merge_target_term_id TEXT REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -1000000 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT NOT NULL
    CHECK (
      length(mutation_token) = 36
      AND mutation_token GLOB '????????-????-????-????-????????????'
      AND mutation_token NOT GLOB '*[^0-9a-f-]*'
    ),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
  CHECK (parent_term_id IS NULL OR parent_term_id <> term_id),
  CHECK (merge_target_term_id IS NULL OR merge_target_term_id <> term_id),
  CHECK (
    (lifecycle_status = 'merged' AND merge_target_term_id IS NOT NULL)
    OR (lifecycle_status <> 'merged' AND merge_target_term_id IS NULL)
  )
);

CREATE INDEX idx_app_taxonomy_terms_admin_list
  ON app_taxonomy_terms (type, lifecycle_status, sort_order, display_name, term_id);

CREATE INDEX idx_app_taxonomy_terms_parent
  ON app_taxonomy_terms (parent_term_id, lifecycle_status, sort_order, term_id);

CREATE TABLE app_taxonomy_term_revisions (
  term_id TEXT NOT NULL REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  type TEXT NOT NULL,
  parent_term_id TEXT,
  display_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  lifecycle_status TEXT NOT NULL,
  visibility TEXT NOT NULL,
  allowed_for_profile INTEGER NOT NULL CHECK (allowed_for_profile IN (0, 1)),
  sensitivity TEXT NOT NULL,
  merge_target_term_id TEXT,
  sort_order INTEGER NOT NULL,
  change_reason TEXT NOT NULL CHECK (length(change_reason) BETWEEN 1 AND 120),
  changed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  PRIMARY KEY (term_id, version)
);

CREATE TABLE app_taxonomy_catalogs (
  catalog_id TEXT PRIMARY KEY
    CHECK (
      catalog_id GLOB 'txc_*'
      AND catalog_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(catalog_id) BETWEEN 8 AND 96
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      length(version_code) BETWEEN 1 AND 40
      AND version_code GLOB '[0-9]*'
      AND version_code NOT GLOB '*[^0-9.]*'
      AND version_code NOT GLOB '*..*'
      AND substr(version_code, 1, 1) <> '.'
      AND substr(version_code, -1, 1) <> '.'
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  effective_at TEXT NOT NULL
    CHECK (
      effective_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(effective_at) IS NOT NULL
    ),
  minimum_client_version TEXT NOT NULL DEFAULT '1.0.0'
    CHECK (
      length(minimum_client_version) BETWEEN 5 AND 20
      AND minimum_client_version NOT GLOB '*[^0-9.]*'
    ),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  published_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  published_at TEXT
    CHECK (
      published_at IS NULL
      OR (
        published_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(published_at) IS NOT NULL
      )
    ),
  CHECK (production_ready = 0 OR state = 'published'),
  CHECK (
    (state = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL)
    OR state <> 'published'
  )
);

-- 空开发目录只用于让代码契约具备稳定默认 ID；环境开关默认关闭，客户端不可读取。
INSERT INTO app_taxonomy_catalogs (
  catalog_id,
  version_code,
  state,
  production_ready,
  effective_at,
  minimum_client_version,
  item_count,
  lock_version,
  created_at
) VALUES (
  'txc_app_1_0_taxonomy_1_dev_1',
  '1.0.0',
  'development',
  0,
  '2026-08-09T00:00:00.000Z',
  '1.0.0',
  0,
  1,
  '2026-08-09T00:00:00.000Z'
);

CREATE TABLE app_taxonomy_catalog_items (
  catalog_id TEXT NOT NULL REFERENCES app_taxonomy_catalogs(catalog_id) ON DELETE RESTRICT,
  term_id TEXT NOT NULL REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  term_version INTEGER NOT NULL CHECK (term_version > 0),
  type TEXT NOT NULL CHECK (type IN (
    'region_scope', 'region_group', 'city_country', 'identity', 'personality', 'style',
    'occupation', 'hair', 'clothing', 'scene', 'content_type'
  )),
  parent_term_id TEXT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 64),
  description TEXT,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  public_state TEXT NOT NULL CHECK (public_state IN ('active', 'deprecated', 'redirect')),
  redirect_target_term_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  allowed_for_profile INTEGER NOT NULL CHECK (allowed_for_profile IN (0, 1)),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('standard', 'restricted')),
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (catalog_id, term_id),
  UNIQUE (catalog_id, slug),
  CHECK (
    (public_state = 'redirect' AND redirect_target_term_id IS NOT NULL)
    OR (public_state <> 'redirect' AND redirect_target_term_id IS NULL)
  )
);

CREATE INDEX idx_app_taxonomy_catalog_items_public
  ON app_taxonomy_catalog_items (
    catalog_id,
    visibility,
    type,
    public_state,
    sort_order,
    display_name,
    term_id
  );

CREATE TABLE app_taxonomy_legacy_mappings (
  mapping_id TEXT PRIMARY KEY
    CHECK (
      mapping_id GLOB 'txm_*'
      AND mapping_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(mapping_id) BETWEEN 8 AND 96
    ),
  source_namespace TEXT NOT NULL
    CHECK (
      length(source_namespace) BETWEEN 1 AND 40
      AND source_namespace NOT GLOB '*[^A-Za-z0-9_.-]*'
    ),
  source_type TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 40),
  source_value TEXT NOT NULL CHECK (length(source_value) BETWEEN 1 AND 120),
  source_normalized_value TEXT NOT NULL CHECK (length(source_normalized_value) BETWEEN 1 AND 120),
  mapping_type TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (mapping_type IN ('exact', 'alias', 'split_required', 'unsupported', 'pending_review')),
  target_term_id TEXT REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  mapping_rule_version TEXT NOT NULL CHECK (length(mapping_rule_version) BETWEEN 1 AND 40),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 300),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
  UNIQUE (source_namespace, source_type, source_normalized_value),
  CHECK (
    (mapping_type IN ('exact', 'alias') AND target_term_id IS NOT NULL)
    OR (mapping_type NOT IN ('exact', 'alias') AND target_term_id IS NULL)
  )
);

CREATE INDEX idx_app_taxonomy_legacy_mappings_review
  ON app_taxonomy_legacy_mappings (mapping_type, source_namespace, source_type, updated_at DESC);

CREATE TABLE person_profile_taxonomy_assignments (
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  term_id TEXT NOT NULL REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  catalog_id TEXT NOT NULL,
  catalog_term_version INTEGER NOT NULL CHECK (catalog_term_version > 0),
  assigned_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  PRIMARY KEY (profile_id, profile_version, term_id),
  FOREIGN KEY (catalog_id, term_id)
    REFERENCES app_taxonomy_catalog_items(catalog_id, term_id) ON DELETE RESTRICT
);

CREATE INDEX idx_person_profile_taxonomy_assignments_catalog
  ON person_profile_taxonomy_assignments (catalog_id, term_id, profile_id, profile_version);

CREATE TABLE profile_public_taxonomy_terms (
  profile_id TEXT NOT NULL REFERENCES profile_public_projections(profile_id) ON DELETE CASCADE,
  term_id TEXT NOT NULL REFERENCES app_taxonomy_terms(term_id) ON DELETE RESTRICT,
  taxonomy_type TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  catalog_term_version INTEGER NOT NULL CHECK (catalog_term_version > 0),
  projected_profile_version INTEGER NOT NULL CHECK (projected_profile_version > 0),
  projected_at TEXT NOT NULL
    CHECK (
      projected_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(projected_at) IS NOT NULL
    ),
  PRIMARY KEY (profile_id, term_id),
  FOREIGN KEY (catalog_id, term_id)
    REFERENCES app_taxonomy_catalog_items(catalog_id, term_id) ON DELETE RESTRICT
);

CREATE INDEX idx_profile_public_taxonomy_filter
  ON profile_public_taxonomy_terms (taxonomy_type, term_id, profile_id);

CREATE INDEX idx_profile_public_taxonomy_catalog
  ON profile_public_taxonomy_terms (catalog_id, term_id, profile_id);
