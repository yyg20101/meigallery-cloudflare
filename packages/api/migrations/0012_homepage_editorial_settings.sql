-- 首页杂志化视觉配置
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('home_hero_title', '"精选写真，按地区发现"', datetime('now')),
  ('home_hero_subtitle', '"以授权写真、时尚、生活与艺术类内容为核心，按加拿大、国内精选和热门城市快速浏览。"', datetime('now')),
  ('home_hero_cta_label', '"浏览精选图库"', datetime('now')),
  ('home_hero_cta_url', '"/discover"', datetime('now')),
  ('home_featured_region_slugs', '"canada,domestic,toronto,vancouver"', datetime('now')),
  ('home_hot_tag_limit', '"15"', datetime('now'));
