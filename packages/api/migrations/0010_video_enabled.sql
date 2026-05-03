-- 视频功能开关（默认关闭，Cloudflare Stream 接入后再开启）
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES ('video_enabled', '"false"', datetime('now'));
