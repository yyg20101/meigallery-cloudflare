-- 邮箱验证系统: 验证码表 + 用户表新增列
-- Phase 2: 注册验证码、密码重置、会员到期提醒、新图库通知

-- ============================================================
-- 邮箱验证码表
-- ============================================================
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL,            -- 'register' | 'password_reset'
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evc_email_purpose ON email_verification_codes(email, purpose);
CREATE INDEX IF NOT EXISTS idx_evc_expires_at ON email_verification_codes(expires_at);

-- ============================================================
-- 用户表新增列
-- ============================================================
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN notification_enabled INTEGER NOT NULL DEFAULT 1;

-- ============================================================
-- 用户会员记录表新增列（到期提醒去重标记）
-- ============================================================
ALTER TABLE user_memberships ADD COLUMN expiry_notified INTEGER NOT NULL DEFAULT 0;
