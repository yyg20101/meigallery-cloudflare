-- 站点设置：新增可运营的 SEO 关键词池。
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES ('seo_keywords', '""', datetime('now'));
