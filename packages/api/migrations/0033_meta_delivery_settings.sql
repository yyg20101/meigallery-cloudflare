ALTER TABLE analytics_tracking_sources ADD COLUMN utm_content TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('meta_capi_enabled', 'false', datetime('now')),
  ('meta_capi_test_event_enabled', 'false', datetime('now')),
  ('meta_tracking_mode', '"limited"', datetime('now'));
