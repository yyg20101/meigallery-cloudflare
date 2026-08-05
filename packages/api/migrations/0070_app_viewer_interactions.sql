-- App 观看者对人物资料的 Interaction-1 单向私有关系。
--
-- 本 migration 只创建空表和本人列表索引：不回填 legacy 数据、不生成聚合计数，
-- 也不把可重建的公开投影作为外键权威表。资料失效后关系仍可由本人清理。

CREATE TABLE app_viewer_interactions (
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL
    CHECK (
      profile_id GLOB 'pp_*'
      AND profile_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(profile_id) BETWEEN 4 AND 80
    ),
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('like', 'follow')),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  PRIMARY KEY (account_id, profile_id, interaction_type)
);

CREATE INDEX idx_app_viewer_interactions_account_list
  ON app_viewer_interactions (
    account_id,
    interaction_type,
    created_at DESC,
    profile_id ASC
  );
