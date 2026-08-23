-- App 1.0 Account/Settings-2：观看者私有账号资料与单会话免打扰。
--
-- 账号头像只保存受控视觉样式，不复用真人资料或公开媒体字段；昵称继续以 users.nickname
-- 为唯一事实源。会话设置按 conversation + account 双重归属，防止跨账号读取或写入。

CREATE TABLE app_account_profile_preferences (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_style TEXT NOT NULL DEFAULT 'rose'
    CHECK (avatar_style IN ('rose', 'coral', 'lilac', 'sky', 'mint', 'sand')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

-- 为复合外键提供账号归属唯一键；conversation.id 仍保持原有全局唯一主键。
CREATE UNIQUE INDEX idx_app_conversations_id_account
  ON app_conversations (id, account_id);

CREATE TABLE app_conversation_viewer_settings (
  conversation_id TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  PRIMARY KEY (conversation_id, account_id),
  FOREIGN KEY (conversation_id, account_id)
    REFERENCES app_conversations(id, account_id) ON DELETE CASCADE
);

CREATE INDEX idx_app_conversation_viewer_settings_account
  ON app_conversation_viewer_settings (account_id, updated_at DESC, conversation_id);
