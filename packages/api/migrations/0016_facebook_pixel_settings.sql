-- Facebook Pixel 广告归因配置
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('facebook_pixel_enabled', 'false', datetime('now')),
  ('facebook_pixel_id', '""', datetime('now')),
  ('facebook_pixel_debug_enabled', 'false', datetime('now'));
