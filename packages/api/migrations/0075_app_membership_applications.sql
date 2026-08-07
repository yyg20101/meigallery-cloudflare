-- Membership-2：站内会员申请、用户状态时间线与管理员处理闭环。
--
-- 申请本身不产生会员权限；只有 app_membership_grants 成功写入后才能进入 approved。
-- 联系方式只引用账号已验证邮箱，不复制邮箱正文。数据保留期仍由 OQ-020 决定，
-- 本 migration 不创建自动清理任务，也不改变任何环境的运行时开关。

CREATE TABLE app_membership_applications (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'ama_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalog_version_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  tier_code_snapshot TEXT NOT NULL CHECK (length(tier_code_snapshot) BETWEEN 3 AND 48),
  tier_name_snapshot TEXT NOT NULL CHECK (length(trim(tier_name_snapshot)) BETWEEN 1 AND 32),
  rank_snapshot INTEGER NOT NULL CHECK (rank_snapshot BETWEEN 1 AND 1000),
  contact_method TEXT NOT NULL DEFAULT 'verified_email'
    CHECK (contact_method = 'verified_email'),
  preferred_contact_window TEXT NOT NULL
    CHECK (preferred_contact_window IN ('anytime', 'morning', 'afternoon', 'evening')),
  statement TEXT
    CHECK (statement IS NULL OR length(statement) BETWEEN 1 AND 300),
  disclosure_version TEXT NOT NULL CHECK (length(disclosure_version) BETWEEN 3 AND 80),
  disclosure_confirmed_at TEXT NOT NULL
    CHECK (
      disclosure_confirmed_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(disclosure_confirmed_at) IS NOT NULL
    ),
  status TEXT NOT NULL
    CHECK (status IN (
      'submitted', 'processing', 'needs_information',
      'approved', 'rejected', 'cancelled', 'expired'
    )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  assigned_to INTEGER REFERENCES users(id),
  information_request_code TEXT
    CHECK (
      information_request_code IS NULL
      OR information_request_code IN ('contact_window', 'application_statement', 'account_confirmation', 'other')
    ),
  information_request_message TEXT
    CHECK (information_request_message IS NULL OR length(trim(information_request_message)) BETWEEN 1 AND 240),
  decision_reason_code TEXT
    CHECK (
      decision_reason_code IS NULL
      OR decision_reason_code IN (
        'requirements_not_met', 'tier_unavailable', 'account_restricted',
        'unable_to_verify', 'user_request', 'application_stale', 'other'
      )
    ),
  decision_message TEXT
    CHECK (decision_message IS NULL OR length(trim(decision_message)) BETWEEN 1 AND 240),
  approval_request_key TEXT
    CHECK (approval_request_key IS NULL OR length(approval_request_key) BETWEEN 16 AND 128),
  approval_started_at TEXT
    CHECK (
      approval_started_at IS NULL
      OR (
        approval_started_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(approval_started_at) IS NOT NULL
      )
    ),
  grant_id TEXT UNIQUE REFERENCES app_membership_grants(id),
  submitted_at TEXT NOT NULL
    CHECK (
      submitted_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(submitted_at) IS NOT NULL
    ),
  updated_at TEXT NOT NULL
    CHECK (
      updated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(updated_at) IS NOT NULL
    ),
  resolved_at TEXT
    CHECK (
      resolved_at IS NULL
      OR (
        resolved_at GLOB '????-??-??T??:??:??.???Z'
        AND julianday(resolved_at) IS NOT NULL
      )
    ),
  FOREIGN KEY (catalog_version_id, tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id),
  CHECK ((status = 'approved') = (grant_id IS NOT NULL)),
  CHECK ((approval_request_key IS NULL) = (approval_started_at IS NULL))
);

CREATE UNIQUE INDEX idx_app_membership_applications_one_active_per_user
  ON app_membership_applications (user_id)
  WHERE status IN ('submitted', 'processing', 'needs_information');

CREATE INDEX idx_app_membership_applications_admin_queue
  ON app_membership_applications (status, submitted_at ASC, id ASC);

CREATE INDEX idx_app_membership_applications_tier_queue
  ON app_membership_applications (tier_id, status, submitted_at ASC, id ASC);

CREATE INDEX idx_app_membership_applications_assignee_queue
  ON app_membership_applications (assigned_to, status, submitted_at ASC, id ASC);

CREATE TABLE app_membership_application_events (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amae_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  application_id TEXT NOT NULL REFERENCES app_membership_applications(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'submitted', 'claimed', 'information_requested', 'resubmitted',
      'approved', 'rejected', 'cancelled', 'expired'
    )),
  from_status TEXT,
  to_status TEXT NOT NULL
    CHECK (to_status IN (
      'submitted', 'processing', 'needs_information',
      'approved', 'rejected', 'cancelled', 'expired'
    )),
  public_message TEXT NOT NULL CHECK (length(trim(public_message)) BETWEEN 1 AND 240),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('viewer', 'admin', 'system')),
  actor_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  UNIQUE (application_id, sequence)
);

CREATE INDEX idx_app_membership_application_events_timeline
  ON app_membership_application_events (application_id, sequence ASC);

CREATE TABLE app_membership_application_requests (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'amar_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  operation TEXT NOT NULL CHECK (operation IN ('submit', 'resubmit', 'cancel')),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  application_id TEXT NOT NULL REFERENCES app_membership_applications(id),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idx_app_membership_application_requests_application
  ON app_membership_application_requests (application_id, created_at DESC);
