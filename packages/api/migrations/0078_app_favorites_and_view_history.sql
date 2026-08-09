-- App Interaction-2 收藏夹与浏览历史开发基线。
--
-- 本 migration 只建立默认关闭的策略与空业务表：不回填喜欢/关注，不导入旧收藏，
-- 不创建账号收藏夹或浏览历史，也不执行保留期清理。收藏与喜欢保持独立语义；
-- 浏览历史只有在用户明确开启且提交当前偏好版本后才能写入。

CREATE TABLE app_interaction_collection_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'icp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  favorites_enabled INTEGER NOT NULL DEFAULT 0 CHECK (favorites_enabled IN (0, 1)),
  history_enabled INTEGER NOT NULL DEFAULT 0 CHECK (history_enabled IN (0, 1)),
  default_history_recording_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (default_history_recording_enabled IN (0, 1)),
  history_retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (history_retention_decision_status IN ('unresolved', 'approved')),
  personalization_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (personalization_decision_status IN ('unresolved', 'approved')),
  purge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purge_enabled IN (0, 1)),
  max_folder_name_length INTEGER NOT NULL
    CHECK (max_folder_name_length BETWEEN 1 AND 60),
  max_items_per_folder INTEGER NOT NULL
    CHECK (max_items_per_folder BETWEEN 1 AND 5000),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    )
);

INSERT INTO app_interaction_collection_policies (
  id,
  state,
  production_ready,
  favorites_enabled,
  history_enabled,
  default_history_recording_enabled,
  history_retention_decision_status,
  personalization_decision_status,
  purge_enabled,
  max_folder_name_length,
  max_items_per_folder,
  created_at
) VALUES (
  'icp_app_1_0_interaction_2_dev_1',
  'development',
  0,
  1,
  1,
  0,
  'unresolved',
  'unresolved',
  0,
  30,
  500,
  '2026-08-09T00:00:00.000Z'
);

CREATE TABLE app_favorite_folders (
  id TEXT NOT NULL
    CHECK (
      id GLOB 'ff_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 4 AND 96
    ),
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_type TEXT NOT NULL CHECK (folder_type IN ('default', 'custom')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  normalized_name TEXT NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 60),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
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
  CHECK (
    (folder_type = 'default' AND name = '默认收藏' AND normalized_name = '__default__' AND sort_order = 0)
    OR
    (folder_type = 'custom' AND normalized_name <> '__default__')
  ),
  PRIMARY KEY (account_id, id)
);

CREATE UNIQUE INDEX idx_app_favorite_folders_account_default
  ON app_favorite_folders (account_id)
  WHERE folder_type = 'default';

CREATE UNIQUE INDEX idx_app_favorite_folders_account_name
  ON app_favorite_folders (account_id, normalized_name)
  WHERE folder_type = 'custom';

CREATE INDEX idx_app_favorite_folders_account_list
  ON app_favorite_folders (
    account_id,
    folder_type,
    sort_order,
    created_at,
    id
  );

CREATE TABLE app_favorite_folder_items (
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  profile_id TEXT NOT NULL
    CHECK (
      profile_id GLOB 'pp_*'
      AND profile_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(profile_id) BETWEEN 4 AND 80
    ),
  created_at TEXT NOT NULL
    CHECK (
      created_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(created_at) IS NOT NULL
    ),
  PRIMARY KEY (account_id, folder_id, profile_id),
  FOREIGN KEY (account_id, folder_id)
    REFERENCES app_favorite_folders(account_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_app_favorite_items_account_profile
  ON app_favorite_folder_items (
    account_id,
    profile_id,
    created_at DESC,
    folder_id
  );

CREATE INDEX idx_app_favorite_items_folder_list
  ON app_favorite_folder_items (
    account_id,
    folder_id,
    created_at DESC,
    profile_id ASC
  );

CREATE TABLE app_view_history_preferences (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  recording_enabled INTEGER NOT NULL DEFAULT 0 CHECK (recording_enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  mutation_token TEXT NOT NULL
    CHECK (
      length(mutation_token) = 36
      AND mutation_token GLOB '????????-????-????-????-????????????'
      AND mutation_token NOT GLOB '*[^0-9a-f-]*'
    ),
  updated_at TEXT NOT NULL
    CHECK (
      updated_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(updated_at) IS NOT NULL
    )
);

CREATE TABLE app_profile_view_history (
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL
    CHECK (
      profile_id GLOB 'pp_*'
      AND profile_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(profile_id) BETWEEN 4 AND 80
    ),
  first_viewed_at TEXT NOT NULL
    CHECK (
      first_viewed_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(first_viewed_at) IS NOT NULL
    ),
  last_viewed_at TEXT NOT NULL
    CHECK (
      last_viewed_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(last_viewed_at) IS NOT NULL
    ),
  view_count INTEGER NOT NULL DEFAULT 1 CHECK (view_count BETWEEN 1 AND 1000000000),
  last_view_id_hash TEXT NOT NULL
    CHECK (
      length(last_view_id_hash) = 64
      AND last_view_id_hash NOT GLOB '*[^0-9a-f]*'
    ),
  expires_at TEXT NOT NULL
    CHECK (
      expires_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(expires_at) IS NOT NULL
      AND julianday(expires_at) > julianday(last_viewed_at)
    ),
  PRIMARY KEY (account_id, profile_id)
);

CREATE INDEX idx_app_profile_view_history_account_list
  ON app_profile_view_history (
    account_id,
    last_viewed_at DESC,
    profile_id ASC
  );

CREATE INDEX idx_app_profile_view_history_expiry
  ON app_profile_view_history (expires_at, account_id);
