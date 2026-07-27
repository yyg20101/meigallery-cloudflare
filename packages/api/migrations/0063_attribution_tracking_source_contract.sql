PRAGMA defer_foreign_keys = ON;

CREATE TABLE analytics_tracking_sources_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'referral',
  slug TEXT NOT NULL UNIQUE,
  target_path TEXT NOT NULL DEFAULT '/',
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL DEFAULT 'referral',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  ad_provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (channel IN ('direct', 'search', 'social', 'referral', 'ad', 'internal', 'unknown')),
  CHECK (ad_provider IN ('', 'meta', 'tiktok', 'google')),
  CHECK (status IN ('active', 'disabled'))
);

INSERT INTO analytics_tracking_sources_next (
  id, name, channel, slug, target_path, utm_source, utm_medium,
  utm_campaign, utm_content, ad_provider, status, note,
  created_by, created_at, updated_at
)
SELECT
  id, name, channel, slug, target_path, utm_source, utm_medium,
  utm_campaign, utm_content, ad_provider, status, note,
  created_by, created_at, updated_at
FROM analytics_tracking_sources;

DROP TABLE analytics_tracking_sources;
ALTER TABLE analytics_tracking_sources_next RENAME TO analytics_tracking_sources;

CREATE INDEX idx_analytics_tracking_sources_status
  ON analytics_tracking_sources(status, created_at);
CREATE UNIQUE INDEX idx_analytics_tracking_sources_utm_source
  ON analytics_tracking_sources(utm_source);
CREATE INDEX idx_tracking_sources_ad_provider
  ON analytics_tracking_sources(ad_provider, status, created_at);

PRAGMA foreign_key_check;
