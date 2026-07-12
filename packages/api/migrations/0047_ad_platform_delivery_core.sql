ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'meta'
  CHECK (length(provider) BETWEEN 2 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*');

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN transport TEXT NOT NULL DEFAULT 'server'
  CHECK (transport IN ('browser', 'server'));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN connection_revision TEXT
  CHECK (
    connection_revision IS NULL
    OR (
      length(connection_revision) = 32
      AND connection_revision NOT GLOB '*[^0-9a-f]*'
    )
  );

UPDATE analytics_conversion_deliveries
SET transport = CASE channel
  WHEN 'meta_pixel' THEN 'browser'
  ELSE 'server'
END,
connection_revision = meta_connection_revision;

DROP INDEX idx_analytics_conversion_deliveries_external;
DROP INDEX idx_conversion_delivery_action_channel;

CREATE UNIQUE INDEX idx_conversion_delivery_provider_external
  ON analytics_conversion_deliveries(provider, transport, external_event_id);

CREATE UNIQUE INDEX idx_conversion_delivery_action_destination
  ON analytics_conversion_deliveries(conversion_action_id, provider, transport);

CREATE INDEX idx_conversion_delivery_provider_status
  ON analytics_conversion_deliveries(provider, transport, status, updated_at);

ALTER TABLE analytics_conversion_delivery_daily RENAME TO analytics_conversion_delivery_daily_legacy;

CREATE TABLE analytics_conversion_delivery_daily (
  date TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'meta',
  transport TEXT NOT NULL DEFAULT 'server',
  channel TEXT NOT NULL,
  event_name TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT NOT NULL DEFAULT '',
  delivery_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, provider, transport, event_name, status, skip_reason),
  CHECK (length(provider) BETWEEN 2 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
  CHECK (transport IN ('browser', 'server'))
);

INSERT INTO analytics_conversion_delivery_daily (
  date, provider, transport, channel, event_name, status, skip_reason,
  delivery_count, created_at, updated_at
)
SELECT
  date,
  'meta',
  CASE channel WHEN 'meta_pixel' THEN 'browser' ELSE 'server' END,
  channel,
  event_name,
  status,
  skip_reason,
  delivery_count,
  created_at,
  updated_at
FROM analytics_conversion_delivery_daily_legacy;

DROP TABLE analytics_conversion_delivery_daily_legacy;

CREATE INDEX idx_conversion_delivery_daily_provider_date
  ON analytics_conversion_delivery_daily(provider, transport, date);
