-- App Search-1：人物搜索与账号私有搜索历史开发基线。
--
-- 本 migration 只建立默认关闭的策略与空业务表，不启用 Wrangler 环境开关，
-- 不回填旧站搜索词，也不创建任何用户历史。人物搜索只读取已审核公开投影；
-- 搜索历史必须由用户明确开启，并通过独立写命令记录，禁止写入分析事件或审计日志。

CREATE TABLE app_person_search_policies (
  id TEXT PRIMARY KEY
    CHECK (
      id GLOB 'sqp_*'
      AND id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND length(id) BETWEEN 5 AND 96
    ),
  state TEXT NOT NULL CHECK (state IN ('development', 'published', 'retired')),
  production_ready INTEGER NOT NULL DEFAULT 0 CHECK (production_ready IN (0, 1)),
  person_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK (person_search_enabled IN (0, 1)),
  history_enabled INTEGER NOT NULL DEFAULT 0 CHECK (history_enabled IN (0, 1)),
  history_production_ready INTEGER NOT NULL DEFAULT 0
    CHECK (history_production_ready IN (0, 1)),
  default_history_recording_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (default_history_recording_enabled IN (0, 1)),
  history_retention_decision_status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (history_retention_decision_status IN ('unresolved', 'approved')),
  purge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purge_enabled IN (0, 1)),
  max_query_length INTEGER NOT NULL CHECK (max_query_length BETWEEN 1 AND 80),
  max_history_items INTEGER NOT NULL CHECK (max_history_items BETWEEN 1 AND 200),
  history_retention_days INTEGER NOT NULL CHECK (history_retention_days BETWEEN 1 AND 3650),
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
  CHECK (production_ready = 0 OR state = 'published'),
  CHECK (
    history_production_ready = 0
    OR (production_ready = 1 AND history_enabled = 1)
  ),
  CHECK (
    history_production_ready = 0
    OR (
      history_retention_decision_status = 'approved'
      AND purge_enabled = 1
    )
  )
);

INSERT INTO app_person_search_policies (
  id,
  state,
  production_ready,
  person_search_enabled,
  history_enabled,
  history_production_ready,
  default_history_recording_enabled,
  history_retention_decision_status,
  purge_enabled,
  max_query_length,
  max_history_items,
  history_retention_days,
  effective_at,
  created_at
) VALUES (
  'sqp_app_1_0_search_1_dev_1',
  'development',
  0,
  1,
  1,
  0,
  0,
  'unresolved',
  0,
  50,
  50,
  90,
  '2026-08-09T00:00:00.000Z',
  '2026-08-09T00:00:00.000Z'
);

CREATE TABLE app_search_history_preferences (
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

CREATE TABLE app_person_search_history (
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  history_id TEXT NOT NULL
    CHECK (
      history_id GLOB 'sh_*'
      AND length(history_id) = 67
      AND substr(history_id, 4) NOT GLOB '*[^0-9a-f]*'
    ),
  query_text TEXT NOT NULL CHECK (length(query_text) BETWEEN 1 AND 80),
  query_hash TEXT NOT NULL
    CHECK (
      length(query_hash) = 64
      AND query_hash NOT GLOB '*[^0-9a-f]*'
    ),
  first_searched_at TEXT NOT NULL
    CHECK (
      first_searched_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(first_searched_at) IS NOT NULL
    ),
  last_searched_at TEXT NOT NULL
    CHECK (
      last_searched_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(last_searched_at) IS NOT NULL
    ),
  search_count INTEGER NOT NULL DEFAULT 1 CHECK (search_count BETWEEN 1 AND 1000000000),
  last_search_id_hash TEXT NOT NULL
    CHECK (
      length(last_search_id_hash) = 64
      AND last_search_id_hash NOT GLOB '*[^0-9a-f]*'
    ),
  expires_at TEXT NOT NULL
    CHECK (
      expires_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(expires_at) IS NOT NULL
      AND julianday(expires_at) > julianday(last_searched_at)
    ),
  PRIMARY KEY (account_id, history_id),
  UNIQUE (account_id, query_hash),
  CHECK (julianday(last_searched_at) >= julianday(first_searched_at))
);

CREATE INDEX idx_app_person_search_history_account_list
  ON app_person_search_history (
    account_id,
    last_searched_at DESC,
    history_id ASC
  );

CREATE INDEX idx_app_person_search_history_expiry
  ON app_person_search_history (expires_at, account_id);

-- 当前规模使用公开投影上的确定性 LIKE/JSON 查询；不引入需要额外同步事实的 FTS 副本。
CREATE INDEX idx_profile_public_search_name
  ON profile_public_projections (
    publication_status,
    visibility_status,
    display_name COLLATE NOCASE,
    profile_id
  );
