ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN delivery_lease_token TEXT NOT NULL DEFAULT ''
  CHECK (
    delivery_lease_token = ''
    OR (
      length(delivery_lease_token) = 32
      AND delivery_lease_token NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN delivery_lease_expires_at TEXT;

CREATE INDEX idx_meta_capi_delivery_lease_expiry
  ON analytics_conversion_deliveries(delivery_lease_expires_at)
  WHERE channel = 'meta_capi' AND delivery_lease_token <> '';

INSERT OR IGNORE INTO site_settings (key, value)
VALUES ('registration_conversion_recovery_cursor', '0');
