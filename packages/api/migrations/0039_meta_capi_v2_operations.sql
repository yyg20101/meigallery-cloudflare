ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN rollout_target_percentage INTEGER NOT NULL DEFAULT 0
  CHECK (rollout_target_percentage IN (0, 10, 50, 100));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN rollout_effective_percentage INTEGER NOT NULL DEFAULT 0
  CHECK (rollout_effective_percentage IN (0, 10, 50, 100));

ALTER TABLE analytics_conversion_deliveries
  ADD COLUMN rollout_bucket INTEGER
  CHECK (rollout_bucket IS NULL OR (rollout_bucket >= 0 AND rollout_bucket <= 99));

CREATE UNIQUE INDEX idx_conversion_delivery_action_channel
  ON analytics_conversion_deliveries(conversion_action_id, channel);

CREATE TABLE meta_capi_incidents (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  trigger_summary TEXT NOT NULL DEFAULT '',
  target_rollout_percentage INTEGER NOT NULL,
  effective_rollout_percentage INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '{}',
  opened_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (status IN ('open', 'closed')),
  CHECK (severity IN ('warning', 'critical')),
  CHECK (
    length(trigger_code) BETWEEN 1 AND 64
    AND substr(trigger_code, 1, 1) BETWEEN 'a' AND 'z'
    AND trigger_code NOT GLOB '*[^a-z0-9_]*'
  ),
  CHECK (target_rollout_percentage IN (0, 10, 50, 100)),
  CHECK (effective_rollout_percentage IN (0, 10, 50, 100)),
  CHECK (json_valid(evidence) AND json_type(evidence) = 'object'),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', opened_at) IS NOT NULL
    AND opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', opened_at)
  ),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at) IS NOT NULL
    AND last_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at)
    AND opened_at <= last_observed_at
  ),
  CHECK (
    closed_at IS NULL
    OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS NOT NULL
      AND closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', closed_at)
      AND closed_at >= last_observed_at
    )
  ),
  CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by_user_id IS NULL AND resolution = '')
    OR (status = 'closed' AND closed_at IS NOT NULL AND length(trim(resolution)) > 0)
  )
);

CREATE UNIQUE INDEX idx_meta_capi_incident_open_trigger
  ON meta_capi_incidents(environment, trigger_code)
  WHERE status = 'open';

CREATE INDEX idx_meta_capi_incident_status_time
  ON meta_capi_incidents(environment, status, opened_at);

CREATE TABLE meta_dataset_quality_snapshots (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL,
  window_start TEXT,
  window_end TEXT,
  collection_status TEXT NOT NULL DEFAULT 'success',
  error_category TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (environment IN ('dev', 'production')),
  CHECK (
    length(dataset_id) BETWEEN 5 AND 30
    AND substr(dataset_id, 1, 1) BETWEEN '1' AND '9'
    AND dataset_id NOT GLOB '*[^0-9]*'
  ),
  CHECK (event_name IN ('Contact', 'CompleteRegistration')),
  CHECK (
    length(metric_key) BETWEEN 1 AND 64
    AND substr(metric_key, 1, 1) BETWEEN 'a' AND 'z'
    AND metric_key NOT GLOB '*[^a-z0-9_]*'
  ),
  CHECK (typeof(contract_version) = 'integer' AND contract_version >= 1),
  CHECK (collection_status IN ('success', 'error')),
  CHECK (
    error_category = ''
    OR (
      length(error_category) BETWEEN 1 AND 64
      AND substr(error_category, 1, 1) BETWEEN 'a' AND 'z'
      AND error_category NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', collected_at) IS NOT NULL
    AND collected_at = strftime('%Y-%m-%dT%H:%M:%fZ', collected_at)
  ),
  CHECK (
    (window_start IS NULL AND window_end IS NULL)
    OR (
      window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', window_start) IS NOT NULL
      AND window_start = strftime('%Y-%m-%dT%H:%M:%fZ', window_start)
      AND strftime('%Y-%m-%dT%H:%M:%fZ', window_end) IS NOT NULL
      AND window_end = strftime('%Y-%m-%dT%H:%M:%fZ', window_end)
      AND window_start <= window_end
      AND window_end <= collected_at
    )
  ),
  CHECK (
    (
      collection_status = 'success'
      AND metric_value IS NOT NULL
      AND typeof(metric_value) IN ('integer', 'real')
      AND error_category = ''
    )
    OR (
      collection_status = 'error'
      AND metric_value IS NULL
      AND error_category <> ''
    )
  )
);

CREATE INDEX idx_meta_dataset_quality_metric_time
  ON meta_dataset_quality_snapshots(environment, event_name, metric_key, collected_at);

INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES ('meta_capi_rollout_percentage', '0', datetime('now'));
