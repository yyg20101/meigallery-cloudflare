CREATE INDEX idx_meta_capi_delivery_attempt_window
  ON analytics_conversion_deliveries(channel, last_attempt_at, status, error_code);

CREATE INDEX idx_meta_capi_delivery_pending_window
  ON analytics_conversion_deliveries(channel, status, created_at);

CREATE INDEX idx_meta_capi_delivery_duplicate_window
  ON analytics_conversion_deliveries(channel, duplicate_suppressed_at);

CREATE INDEX idx_meta_capi_delivery_created_window
  ON analytics_conversion_deliveries(channel, created_at, conversion_action_id);
