-- 多广告位配置：独立于旧 home_ad_* 站点设置，支持排序、排期、大图和轮播。
CREATE TABLE IF NOT EXISTS home_ads (
  id TEXT PRIMARY KEY,
  placement TEXT NOT NULL DEFAULT 'home_after_hero',
  eyebrow TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT '查看详情',
  target_url TEXT NOT NULL DEFAULT '/discover?sort=hot',
  sponsor TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT NOT NULL DEFAULT '',
  ends_at TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_home_ads_placement_order ON home_ads(placement, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_home_ads_enabled ON home_ads(enabled, starts_at, ends_at);
