-- App 人物供给权威数据与受控发布工作流。
-- 本 migration 只创建空表和公开投影扩展字段，不导入、映射或发布任何真人资料。

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'per_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'suspended', 'archived')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_profiles (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'pp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 4 AND 80
    ),
  person_id TEXT NOT NULL UNIQUE REFERENCES persons(id) ON DELETE RESTRICT,
  source_gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
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
  recommendation_score INTEGER NOT NULL DEFAULT 0 CHECK (recommendation_score BETWEEN 0 AND 1000000),
  heat_score INTEGER NOT NULL DEFAULT 0 CHECK (heat_score BETWEEN 0 AND 1000000),
  recommendation_reason_code TEXT NOT NULL DEFAULT 'EDITORIAL_QUALITY'
    CHECK (length(recommendation_reason_code) BETWEEN 1 AND 80),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected', 'expired', 'revoked')),
  publication_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (publication_status IN ('draft', 'pending_review', 'published', 'suspended', 'archived')),
  safety_status TEXT NOT NULL DEFAULT 'clear'
    CHECK (safety_status IN ('clear', 'hidden', 'suspended')),
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
  live_content_version INTEGER CHECK (live_content_version IS NULL OR live_content_version > 0),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  mutation_token TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_person_profiles_work_queue
  ON person_profiles (publication_status, verification_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_person_profiles_gallery
  ON person_profiles (source_gallery_id);

CREATE TABLE IF NOT EXISTS person_authorizations (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'paut_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  purpose TEXT NOT NULL DEFAULT 'app_public_display'
    CHECK (purpose IN ('app_public_display')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'expired', 'revoked')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  valid_from TEXT NOT NULL CHECK (datetime(valid_from) IS NOT NULL),
  valid_until TEXT CHECK (valid_until IS NULL OR datetime(valid_until) IS NOT NULL),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revoked_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (valid_until IS NULL OR datetime(valid_until) > datetime(valid_from))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_authorizations_one_active_version
  ON person_authorizations (profile_id, profile_version)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_person_authorizations_current
  ON person_authorizations (profile_id, profile_version, status, valid_until DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS person_verifications (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'pver_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'rejected', 'expired', 'revoked')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 1 AND 500),
  verification_items_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(verification_items_json) AND json_type(verification_items_json) = 'array'),
  policy_version TEXT NOT NULL DEFAULT 'person_verification_v1'
    CHECK (length(policy_version) BETWEEN 1 AND 80),
  valid_until TEXT CHECK (valid_until IS NULL OR datetime(valid_until) IS NOT NULL),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  revoked_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_verifications_one_pending_version
  ON person_verifications (profile_id, profile_version)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_verifications_one_verified_version
  ON person_verifications (profile_id, profile_version)
  WHERE status = 'verified';

CREATE INDEX IF NOT EXISTS idx_person_verifications_current
  ON person_verifications (profile_id, profile_version, status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS person_publication_reviews (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ppub_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  status TEXT NOT NULL
    CHECK (status IN ('pending_review', 'published', 'rejected', 'suspended', 'archived')),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  projection_version INTEGER CHECK (projection_version IS NULL OR projection_version > 0),
  submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_publications_one_pending_version
  ON person_publication_reviews (profile_id, profile_version)
  WHERE status = 'pending_review';

CREATE INDEX IF NOT EXISTS idx_person_publications_history
  ON person_publication_reviews (profile_id, submitted_at DESC);

-- 公开投影继续保持可重建；这些字段只用于追溯投影来源版本和失效时间。
ALTER TABLE profile_public_projections ADD COLUMN verification_valid_until TEXT
  CHECK (verification_valid_until IS NULL OR datetime(verification_valid_until) IS NOT NULL);
ALTER TABLE profile_public_projections ADD COLUMN authorization_valid_from TEXT
  CHECK (authorization_valid_from IS NULL OR datetime(authorization_valid_from) IS NOT NULL);
ALTER TABLE profile_public_projections ADD COLUMN profile_version INTEGER
  CHECK (profile_version IS NULL OR profile_version > 0);
ALTER TABLE profile_public_projections ADD COLUMN authorization_id TEXT;
ALTER TABLE profile_public_projections ADD COLUMN verification_id TEXT;
ALTER TABLE profile_public_projections ADD COLUMN publication_id TEXT;

CREATE INDEX IF NOT EXISTS idx_profile_public_verification_expiry
  ON profile_public_projections (verification_status, verification_valid_until);
