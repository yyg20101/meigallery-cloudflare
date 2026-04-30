-- MeiGallery D1 初始 Schema
-- 包含 12 张表：users, membership_levels, user_memberships, galleries,
-- media_assets, tags, gallery_tags, import_jobs, admin_audit_logs,
-- site_settings, legacy_import_sources, legacy_import_items, legacy_url_redirects

-- ============================================================
-- 用户表
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',           -- visitor/user/admin/owner
  status TEXT NOT NULL DEFAULT 'active',       -- active/disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 会员等级定义表
-- ============================================================
CREATE TABLE IF NOT EXISTS membership_levels (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                   -- free/vip/svip
  name TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始会员等级数据
INSERT INTO membership_levels (id, code, name, rank) VALUES
  ('ml_free', 'free', '免费', 0),
  ('ml_vip', 'vip', 'VIP', 10),
  ('ml_svip', 'svip', 'SVIP', 20);

-- ============================================================
-- 用户会员记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  level_id TEXT NOT NULL REFERENCES membership_levels(id),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  note TEXT,
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_memberships_user ON user_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memberships_active ON user_memberships(user_id, expires_at);

-- ============================================================
-- 图库表
-- ============================================================
CREATE TABLE IF NOT EXISTS galleries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  cover_key TEXT,                               -- R2 对象 key
  status TEXT NOT NULL DEFAULT 'draft',          -- draft/published/unpublished/archived
  required_level_rank INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  legacy_url TEXT,
  legacy_slug TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_galleries_status ON galleries(status);
CREATE INDEX IF NOT EXISTS idx_galleries_slug ON galleries(slug);
CREATE INDEX IF NOT EXISTS idx_galleries_published ON galleries(status, published_at);

-- ============================================================
-- 媒体资源表
-- ============================================================
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  gallery_id TEXT NOT NULL REFERENCES galleries(id),
  type TEXT NOT NULL,                            -- image/video
  storage TEXT NOT NULL,                         -- r2/stream
  r2_key TEXT,
  stream_uid TEXT,
  required_rank INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'content',           -- cover/content/preview/full
  sort_order INTEGER NOT NULL DEFAULT 0,
  upload_status TEXT NOT NULL DEFAULT 'completed', -- completed/upload_failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_media_assets_gallery ON media_assets(gallery_id);

-- ============================================================
-- 标签表
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                            -- region_scope/region_group/city_country/identity/personality/style/occupation/hair/clothing/scene/content_type
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tags_type ON tags(type);

-- ============================================================
-- 图库-标签关联表
-- ============================================================
CREATE TABLE IF NOT EXISTS gallery_tags (
  gallery_id TEXT NOT NULL REFERENCES galleries(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (gallery_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_tags_tag ON gallery_tags(tag_id);

-- ============================================================
-- 导入任务表
-- ============================================================
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'zip',              -- zip/legacy
  status TEXT NOT NULL DEFAULT 'queued',          -- queued/processing/completed/failed
  source_key TEXT,                               -- R2 key
  total_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_report_key TEXT,                         -- R2 key
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- ============================================================
-- 审计日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,                          -- create/update/delete/publish/unpublish/grant_membership/import/settings_change
  target_type TEXT NOT NULL,                     -- gallery/tag/user/membership/import_job/settings
  target_id TEXT,
  before_value TEXT,                             -- JSON
  after_value TEXT,                              -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON admin_audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON admin_audit_logs(created_at);

-- ============================================================
-- 站点设置表
-- ============================================================
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始站点配置
INSERT INTO site_settings (key, value) VALUES
  ('site_name', '"MeiGallery"'),
  ('seo_title', '"MeiGallery - 精选写真图库"'),
  ('membership_description', '""'),
  ('contact_wechat', '""'),
  ('contact_telegram', '""'),
  ('contact_email', '""'),
  ('contact_custom_note', '""');

-- ============================================================
-- 旧站导入来源表
-- ============================================================
CREATE TABLE IF NOT EXISTS legacy_import_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rest_api',         -- rest_api/xml
  category_mapping TEXT,                         -- JSON: {wp_cat_id: tag_id}
  tag_mapping TEXT,                              -- JSON: {wp_tag_id: tag_id}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 旧站导入条目表
-- ============================================================
CREATE TABLE IF NOT EXISTS legacy_import_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES legacy_import_sources(id),
  job_id TEXT REFERENCES import_jobs(id),
  legacy_post_id INTEGER NOT NULL,
  legacy_url TEXT NOT NULL,
  legacy_title TEXT,
  gallery_id TEXT REFERENCES galleries(id),
  status TEXT NOT NULL DEFAULT 'pending',         -- pending/imported/failed
  review_status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
  review_flags TEXT,                             -- JSON: ["sensitive_word", "missing_media", ...]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_legacy_items_source ON legacy_import_items(source_id);
CREATE INDEX IF NOT EXISTS idx_legacy_items_review ON legacy_import_items(review_status);

-- ============================================================
-- 旧站 URL 重定向表
-- ============================================================
CREATE TABLE IF NOT EXISTS legacy_url_redirects (
  old_path TEXT PRIMARY KEY,
  new_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
