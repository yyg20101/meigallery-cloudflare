-- App 观看者账号、设备与可撤销会话基础。
--
-- 本 migration 只创建空表和索引：不回填现有 Web 用户、不启用 App 登录、
-- 不固化首发地区或年龄数值。现有 users 继续作为唯一账号主体。

CREATE TABLE app_account_security (
  account_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_public_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'restricted', 'deletion_pending')),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  restriction_reason_code TEXT,
  restricted_until TEXT
    CHECK (restricted_until IS NULL OR julianday(restricted_until) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_account_identities (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('email')),
  provider_subject_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  verified_at TEXT CHECK (verified_at IS NULL OR julianday(verified_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_subject_hash)
);

CREATE INDEX idx_app_account_identities_account
  ON app_account_identities(account_id, status);

CREATE TABLE app_account_consents (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('terms', 'privacy', 'platform_operation', 'eligibility')),
  document_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'confirmed')),
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app')),
  request_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL CHECK (julianday(accepted_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, document_type, document_version)
);

CREATE INDEX idx_app_account_consents_account_time
  ON app_account_consents(account_id, accepted_at DESC);

CREATE TABLE app_devices (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  display_name TEXT NOT NULL,
  app_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  first_seen_at TEXT NOT NULL CHECK (julianday(first_seen_at) IS NOT NULL),
  last_seen_at TEXT NOT NULL CHECK (julianday(last_seen_at) IS NOT NULL),
  revoked_at TEXT CHECK (revoked_at IS NULL OR julianday(revoked_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, installation_hash)
);

CREATE INDEX idx_app_devices_account_activity
  ON app_devices(account_id, last_seen_at DESC, id DESC);

CREATE TABLE app_sessions (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES app_devices(id) ON DELETE CASCADE,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  account_session_version INTEGER NOT NULL CHECK (account_session_version >= 1),
  device_session_version INTEGER NOT NULL CHECK (device_session_version >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  access_expires_at TEXT NOT NULL CHECK (julianday(access_expires_at) IS NOT NULL),
  refresh_expires_at TEXT NOT NULL CHECK (julianday(refresh_expires_at) IS NOT NULL),
  last_seen_at TEXT NOT NULL CHECK (julianday(last_seen_at) IS NOT NULL),
  refreshed_at TEXT CHECK (refreshed_at IS NULL OR julianday(refreshed_at) IS NOT NULL),
  revoked_at TEXT CHECK (revoked_at IS NULL OR julianday(revoked_at) IS NOT NULL),
  revoke_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_app_sessions_one_active_device
  ON app_sessions(device_id)
  WHERE status = 'active';

CREATE INDEX idx_app_sessions_account_status
  ON app_sessions(account_id, status, refresh_expires_at DESC);

CREATE INDEX idx_app_sessions_device_status
  ON app_sessions(device_id, status);

CREATE TABLE app_refresh_token_history (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  replaced_at TEXT NOT NULL CHECK (julianday(replaced_at) IS NOT NULL)
);

CREATE INDEX idx_app_refresh_history_session
  ON app_refresh_token_history(session_id, replaced_at DESC);

CREATE TABLE app_account_security_events (
  id TEXT PRIMARY KEY,
  account_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES app_devices(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES app_sessions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  reason_code TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_app_security_events_account_time
  ON app_account_security_events(account_id, created_at DESC);

CREATE INDEX idx_app_security_events_session_time
  ON app_account_security_events(session_id, created_at DESC);
