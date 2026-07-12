ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN tracking_mode TEXT NOT NULL DEFAULT 'disabled'
  CHECK (tracking_mode IN ('disabled', 'test', 'production'));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN queue_enqueued_at TEXT;

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN queue_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (queue_attempt_count >= 0);

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN duplicate_suppressed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_analytics_conversion_deliveries_recovery
  ON analytics_conversion_deliveries(channel, status, queue_enqueued_at, updated_at);
