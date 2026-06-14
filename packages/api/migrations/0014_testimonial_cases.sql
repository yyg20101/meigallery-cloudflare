-- 真实案例、规则入口与关于页配置移除
CREATE TABLE IF NOT EXISTS testimonial_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  featured INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('draft', 'published'))
);

CREATE TABLE IF NOT EXISTS testimonial_case_images (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES testimonial_cases(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt_text TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_testimonial_cases_public
  ON testimonial_cases(status, featured, sort_order, published_at);
CREATE INDEX IF NOT EXISTS idx_testimonial_images_case
  ON testimonial_case_images(case_id, sort_order);

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('rules_entry_enabled', 'true', datetime('now')),
  ('rules_entry_title', '"入站规则"', datetime('now')),
  ('rules_entry_summary', '"查看内容规则、会员说明和联系前须知。"', datetime('now')),
  ('rules_entry_icon', '"letter"', datetime('now')),
  ('rules_modal_content', '"## 入站规则\n\n- 本站仅展示合法授权的写真、时尚、生活与艺术类内容\n- 受保护内容需登录并满足会员等级\n- 如需咨询会员或内容授权，请通过联系站长入口沟通"', datetime('now')),
  ('rules_page_title', '"入站规则"', datetime('now')),
  ('rules_page_summary', '"了解本站的内容边界、会员访问和联系方式说明。"', datetime('now')),
  ('rules_page_content', '"## 内容边界\n\n本站仅展示经过授权的写真、时尚、生活与艺术类素材，不发布露骨、侵权或侵犯隐私的内容。\n\n## 会员访问\n\n部分高清图片和完整内容需要会员权限。会员等级由站长手动授予，到期后自动失去对应访问权限。\n\n## 联系站长\n\n如需开通会员、咨询授权或反馈问题，请使用页面右下角联系方式。"', datetime('now')),
  ('rules_page_url', '"/rules"', datetime('now'));

DELETE FROM site_settings WHERE key IN ('about_title', 'about_summary', 'about_content');
