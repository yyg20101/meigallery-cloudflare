-- 用户体系增强：用户名、头像、邮箱验证开关
-- 用户名和头像基础字段

-- ============================================================
-- 用户名（唯一，英文+数字，3-20 字符，统一小写存储）
-- ============================================================
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- 头像 R2 key
ALTER TABLE users ADD COLUMN avatar_key TEXT;

-- 为现有 admin 用户设置默认用户名
UPDATE users SET username = 'admin' WHERE email = 'admin@616618.xyz';

-- ============================================================
-- 邮箱验证开关（默认关闭，Cloudflare Email Service 就绪后再开启）
-- ============================================================
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES ('email_verification_enabled', '"false"', datetime('now'));
