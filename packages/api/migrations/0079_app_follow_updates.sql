-- App Interaction-3：关注对象公开更新流与站内通知投影开发基线。
--
-- 本 migration 不复制人物内容、不回填历史更新、不生成用户通知，也不启用任何
-- Wrangler 环境开关。更新事实继续以 person_publication_reviews 为唯一来源；只有
-- 关注建立之后、策略生效之后且当前仍满足公开资格的 published 记录可以被读取或投影。

CREATE TABLE app_follow_update_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'fupol_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 7 AND 96
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  feed_enabled INTEGER NOT NULL DEFAULT 0 CHECK (feed_enabled IN (0, 1)),
  notification_projection_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (notification_projection_enabled IN (0, 1)),
  effective_at TEXT NOT NULL
    CHECK (
      effective_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(effective_at) IS NOT NULL
    ),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  CHECK (production_ready = 0 OR state = 'published')
);

INSERT INTO app_follow_update_policies (
  id,
  state,
  production_ready,
  feed_enabled,
  notification_projection_enabled,
  effective_at,
  created_at
) VALUES (
  'fupol_app_1_0_interaction_3_dev_1',
  'development',
  0,
  1,
  1,
  '2026-08-09T00:00:00.000Z',
  '2026-08-09T00:00:00.000Z'
);

-- 关注页从账号关系反查人物发布事件；通知投影使用同一查询边界。
CREATE INDEX idx_app_viewer_interactions_profile_followers
  ON app_viewer_interactions (
    profile_id,
    interaction_type,
    created_at,
    account_id
  );

CREATE INDEX idx_person_publications_follow_updates
  ON person_publication_reviews (
    profile_id,
    status,
    reviewed_at DESC,
    id DESC
  );

-- Message-3 已预留该事件定义；本阶段只激活定义并增加固定 development 模板。
-- 通知总策略 generation_enabled 和运行时开关仍保持关闭，因此 migration 本身不会发信。
UPDATE app_notification_event_definitions
SET active = 1
WHERE id = 'nde_interaction_followed_profile_updated'
  AND policy_id = 'ntp_app_1_0_message_3_dev_1'
  AND event_type = 'interaction.followed_profile_updated';

INSERT INTO app_notification_template_versions (
  id,
  event_definition_id,
  version_code,
  state,
  title_text,
  summary_text,
  body_text,
  created_at
) VALUES (
  'ntv_interaction_followed_profile_updated_v1',
  'nde_interaction_followed_profile_updated',
  'interaction-followed-profile-updated-v1',
  'development',
  '你关注的资料有更新',
  '有新的已审核公开内容，打开 App 查看。',
  '这里只提示已审核并公开的资料更新，不展示内部审核信息或受保护内容。打开后请以当前人物详情为准。',
  '2026-08-09T00:00:00.000Z'
);
