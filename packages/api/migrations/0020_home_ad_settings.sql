-- 首页广告位配置，默认关闭，仅作为站内运营/赞助推荐位
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('home_ad_enabled', 'false', datetime('now')),
  ('home_ad_eyebrow', '"本周推荐"', datetime('now')),
  ('home_ad_title', '"会员季精选内容"', datetime('now')),
  ('home_ad_summary', '"探索本周精选图库、真实案例和会员可访问内容。"', datetime('now')),
  ('home_ad_cta_label', '"查看推荐"', datetime('now')),
  ('home_ad_url', '"/discover?sort=hot"', datetime('now')),
  ('home_ad_sponsor', '"MeiGallery 运营推荐"', datetime('now'));
