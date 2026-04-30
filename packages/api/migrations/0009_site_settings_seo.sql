-- 站点设置：新增 SEO/OG 和页脚相关字段
INSERT OR IGNORE INTO site_settings (key, value) VALUES
  ('site_description', '""'),
  ('site_icon', '""'),
  ('og_title', '""'),
  ('og_description', '""'),
  ('og_image', '""'),
  ('footer_text', '""');
