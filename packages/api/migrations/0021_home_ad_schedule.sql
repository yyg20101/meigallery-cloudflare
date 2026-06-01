-- 首页广告位排期配置；留空表示不限制开始或结束时间。
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('home_ad_starts_at', '""', datetime('now')),
  ('home_ad_ends_at', '""', datetime('now'));
