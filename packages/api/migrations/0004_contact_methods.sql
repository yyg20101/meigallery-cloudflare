-- 联系方式管理表
-- 替代 site_settings 中的 contact_* 键值对
CREATE TABLE IF NOT EXISTS contact_methods (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,       -- wechat/qq/telegram/whatsapp/line/email/facebook/twitter/instagram/discord/xiaohongshu/custom
  label TEXT NOT NULL,          -- 显示名称，如"客服微信"
  value TEXT NOT NULL,          -- 联系值：用户名、号码、邮箱等
  link_url TEXT,                -- 可点击跳转的 URL（可自动生成或手动填写）
  qr_code_key TEXT,             -- R2 对象 key（二维码图片）
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_methods_enabled ON contact_methods(enabled, sort_order);

-- 清理旧的联系方式键值对
DELETE FROM site_settings WHERE key IN ('contact_wechat', 'contact_telegram', 'contact_email', 'contact_custom_note');
