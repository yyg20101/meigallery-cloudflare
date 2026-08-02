-- App API v2 的可重建公开人物读投影。
-- 本 migration 不会把任何现有图库自动映射为人物，也不写入公开数据。
-- 只有受控后台流程在完成认证、发布与授权校验后，才可写入/更新该投影。

CREATE TABLE IF NOT EXISTS profile_public_projections (
  profile_id TEXT PRIMARY KEY
    CHECK (
      profile_id GLOB 'pp_*'
      AND profile_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(profile_id) BETWEEN 4 AND 80
    ),
  person_id TEXT NOT NULL
    CHECK (
      person_id GLOB 'per_*'
      AND person_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(person_id) BETWEEN 5 AND 80
    ),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  source_gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE RESTRICT,
  tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),

  verification_status TEXT NOT NULL
    CHECK (verification_status IN ('pending', 'verified', 'rejected', 'suspended')),
  publication_status TEXT NOT NULL
    CHECK (publication_status IN ('draft', 'published', 'unpublished', 'archived')),
  authorization_status TEXT NOT NULL
    CHECK (authorization_status IN ('pending', 'active', 'expired', 'revoked')),
  authorization_valid_until TEXT CHECK (
    authorization_valid_until IS NULL
    OR (
      authorization_valid_until GLOB '????-??-??T??:??:??.???Z'
      AND datetime(authorization_valid_until) IS NOT NULL
    )
  ),
  visibility_status TEXT NOT NULL
    CHECK (visibility_status IN ('visible', 'hidden', 'suspended')),

  operation_mode TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (operation_mode IN ('platform_managed', 'self_managed')),
  operation_label TEXT NOT NULL DEFAULT '消息由平台运营接收'
    CHECK (length(trim(operation_label)) BETWEEN 1 AND 80),
  region_code TEXT CHECK (
    region_code IS NULL
    OR (length(region_code) BETWEEN 2 AND 32 AND region_code NOT GLOB '*[^a-z0-9-]*')
  ),
  region_label TEXT CHECK (region_label IS NULL OR length(region_label) BETWEEN 1 AND 80),
  region_precision TEXT CHECK (
    region_precision IS NULL OR region_precision IN ('city', 'province', 'country', 'broad')
  ),

  recommendation_score INTEGER NOT NULL DEFAULT 0 CHECK (recommendation_score >= 0),
  heat_score INTEGER NOT NULL DEFAULT 0 CHECK (heat_score >= 0),
  recommendation_reason_code TEXT NOT NULL DEFAULT 'EDITORIAL_QUALITY'
    CHECK (length(recommendation_reason_code) BETWEEN 1 AND 80),
  recommendation_rule_version TEXT NOT NULL DEFAULT 'discovery_v1'
    CHECK (length(recommendation_rule_version) BETWEEN 1 AND 80),
  published_at TEXT NOT NULL CHECK (
    published_at GLOB '????-??-??T??:??:??.???Z'
    AND datetime(published_at) IS NOT NULL
  ),
  source_updated_at TEXT NOT NULL CHECK (
    source_updated_at GLOB '????-??-??T??:??:??.???Z'
    AND datetime(source_updated_at) IS NOT NULL
  ),
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_profile_public_eligible_recommended
  ON profile_public_projections (
    verification_status,
    publication_status,
    authorization_status,
    visibility_status,
    recommendation_score DESC,
    published_at DESC,
    profile_id ASC
  );

CREATE INDEX IF NOT EXISTS idx_profile_public_eligible_popular
  ON profile_public_projections (
    verification_status,
    publication_status,
    authorization_status,
    visibility_status,
    heat_score DESC,
    published_at DESC,
    profile_id ASC
  );

CREATE INDEX IF NOT EXISTS idx_profile_public_eligible_latest
  ON profile_public_projections (
    verification_status,
    publication_status,
    authorization_status,
    visibility_status,
    published_at DESC,
    profile_id ASC
  );

CREATE INDEX IF NOT EXISTS idx_profile_public_eligible_region
  ON profile_public_projections (
    verification_status,
    publication_status,
    authorization_status,
    visibility_status,
    region_code,
    region_label
  );
