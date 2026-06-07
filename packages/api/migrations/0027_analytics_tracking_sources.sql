-- 数据分析推广来源配置。
-- 推广来源用于生成标准追踪链接；邀请码仍独立用于邀请注册归因。

CREATE TABLE IF NOT EXISTS analytics_tracking_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'referral',
  slug TEXT NOT NULL UNIQUE,
  target_path TEXT NOT NULL DEFAULT '/',
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL DEFAULT 'referral',
  utm_campaign TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('direct', 'search', 'social', 'referral', 'ad', 'internal', 'unknown')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_tracking_sources_status
  ON analytics_tracking_sources(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_tracking_sources_utm_source
  ON analytics_tracking_sources(utm_source);
