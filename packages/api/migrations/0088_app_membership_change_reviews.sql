-- Membership-3：App 会员发放/续期/撤销的独立复核与原子执行。
--
-- 本 migration 只创建策略就绪的数据结构，不写入任何策略 seed：
-- - 没有 published + approved 策略时，服务端保守要求所有变更独立复核；
-- - 策略阈值未来可通过独立发布流程调整，不需要升级 App；
-- - 复核申请不产生会员权限，只有 approved 且实际 grant/revocation 写入后才生效；
-- - 申请人和复核人必须是不同的有效管理员；
-- - 不改变现有环境开关，不执行 migration，不接入支付或批量发放。

CREATE TABLE app_membership_review_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amrp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  version_code TEXT NOT NULL UNIQUE
    CHECK (
      version_code NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(version_code) BETWEEN 3 AND 80
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  risk_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (risk_decision_status IN ('unresolved', 'approved')),
  review_mode TEXT NOT NULL DEFAULT 'review_all'
    CHECK (review_mode IN ('review_all', 'risk_based')),
  grant_rank_threshold INTEGER
    CHECK (grant_rank_threshold IS NULL OR grant_rank_threshold BETWEEN 1 AND 1000),
  grant_duration_days_threshold INTEGER
    CHECK (grant_duration_days_threshold IS NULL OR grant_duration_days_threshold BETWEEN 1 AND 366),
  review_lower_rank_grant INTEGER NOT NULL DEFAULT 1 CHECK (review_lower_rank_grant IN (0, 1)),
  review_revocation INTEGER NOT NULL DEFAULT 1 CHECK (review_revocation IN (0, 1)),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  published_at TEXT CHECK (published_at IS NULL OR julianday(published_at) IS NOT NULL),
  CHECK (
    state <> 'published'
    OR (
      risk_decision_status = 'approved'
      AND published_at IS NOT NULL
    )
  ),
  CHECK (production_ready = 0 OR state = 'published')
);

CREATE UNIQUE INDEX idx_app_membership_review_policy_published
  ON app_membership_review_policies (state)
  WHERE state = 'published';

CREATE TABLE app_membership_change_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amcr_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  operation TEXT NOT NULL CHECK (operation IN ('grant', 'revoke')),
  policy_id TEXT REFERENCES app_membership_review_policies(id) ON DELETE RESTRICT,
  policy_version_code TEXT NOT NULL CHECK (length(policy_version_code) BETWEEN 3 AND 80),
  policy_mode TEXT NOT NULL
    CHECK (policy_mode IN ('conservative_review_all', 'review_all', 'risk_based')),
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  catalog_version_id TEXT NOT NULL REFERENCES app_membership_catalog_versions(id) ON DELETE RESTRICT,
  tier_id TEXT,
  tier_code_snapshot TEXT,
  tier_name_snapshot TEXT,
  rank_snapshot INTEGER CHECK (rank_snapshot IS NULL OR rank_snapshot BETWEEN 1 AND 1000),
  grant_action TEXT CHECK (grant_action IS NULL OR grant_action IN ('grant', 'renew')),
  starts_at TEXT CHECK (starts_at IS NULL OR julianday(starts_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 366),
  target_grant_id TEXT REFERENCES app_membership_grants(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL
    CHECK (reason_code IN (
      'manual_review', 'customer_support', 'promotion', 'compensation',
      'admin_correction', 'customer_request', 'account_restriction', 'policy_enforcement'
    )),
  user_visible_note TEXT NOT NULL CHECK (length(trim(user_visible_note)) BETWEEN 1 AND 240),
  internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 1000),
  business_reference TEXT NOT NULL CHECK (length(trim(business_reference)) BETWEEN 3 AND 100),
  source_type TEXT NOT NULL CHECK (source_type IN ('direct_admin', 'membership_application')),
  source_application_id TEXT REFERENCES app_membership_applications(id) ON DELETE RESTRICT,
  source_application_version INTEGER
    CHECK (source_application_version IS NULL OR source_application_version >= 1),
  baseline_grant_id TEXT REFERENCES app_membership_grants(id) ON DELETE RESTRICT,
  baseline_rank INTEGER NOT NULL DEFAULT 0 CHECK (baseline_rank BETWEEN 0 AND 1000),
  baseline_expires_at TEXT CHECK (baseline_expires_at IS NULL OR julianday(baseline_expires_at) IS NOT NULL),
  risk_codes_json TEXT NOT NULL CHECK (json_valid(risk_codes_json) AND json_type(risk_codes_json) = 'array'),
  status TEXT NOT NULL
    CHECK (status IN ('pending_review', 'executing', 'approved', 'rejected', 'stale', 'cancelled')),
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
  result_grant_id TEXT REFERENCES app_membership_grants(id) ON DELETE RESTRICT,
  mutation_token TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  applied_at TEXT CHECK (applied_at IS NULL OR julianday(applied_at) IS NOT NULL),
  UNIQUE (requested_by, request_idempotency_key),
  CHECK (
    (operation = 'grant'
      AND tier_id IS NOT NULL
      AND tier_code_snapshot IS NOT NULL
      AND tier_name_snapshot IS NOT NULL
      AND rank_snapshot IS NOT NULL
      AND grant_action IS NOT NULL
      AND starts_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND duration_days IS NOT NULL
      AND target_grant_id IS NULL)
    OR
    (operation = 'revoke'
      AND tier_id IS NULL
      AND tier_code_snapshot IS NULL
      AND tier_name_snapshot IS NULL
      AND rank_snapshot IS NULL
      AND grant_action IS NULL
      AND starts_at IS NULL
      AND expires_at IS NULL
      AND duration_days IS NULL
      AND target_grant_id IS NOT NULL)
  ),
  CHECK (
    (source_type = 'direct_admin' AND source_application_id IS NULL AND source_application_version IS NULL)
    OR
    (source_type = 'membership_application' AND source_application_id IS NOT NULL AND source_application_version IS NOT NULL)
  ),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
  CHECK (
    status NOT IN ('approved', 'rejected', 'stale')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL)
  ),
  CHECK (
    status <> 'approved'
    OR (
      applied_at IS NOT NULL
      AND mutation_token IS NOT NULL
      AND (
        (operation = 'grant' AND result_grant_id IS NOT NULL)
        OR operation = 'revoke'
      )
    )
  ),
  FOREIGN KEY (catalog_version_id, tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id)
);

CREATE INDEX idx_app_membership_change_requests_queue
  ON app_membership_change_requests (status, created_at ASC, id ASC);
CREATE INDEX idx_app_membership_change_requests_account
  ON app_membership_change_requests (target_user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_app_membership_change_requests_active_business_ref
  ON app_membership_change_requests (target_user_id, operation, business_reference)
  WHERE status IN ('pending_review', 'executing', 'approved');
CREATE UNIQUE INDEX idx_app_membership_change_requests_active_application
  ON app_membership_change_requests (source_application_id)
  WHERE source_application_id IS NOT NULL AND status IN ('pending_review', 'executing', 'approved');

CREATE TABLE app_membership_change_request_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amce_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  request_id TEXT NOT NULL REFERENCES app_membership_change_requests(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted', 'approved', 'rejected', 'execution_stale')),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  result_code TEXT NOT NULL CHECK (result_code IN ('pending_review', 'approved', 'rejected', 'account_changed')),
  result_grant_id TEXT REFERENCES app_membership_grants(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, sequence)
);

CREATE TRIGGER trg_app_membership_change_request_events_immutable_update
BEFORE UPDATE ON app_membership_change_request_events
BEGIN
  SELECT RAISE(ABORT, 'app_membership_change_request_events are immutable');
END;

CREATE TRIGGER trg_app_membership_change_request_events_immutable_delete
BEFORE DELETE ON app_membership_change_request_events
BEGIN
  SELECT RAISE(ABORT, 'app_membership_change_request_events are immutable');
END;

CREATE TABLE app_membership_change_review_decisions (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amcd_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 96
    ),
  request_id TEXT NOT NULL REFERENCES app_membership_change_requests(id) ON DELETE RESTRICT,
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
  result_grant_id TEXT REFERENCES app_membership_grants(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (reviewer_id, idempotency_key)
);

CREATE TRIGGER trg_app_membership_change_review_decisions_immutable_update
BEFORE UPDATE ON app_membership_change_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'app_membership_change_review_decisions are immutable');
END;

CREATE TRIGGER trg_app_membership_change_review_decisions_immutable_delete
BEFORE DELETE ON app_membership_change_review_decisions
BEGIN
  SELECT RAISE(ABORT, 'app_membership_change_review_decisions are immutable');
END;
