-- 用户 ID 从 TEXT (usr_xxx) 改为 INTEGER AUTOINCREMENT
-- 影响表：users, sessions, user_memberships, import_jobs, admin_audit_logs

-- ============================================================
-- 1. 创建 ID 映射表
-- ============================================================
CREATE TABLE _user_id_map (old_id TEXT PRIMARY KEY, new_id INTEGER NOT NULL);
INSERT INTO _user_id_map (old_id, new_id)
SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) FROM users;

-- ============================================================
-- 2. 创建新 users 表（INTEGER PRIMARY KEY AUTOINCREMENT）
-- ============================================================
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  avatar_key TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  email_verified INTEGER NOT NULL DEFAULT 0,
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO users_new (id, email, username, nickname, password_hash, avatar_key, role, status, email_verified, notification_enabled, created_at, updated_at)
SELECT m.new_id, u.email, u.username, u.nickname, u.password_hash, u.avatar_key, u.role, u.status, u.email_verified, u.notification_enabled, u.created_at, u.updated_at
FROM users u
JOIN _user_id_map m ON u.id = m.old_id;

-- ============================================================
-- 3. 重建 sessions 表
-- ============================================================
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_new (id, user_id, token_hash, expires_at, created_at)
SELECT s.id, m.new_id, s.token_hash, s.expires_at, s.created_at
FROM sessions s
JOIN _user_id_map m ON s.user_id = m.old_id;

-- ============================================================
-- 4. 重建 user_memberships 表
-- ============================================================
CREATE TABLE user_memberships_new (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  level_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  note TEXT,
  granted_by INTEGER NOT NULL,
  expiry_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO user_memberships_new (id, user_id, level_id, starts_at, expires_at, note, granted_by, expiry_notified, created_at)
SELECT um.id, m1.new_id, um.level_id, um.starts_at, um.expires_at, um.note, m2.new_id, um.expiry_notified, um.created_at
FROM user_memberships um
JOIN _user_id_map m1 ON um.user_id = m1.old_id
JOIN _user_id_map m2 ON um.granted_by = m2.old_id;

-- ============================================================
-- 5. 重建 import_jobs 表
-- ============================================================
CREATE TABLE import_jobs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'zip',
  status TEXT NOT NULL DEFAULT 'queued',
  source_key TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_report_key TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

INSERT INTO import_jobs_new (id, type, status, source_key, total_count, success_count, failure_count, error_report_key, created_by, created_at, completed_at)
SELECT ij.id, ij.type, ij.status, ij.source_key, ij.total_count, ij.success_count, ij.failure_count, ij.error_report_key, m.new_id, ij.created_at, ij.completed_at
FROM import_jobs ij
JOIN _user_id_map m ON ij.created_by = m.old_id;

-- ============================================================
-- 6. 重建 admin_audit_logs 表
-- ============================================================
CREATE TABLE admin_audit_logs_new (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  before_value TEXT,
  after_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO admin_audit_logs_new (id, admin_id, action, target_type, target_id, before_value, after_value, created_at)
SELECT al.id, m.new_id, al.action, al.target_type,
  CASE
    WHEN al.target_type = 'user' AND al.target_id IS NOT NULL
    THEN CAST((SELECT m2.new_id FROM _user_id_map m2 WHERE m2.old_id = al.target_id) AS TEXT)
    ELSE al.target_id
  END,
  al.before_value, al.after_value, al.created_at
FROM admin_audit_logs al
JOIN _user_id_map m ON al.admin_id = m.old_id;

-- ============================================================
-- 7. 删除旧表、重命名新表
-- ============================================================
DROP TABLE sessions;
DROP TABLE user_memberships;
DROP TABLE import_jobs;
DROP TABLE admin_audit_logs;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE user_memberships_new RENAME TO user_memberships;
ALTER TABLE import_jobs_new RENAME TO import_jobs;
ALTER TABLE admin_audit_logs_new RENAME TO admin_audit_logs;

-- ============================================================
-- 8. 重建索引
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_memberships_user ON user_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memberships_active ON user_memberships(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON admin_audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON admin_audit_logs(created_at);

-- ============================================================
-- 9. 清理映射表
-- ============================================================
DROP TABLE _user_id_map;
