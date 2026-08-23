-- Message-3 后台通知模板版本治理：草稿、提交、独立复核与不可变事件。
-- 现有 app_notification_template_versions 继续是投影运行时唯一模板事实；本表只承载治理状态。

ALTER TABLE app_notification_event_definitions
  ADD COLUMN template_variable_catalog_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(template_variable_catalog_json)
    AND json_type(template_variable_catalog_json) = 'array'
  );

ALTER TABLE app_notification_template_versions
  ADD COLUMN variable_allowlist_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(variable_allowlist_json)
    AND json_type(variable_allowlist_json) = 'array'
  );

-- App 1.0 只有会员发放模板开放动态变量；金币通知继续由服务端专用安全渲染器生成，
-- 其他事件保持固定文案。目录只是可用变量集合，不要求模板必须使用全部变量。
UPDATE app_notification_event_definitions
SET template_variable_catalog_json = '["membership_level","expires_at"]'
WHERE event_type = 'membership.granted';

UPDATE app_notification_template_versions
SET variable_allowlist_json = '["membership_level","expires_at"]',
    title_text = '会员权益已更新',
    summary_text = '你的「{membership_level}」会员已开通，有效期至 {expires_at}。',
    body_text = '打开会员页后会重新读取权威等级、期限和 entitlement；请勿把通知内容视为永久权益凭证。'
WHERE event_definition_id = 'nde_membership_granted'
  AND state = 'development';

CREATE TRIGGER trg_app_notification_event_variable_catalog_guard
BEFORE UPDATE OF template_variable_catalog_json ON app_notification_event_definitions
BEGIN
  SELECT RAISE(ABORT, 'notification event variable catalog is immutable');
END;

CREATE TABLE app_notification_template_change_requests (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ntr_*' AND length(id) BETWEEN 5 AND 96),
  base_template_id TEXT NOT NULL REFERENCES app_notification_template_versions(id) ON DELETE RESTRICT,
  proposed_template_id TEXT NOT NULL CHECK (proposed_template_id GLOB 'ntv_*' AND length(proposed_template_id) BETWEEN 5 AND 96),
  event_definition_id TEXT NOT NULL REFERENCES app_notification_event_definitions(id) ON DELETE RESTRICT,
  version_code TEXT NOT NULL CHECK (length(version_code) BETWEEN 1 AND 80),
  locale TEXT NOT NULL CHECK (locale = 'zh-CN'),
  region_scope TEXT NOT NULL CHECK (region_scope = 'all'),
  variable_allowlist_json TEXT NOT NULL CHECK (json_valid(variable_allowlist_json) AND json_type(variable_allowlist_json) = 'array'),
  title_text TEXT NOT NULL CHECK (length(trim(title_text)) BETWEEN 1 AND 80),
  summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) BETWEEN 1 AND 160),
  body_text TEXT NOT NULL CHECK (length(trim(body_text)) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'executing', 'approved', 'rejected', 'stale')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT NOT NULL CHECK (length(mutation_token) BETWEEN 16 AND 96),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  review_note TEXT CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 2 AND 500),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  submitted_at TEXT CHECK (submitted_at IS NULL OR julianday(submitted_at) IS NOT NULL),
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR julianday(reviewed_at) IS NOT NULL),
  UNIQUE (proposed_template_id),
  UNIQUE (event_definition_id, version_code, locale, region_scope),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);

CREATE INDEX idx_app_notification_template_requests_status
  ON app_notification_template_change_requests(status, updated_at DESC, id DESC);
CREATE UNIQUE INDEX idx_app_notification_template_requests_pending
  ON app_notification_template_change_requests(base_template_id)
  WHERE status IN ('draft', 'pending_review', 'executing');

CREATE TABLE app_notification_template_change_events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'nte_*' AND length(id) BETWEEN 5 AND 96),
  request_id TEXT NOT NULL REFERENCES app_notification_template_change_requests(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('draft_saved', 'submitted', 'executing', 'approved', 'rejected', 'stale')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  safe_summary_json TEXT NOT NULL CHECK (json_valid(safe_summary_json) AND json_type(safe_summary_json) = 'object'),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (request_id, sequence)
);

CREATE INDEX idx_app_notification_template_events_request
  ON app_notification_template_change_events(request_id, sequence ASC);

CREATE TRIGGER trg_app_notification_template_requests_guard_update
BEFORE UPDATE ON app_notification_template_change_requests
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.base_template_id <> OLD.base_template_id
      OR NEW.event_definition_id <> OLD.event_definition_id
      OR NEW.requested_by <> OLD.requested_by
      OR NEW.created_at <> OLD.created_at
    THEN RAISE(ABORT, 'notification template request identity is immutable')
  END;
  SELECT CASE
    WHEN NEW.version <> OLD.version + 1
    THEN RAISE(ABORT, 'notification template request version must advance by one')
  END;
  SELECT CASE
    WHEN NOT (
      (OLD.status = 'draft' AND NEW.status IN ('draft', 'pending_review'))
      OR (OLD.status = 'pending_review' AND NEW.status IN ('executing', 'rejected', 'stale'))
      OR (OLD.status = 'executing' AND NEW.status IN ('approved', 'stale'))
    )
    THEN RAISE(ABORT, 'invalid notification template request transition')
  END;
END;

CREATE TRIGGER trg_app_notification_template_requests_guard_delete
BEFORE DELETE ON app_notification_template_change_requests
BEGIN
  SELECT RAISE(ABORT, 'notification template requests are append-preserved');
END;

CREATE TRIGGER trg_app_notification_template_events_guard_update
BEFORE UPDATE ON app_notification_template_change_events
BEGIN
  SELECT RAISE(ABORT, 'notification template events are immutable');
END;

CREATE TRIGGER trg_app_notification_template_events_guard_delete
BEFORE DELETE ON app_notification_template_change_events
BEGIN
  SELECT RAISE(ABORT, 'notification template events are immutable');
END;

CREATE TRIGGER trg_app_notification_template_versions_content_guard
BEFORE UPDATE ON app_notification_template_versions
WHEN NEW.id <> OLD.id
  OR NEW.event_definition_id <> OLD.event_definition_id
  OR NEW.version_code <> OLD.version_code
  OR NEW.locale <> OLD.locale
  OR NEW.region_scope <> OLD.region_scope
  OR NEW.variable_allowlist_json <> OLD.variable_allowlist_json
  OR NEW.title_text <> OLD.title_text
  OR NEW.summary_text <> OLD.summary_text
  OR NEW.body_text <> OLD.body_text
  OR NEW.approved_by IS NOT OLD.approved_by
  OR NEW.effective_at IS NOT OLD.effective_at
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'notification template version content is immutable');
END;

CREATE TRIGGER trg_app_notification_template_versions_state_guard
BEFORE UPDATE OF state ON app_notification_template_versions
WHEN NOT (
  OLD.state IN ('development', 'published')
  AND NEW.state = 'retired'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid notification template version transition');
END;

CREATE TRIGGER trg_app_notification_template_versions_guard_delete
BEFORE DELETE ON app_notification_template_versions
BEGIN
  SELECT RAISE(ABORT, 'notification template versions are immutable');
END;

CREATE TABLE app_notification_duplicate_suppressions (
  id TEXT PRIMARY KEY
    CHECK (id GLOB 'nds_*' AND length(id) BETWEEN 5 AND 96),
  existing_outbox_id TEXT NOT NULL REFERENCES app_notification_outbox(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL REFERENCES app_notification_policies(id) ON DELETE RESTRICT,
  event_definition_id TEXT NOT NULL REFERENCES app_notification_event_definitions(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL CHECK (julianday(observed_at) IS NOT NULL)
);

CREATE INDEX idx_app_notification_duplicate_suppressions_outbox
  ON app_notification_duplicate_suppressions(existing_outbox_id, observed_at DESC, id DESC);

CREATE TRIGGER trg_app_notification_outbox_duplicate_observed
BEFORE INSERT ON app_notification_outbox
WHEN EXISTS (
  SELECT 1
  FROM app_notification_outbox existing
  WHERE existing.account_id = NEW.account_id
    AND existing.event_type = NEW.event_type
    AND existing.event_ref = NEW.event_ref
)
BEGIN
  INSERT INTO app_notification_duplicate_suppressions (
    id, existing_outbox_id, policy_id, event_definition_id, observed_at
  )
  SELECT
    'nds_' || lower(hex(randomblob(16))),
    existing.id,
    NEW.policy_id,
    NEW.event_definition_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM app_notification_outbox existing
  WHERE existing.account_id = NEW.account_id
    AND existing.event_type = NEW.event_type
    AND existing.event_ref = NEW.event_ref
  LIMIT 1;
END;

CREATE TRIGGER trg_app_notification_duplicate_suppressions_guard_update
BEFORE UPDATE ON app_notification_duplicate_suppressions
BEGIN
  SELECT RAISE(ABORT, 'notification duplicate suppressions are immutable');
END;

CREATE TRIGGER trg_app_notification_duplicate_suppressions_guard_delete
BEFORE DELETE ON app_notification_duplicate_suppressions
BEGIN
  SELECT RAISE(ABORT, 'notification duplicate suppressions are immutable');
END;
