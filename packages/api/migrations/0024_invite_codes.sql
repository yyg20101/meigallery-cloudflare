-- 邀请码与邀请注册事实表。
-- 邀请码明文只在创建响应中返回，数据库保存 hash 和后台可识别短展示码。

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  display_code TEXT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'manual',
  inviter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT NOT NULL DEFAULT '',
  CHECK (status IN ('active', 'disabled', 'expired')),
  CHECK (max_uses IS NULL OR max_uses >= 0),
  CHECK (used_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_status_expires
  ON invite_codes(status, expires_at);

CREATE TABLE IF NOT EXISTS invite_registrations (
  id TEXT PRIMARY KEY,
  invite_code_id TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL REFERENCES analytics_visitors(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL DEFAULT 'invite',
  landing_path TEXT NOT NULL DEFAULT '/',
  registered_at TEXT NOT NULL,
  first_membership_granted_at TEXT,
  first_membership_rank INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (invited_user_id),
  UNIQUE (invite_code_id, invited_user_id),
  CHECK (source_channel IN ('direct', 'search', 'social', 'referral', 'invite', 'ad', 'internal', 'unknown')),
  CHECK (first_membership_rank IS NULL OR first_membership_rank >= 0)
);

CREATE INDEX IF NOT EXISTS idx_invite_registrations_invite_registered
  ON invite_registrations(invite_code_id, registered_at);
CREATE INDEX IF NOT EXISTS idx_invite_registrations_user
  ON invite_registrations(invited_user_id);
