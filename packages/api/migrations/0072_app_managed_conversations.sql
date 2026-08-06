-- Message-1：默认关闭的 App 平台话题 HTTP 权威闭环。
--
-- 本 migration 只创建开发数据结构和一个新的 development 会员目录版本：
-- - 不启用任何运行时开关；
-- - 不创建账号、会员 grant 或会话 seed；
-- - 不迁移旧 Web 私信；
-- - 不代表内容审核、举报拉黑、实时通道或生产门禁已经完成。

INSERT INTO app_membership_catalog_versions (
  id,
  version_code,
  state,
  production_ready,
  effective_at,
  timezone,
  minimum_client_version
) VALUES (
  'amc_app_1_0_message_1_dev_1',
  'app-1.0-message-1-dev-1',
  'development',
  0,
  '2026-08-06T00:00:00.000Z',
  'Asia/Shanghai',
  '1.0'
);

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
  unit_label,
  created_at
)
SELECT
  'amc_app_1_0_message_1_dev_1',
  entitlement_key,
  schema_version,
  value_type,
  default_value_json,
  merge_strategy,
  period_rule,
  client_capability,
  display_name,
  description,
  unit_label,
  created_at
FROM app_entitlement_definitions
WHERE catalog_version_id = 'amc_app_1_0_draft_1';

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
  'amc_app_1_0_message_1_dev_1',
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

INSERT INTO app_membership_tier_entitlements (
  catalog_version_id,
  tier_id,
  entitlement_key,
  value_json,
  availability
)
SELECT
  'amc_app_1_0_message_1_dev_1',
  tier_id,
  entitlement_key,
  value_json,
  CASE
    WHEN entitlement_key IN (
      'direct_message.create',
      'direct_message.send',
      'direct_message.new_threads_per_day'
    ) THEN 'available'
    ELSE 'planned'
  END
FROM app_membership_tier_entitlements
WHERE catalog_version_id = 'amc_app_1_0_draft_1';

CREATE TABLE app_conversations (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'cv_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 80
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES person_profiles(id) ON DELETE RESTRICT,
  operation_mode TEXT NOT NULL DEFAULT 'platform_managed'
    CHECK (operation_mode IN ('platform_managed')),
  receiver_label TEXT NOT NULL DEFAULT '平台运营接收'
    CHECK (length(trim(receiver_label)) BETWEEN 1 AND 80),
  disclosure_version TEXT NOT NULL
    CHECK (length(disclosure_version) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'restricted', 'closed')),
  queue_status TEXT NOT NULL DEFAULT 'awaiting_viewer'
    CHECK (queue_status IN ('awaiting_viewer', 'awaiting_operator', 'closed')),
  last_sequence INTEGER NOT NULL DEFAULT 1 CHECK (last_sequence >= 1),
  viewer_read_sequence INTEGER NOT NULL DEFAULT 1
    CHECK (viewer_read_sequence BETWEEN 0 AND last_sequence),
  operator_read_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (operator_read_sequence BETWEEN 0 AND last_sequence),
  last_message_at TEXT NOT NULL
    CHECK (julianday(last_message_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  closed_at TEXT CHECK (closed_at IS NULL OR julianday(closed_at) IS NOT NULL),
  UNIQUE (account_id, profile_id)
);

CREATE INDEX idx_app_conversations_account_updated
  ON app_conversations (account_id, updated_at DESC, id ASC);

CREATE INDEX idx_app_conversations_queue_updated
  ON app_conversations (queue_status, updated_at ASC, id ASC);

CREATE TABLE app_conversation_quota_consumptions (
  conversation_id TEXT PRIMARY KEY REFERENCES app_conversations(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_grant_id TEXT NOT NULL REFERENCES app_membership_grants(id) ON DELETE RESTRICT,
  catalog_version_id TEXT NOT NULL REFERENCES app_membership_catalog_versions(id),
  tier_id TEXT NOT NULL,
  entitlement_key TEXT NOT NULL DEFAULT 'direct_message.new_threads_per_day'
    CHECK (entitlement_key = 'direct_message.new_threads_per_day'),
  period_key TEXT NOT NULL
    CHECK (period_key GLOB '????-??-??'),
  amount INTEGER NOT NULL DEFAULT 1 CHECK (amount = 1),
  consumed_at TEXT NOT NULL CHECK (julianday(consumed_at) IS NOT NULL),
  FOREIGN KEY (catalog_version_id, tier_id)
    REFERENCES app_membership_tiers(catalog_version_id, tier_id)
);

CREATE INDEX idx_app_conversation_quota_account_period
  ON app_conversation_quota_consumptions (
    account_id,
    entitlement_key,
    period_key,
    consumed_at ASC
  );

CREATE TABLE app_conversation_messages (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'msg_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 6 AND 80
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  sender_type TEXT NOT NULL
    CHECK (sender_type IN ('viewer', 'platform_operator', 'system')),
  client_message_id TEXT NOT NULL
    CHECK (
      client_message_id NOT GLOB '*[^A-Za-z0-9._-]*'
      AND length(client_message_id) BETWEEN 8 AND 96
    ),
  content_type TEXT NOT NULL CHECK (content_type IN ('text', 'system')),
  body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 1000),
  body_sha256 TEXT NOT NULL
    CHECK (
      length(body_sha256) = 64
      AND body_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'review_pending', 'rejected', 'recalled')),
  actor_account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  recalled_at TEXT CHECK (recalled_at IS NULL OR julianday(recalled_at) IS NOT NULL),
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, client_message_id),
  CHECK (
    (sender_type = 'viewer' AND actor_account_id IS NOT NULL AND actor_admin_id IS NULL AND content_type = 'text')
    OR (sender_type = 'platform_operator' AND actor_account_id IS NULL AND actor_admin_id IS NOT NULL AND content_type = 'text')
    OR (sender_type = 'system' AND actor_account_id IS NULL AND actor_admin_id IS NULL AND content_type = 'system')
  )
);

CREATE INDEX idx_app_conversation_messages_sequence
  ON app_conversation_messages (conversation_id, sequence ASC);

CREATE INDEX idx_app_conversation_messages_actor_time
  ON app_conversation_messages (actor_admin_id, created_at DESC)
  WHERE actor_admin_id IS NOT NULL;

CREATE TABLE app_messaging_idempotency (
  actor_scope TEXT NOT NULL
    CHECK (length(actor_scope) BETWEEN 3 AND 96),
  operation TEXT NOT NULL
    CHECK (operation IN ('conversation_create', 'viewer_message_send', 'operator_message_send')),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  conversation_id TEXT NOT NULL REFERENCES app_conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES app_conversation_messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (actor_scope, operation, idempotency_key)
);

CREATE INDEX idx_app_messaging_idempotency_conversation
  ON app_messaging_idempotency (conversation_id, created_at DESC);
