-- Membership-4：版本化会员目录与 typed entitlement 管理平面。
--
-- 本 migration 只建立开发和复核所需结构：
-- - 不修改 Wrangler、运行时目录引用或任何会员开关；
-- - 不把任一目录自动标记为 production ready；
-- - 不修改既有 grant，不迁移账号，不冻结 OQ-014 的真实权益数值；
-- - 已发布目录及其 tier/entitlement 内容不可原地修改；
-- - 目录发布必须由非发起人的有效 Owner 独立复核。

CREATE TABLE app_membership_catalog_metadata (
  catalog_version_id TEXT PRIMARY KEY
    REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  base_catalog_version_id TEXT
    REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  change_summary TEXT NOT NULL CHECK (length(trim(change_summary)) BETWEEN 2 AND 500),
  production_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (production_decision_status IN ('unresolved', 'approved')),
  content_hash TEXT
    CHECK (
      content_hash IS NULL
      OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*')
    ),
  mutation_token TEXT UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  published_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  published_at TEXT CHECK (published_at IS NULL OR julianday(published_at) IS NOT NULL),
  CHECK (published_by IS NULL OR published_by <> created_by)
);

INSERT INTO app_membership_catalog_metadata (
  catalog_version_id,
  base_catalog_version_id,
  lock_version,
  change_summary,
  production_decision_status,
  content_hash,
  mutation_token,
  created_by,
  updated_by,
  published_by,
  created_at,
  updated_at,
  published_at
)
SELECT
  id,
  NULL,
  1,
  '历史 migration 创建的开发目录；基线来源待人工确认',
  'unresolved',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  created_at,
  created_at,
  NULL
FROM app_membership_catalog_versions;

CREATE TABLE app_membership_catalog_commands (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amcc_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation TEXT NOT NULL
    CHECK (operation IN (
      'create_catalog', 'update_catalog', 'replace_tiers',
      'upsert_entitlement', 'submit_publish', 'decide_publish'
    )),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  catalog_version_id TEXT NOT NULL
    REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  result_lock_version INTEGER NOT NULL CHECK (result_lock_version >= 1),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (admin_id, idempotency_key)
);

CREATE INDEX idx_app_membership_catalog_commands_catalog
  ON app_membership_catalog_commands (catalog_version_id, created_at DESC, id DESC);

CREATE TRIGGER trg_app_membership_catalog_commands_immutable_update
BEFORE UPDATE ON app_membership_catalog_commands
BEGIN
  SELECT RAISE(ABORT, 'app_membership_catalog_commands are immutable');
END;

CREATE TRIGGER trg_app_membership_catalog_commands_immutable_delete
BEFORE DELETE ON app_membership_catalog_commands
BEGIN
  SELECT RAISE(ABORT, 'app_membership_catalog_commands are immutable');
END;

CREATE TABLE app_membership_catalog_publish_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amcpr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  catalog_version_id TEXT NOT NULL
    REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  catalog_lock_version INTEGER NOT NULL CHECK (catalog_lock_version >= 1),
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  requested_production_ready INTEGER NOT NULL DEFAULT 0 CHECK (requested_production_ready IN (0, 1)),
  validation_report_json TEXT NOT NULL
    CHECK (json_valid(validation_report_json) AND json_type(validation_report_json) = 'object'),
  submit_note TEXT NOT NULL CHECK (length(trim(submit_note)) BETWEEN 2 AND 500),
  status TEXT NOT NULL
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'stale', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  request_idempotency_key TEXT NOT NULL
    CHECK (
      length(request_idempotency_key) BETWEEN 16 AND 128
      AND request_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 2 AND 500),
  review_note_sha256 TEXT
    CHECK (
      review_note_sha256 IS NULL
      OR (length(review_note_sha256) = 64 AND review_note_sha256 NOT GLOB '*[^a-f0-9]*')
    ),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  UNIQUE (requested_by, request_idempotency_key),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
  CHECK (
    status = 'pending_review'
    OR (reviewed_by IS NOT NULL AND review_note IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_app_membership_catalog_publish_request_active
  ON app_membership_catalog_publish_requests (catalog_version_id)
  WHERE status = 'pending_review';

CREATE INDEX idx_app_membership_catalog_publish_request_queue
  ON app_membership_catalog_publish_requests (status, created_at ASC, id ASC);

CREATE TABLE app_membership_catalog_publish_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amcpe_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  request_id TEXT NOT NULL
    REFERENCES app_membership_catalog_publish_requests(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted', 'approved', 'rejected', 'content_stale')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  result_code TEXT NOT NULL CHECK (result_code IN ('pending_review', 'approved', 'rejected', 'content_stale')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, sequence)
);

CREATE TRIGGER trg_app_membership_catalog_publish_events_immutable_update
BEFORE UPDATE ON app_membership_catalog_publish_events
BEGIN
  SELECT RAISE(ABORT, 'app_membership_catalog_publish_events are immutable');
END;

CREATE TRIGGER trg_app_membership_catalog_publish_events_immutable_delete
BEFORE DELETE ON app_membership_catalog_publish_events
BEGIN
  SELECT RAISE(ABORT, 'app_membership_catalog_publish_events are immutable');
END;

CREATE TABLE app_membership_catalog_publish_decisions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amcpd_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  request_id TEXT NOT NULL
    REFERENCES app_membership_catalog_publish_requests(id) ON DELETE RESTRICT,
  reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  idempotency_key TEXT NOT NULL
    CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  result_status TEXT NOT NULL CHECK (result_status IN ('approved', 'rejected', 'stale')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (reviewer_id, idempotency_key)
);

CREATE TRIGGER trg_app_membership_catalog_publish_decisions_immutable_update
BEFORE UPDATE ON app_membership_catalog_publish_decisions
BEGIN
  SELECT RAISE(ABORT, 'app_membership_catalog_publish_decisions are immutable');
END;

CREATE TRIGGER trg_app_membership_catalog_publish_decisions_immutable_delete
BEFORE DELETE ON app_membership_catalog_publish_decisions
BEGIN
  SELECT RAISE(ABORT, 'app_membership_catalog_publish_decisions are immutable');
END;

-- 已发布或已退役的目录字段不可原地编辑；development → published 是唯一发布路径。
CREATE TRIGGER trg_app_membership_catalog_version_immutable_fields
BEFORE UPDATE OF version_code, effective_at, timezone, minimum_client_version
ON app_membership_catalog_versions
WHEN OLD.state <> 'development'
BEGIN
  SELECT RAISE(ABORT, 'published membership catalogs are immutable');
END;

CREATE TRIGGER trg_app_membership_catalog_version_state_transition
BEFORE UPDATE OF state, production_ready ON app_membership_catalog_versions
WHEN NOT (
  (OLD.state = 'development' AND NEW.state = 'development' AND NEW.production_ready = 0)
  OR (OLD.state = 'development' AND NEW.state = 'published')
  OR (OLD.state = 'published' AND NEW.state = 'published' AND NEW.production_ready = OLD.production_ready)
  OR (OLD.state = 'published' AND NEW.state = 'retired' AND NEW.production_ready = 0)
  OR (OLD.state = 'retired' AND NEW.state = 'retired' AND NEW.production_ready = OLD.production_ready)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid membership catalog state transition');
END;

CREATE TRIGGER trg_app_membership_catalog_version_immutable_delete
BEFORE DELETE ON app_membership_catalog_versions
BEGIN
  SELECT RAISE(ABORT, 'membership catalog versions are immutable facts');
END;

-- 一旦存在后继目录，基线内容必须保持稳定，避免比较与发布校验随基线漂移。
CREATE TRIGGER trg_app_membership_catalog_version_dependent_update
BEFORE UPDATE OF version_code, effective_at, timezone, minimum_client_version
ON app_membership_catalog_versions
WHEN EXISTS (
  SELECT 1 FROM app_membership_catalog_metadata child
  WHERE child.base_catalog_version_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'membership catalog baseline has dependent versions');
END;

CREATE TRIGGER trg_app_membership_catalog_metadata_identity_immutable
BEFORE UPDATE OF catalog_version_id, base_catalog_version_id, created_by, created_at
ON app_membership_catalog_metadata
WHEN NEW.catalog_version_id <> OLD.catalog_version_id
  OR NEW.base_catalog_version_id IS NOT OLD.base_catalog_version_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'membership catalog metadata identity is immutable');
END;

CREATE TRIGGER trg_app_membership_catalog_metadata_immutable_delete
BEFORE DELETE ON app_membership_catalog_metadata
BEGIN
  SELECT RAISE(ABORT, 'membership catalog metadata are immutable facts');
END;

CREATE TRIGGER trg_app_membership_tiers_published_insert
BEFORE INSERT ON app_membership_tiers
WHEN NOT EXISTS (
  SELECT 1 FROM app_membership_catalog_versions catalog
  WHERE catalog.id = NEW.catalog_version_id AND catalog.state = 'development'
)
BEGIN
  SELECT RAISE(ABORT, 'published membership catalog tiers are immutable');
END;

CREATE TRIGGER trg_app_membership_tiers_published_update
BEFORE UPDATE ON app_membership_tiers
WHEN NOT EXISTS (
    SELECT 1 FROM app_membership_catalog_versions catalog
    WHERE catalog.id = OLD.catalog_version_id AND catalog.state = 'development'
  )
  OR NOT EXISTS (
    SELECT 1 FROM app_membership_catalog_versions catalog
    WHERE catalog.id = NEW.catalog_version_id AND catalog.state = 'development'
  )
BEGIN
  SELECT RAISE(ABORT, 'published membership catalog tiers are immutable');
END;

CREATE TRIGGER trg_app_membership_tiers_published_delete
BEFORE DELETE ON app_membership_tiers
WHEN NOT EXISTS (
  SELECT 1 FROM app_membership_catalog_versions catalog
  WHERE catalog.id = OLD.catalog_version_id AND catalog.state = 'development'
)
BEGIN
  SELECT RAISE(ABORT, 'published membership catalog tiers are immutable');
END;

CREATE TRIGGER trg_app_entitlement_definitions_published_insert
BEFORE INSERT ON app_entitlement_definitions
WHEN NOT EXISTS (
  SELECT 1 FROM app_membership_catalog_versions catalog
  WHERE catalog.id = NEW.catalog_version_id AND catalog.state = 'development'
)
BEGIN
  SELECT RAISE(ABORT, 'published entitlement definitions are immutable');
END;

CREATE TRIGGER trg_app_entitlement_definitions_published_update
BEFORE UPDATE ON app_entitlement_definitions
WHEN NOT EXISTS (
    SELECT 1 FROM app_membership_catalog_versions catalog
    WHERE catalog.id = OLD.catalog_version_id AND catalog.state = 'development'
  )
  OR NOT EXISTS (
    SELECT 1 FROM app_membership_catalog_versions catalog
    WHERE catalog.id = NEW.catalog_version_id AND catalog.state = 'development'
  )
BEGIN
  SELECT RAISE(ABORT, 'published entitlement definitions are immutable');
END;

CREATE TRIGGER trg_app_entitlement_definitions_published_delete
BEFORE DELETE ON app_entitlement_definitions
WHEN NOT EXISTS (
  SELECT 1 FROM app_membership_catalog_versions catalog
  WHERE catalog.id = OLD.catalog_version_id AND catalog.state = 'development'
)
BEGIN
  SELECT RAISE(ABORT, 'published entitlement definitions are immutable');
END;

CREATE TRIGGER trg_app_membership_tier_entitlements_published_insert
BEFORE INSERT ON app_membership_tier_entitlements
WHEN NOT EXISTS (
  SELECT 1 FROM app_membership_catalog_versions catalog
  WHERE catalog.id = NEW.catalog_version_id AND catalog.state = 'development'
)
BEGIN
  SELECT RAISE(ABORT, 'published tier entitlements are immutable');
END;

CREATE TRIGGER trg_app_membership_tier_entitlements_published_update
BEFORE UPDATE ON app_membership_tier_entitlements
WHEN NOT EXISTS (
    SELECT 1 FROM app_membership_catalog_versions catalog
    WHERE catalog.id = OLD.catalog_version_id AND catalog.state = 'development'
  )
  OR NOT EXISTS (
    SELECT 1 FROM app_membership_catalog_versions catalog
    WHERE catalog.id = NEW.catalog_version_id AND catalog.state = 'development'
  )
BEGIN
  SELECT RAISE(ABORT, 'published tier entitlements are immutable');
END;

CREATE TRIGGER trg_app_membership_tier_entitlements_published_delete
BEFORE DELETE ON app_membership_tier_entitlements
WHEN NOT EXISTS (
  SELECT 1 FROM app_membership_catalog_versions catalog
  WHERE catalog.id = OLD.catalog_version_id AND catalog.state = 'development'
)
BEGIN
  SELECT RAISE(ABORT, 'published tier entitlements are immutable');
END;

-- 即使目录仍标记为 development，只要已经被 grant、会员申请或后继目录引用，也必须通过新版本演进。
CREATE TRIGGER trg_app_membership_tiers_referenced_insert
BEFORE INSERT ON app_membership_tiers
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id = NEW.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id = NEW.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id = NEW.catalog_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced membership catalog tiers are immutable');
END;

CREATE TRIGGER trg_app_membership_tiers_referenced_update
BEFORE UPDATE ON app_membership_tiers
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced membership catalog tiers are immutable');
END;

CREATE TRIGGER trg_app_membership_tiers_referenced_delete
BEFORE DELETE ON app_membership_tiers
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id = OLD.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id = OLD.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id = OLD.catalog_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced membership catalog tiers are immutable');
END;

CREATE TRIGGER trg_app_entitlement_definitions_referenced_insert
BEFORE INSERT ON app_entitlement_definitions
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id = NEW.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id = NEW.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id = NEW.catalog_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced entitlement definitions are immutable');
END;

CREATE TRIGGER trg_app_entitlement_definitions_referenced_update
BEFORE UPDATE ON app_entitlement_definitions
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced entitlement definitions are immutable');
END;

CREATE TRIGGER trg_app_entitlement_definitions_referenced_delete
BEFORE DELETE ON app_entitlement_definitions
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id = OLD.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id = OLD.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id = OLD.catalog_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced entitlement definitions are immutable');
END;

CREATE TRIGGER trg_app_membership_tier_entitlements_referenced_insert
BEFORE INSERT ON app_membership_tier_entitlements
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id = NEW.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id = NEW.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id = NEW.catalog_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced tier entitlements are immutable');
END;

CREATE TRIGGER trg_app_membership_tier_entitlements_referenced_update
BEFORE UPDATE ON app_membership_tier_entitlements
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id IN (OLD.catalog_version_id, NEW.catalog_version_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced tier entitlements are immutable');
END;

CREATE TRIGGER trg_app_membership_tier_entitlements_referenced_delete
BEFORE DELETE ON app_membership_tier_entitlements
WHEN EXISTS (
    SELECT 1 FROM app_membership_grants grant_row
    WHERE grant_row.catalog_version_id = OLD.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_applications application
    WHERE application.catalog_version_id = OLD.catalog_version_id
  )
  OR EXISTS (
    SELECT 1 FROM app_membership_catalog_metadata child
    WHERE child.base_catalog_version_id = OLD.catalog_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced tier entitlements are immutable');
END;
