ALTER TABLE attribution_deliveries
  ADD COLUMN runtime_owner_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (runtime_owner_epoch >= 1);

UPDATE attribution_deliveries
SET status = 'cancelled',
    last_error_code = 'runtime_epoch_migration',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE runtime_owner_epoch = 1
  AND transport = 'server'
  AND status IN ('planned', 'queued', 'retrying');

DELETE FROM attribution_outbox
WHERE EXISTS (
  SELECT 1
  FROM attribution_deliveries AS delivery
  WHERE delivery.id = attribution_outbox.delivery_id
    AND delivery.provider = attribution_outbox.provider
    AND delivery.runtime_owner_epoch = 1
    AND delivery.status = 'cancelled'
    AND delivery.last_error_code = 'runtime_epoch_migration'
);

CREATE TRIGGER attribution_deliveries_require_runtime_owner_epoch_insert
BEFORE INSERT ON attribution_deliveries
WHEN NEW.runtime_owner_epoch < 2
BEGIN
  SELECT RAISE(ABORT, 'runtime_owner_epoch_required');
END;

CREATE TRIGGER attribution_deliveries_require_runtime_owner_epoch_update
BEFORE UPDATE OF runtime_owner_epoch ON attribution_deliveries
WHEN NEW.runtime_owner_epoch < 2
BEGIN
  SELECT RAISE(ABORT, 'runtime_owner_epoch_required');
END;

CREATE INDEX attribution_deliveries_runtime_epoch_status
  ON attribution_deliveries(runtime_owner_epoch, status);

CREATE TABLE attribution_runtime_state_v2 (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  mode TEXT NOT NULL CHECK (
    mode IN ('shadow', 'bridge', 'active', 'fenced')
  ),
  activated_at TEXT,
  bridge_owner_epoch INTEGER,
  active_owner_epoch INTEGER,
  fenced_owner_epoch INTEGER,
  updated_at TEXT NOT NULL,
  CHECK (
    (
      mode = 'shadow'
      AND activated_at IS NULL
      AND bridge_owner_epoch IS NULL
      AND active_owner_epoch IS NULL
      AND fenced_owner_epoch IS NULL
    )
    OR (
      mode = 'bridge'
      AND activated_at IS NULL
      AND bridge_owner_epoch >= 2
      AND active_owner_epoch IS NULL
      AND fenced_owner_epoch IS NULL
    )
    OR (
      mode = 'active'
      AND activated_at IS NOT NULL
      AND bridge_owner_epoch >= 2
      AND active_owner_epoch = bridge_owner_epoch + 1
      AND fenced_owner_epoch IS NULL
    )
    OR (
      mode = 'fenced'
      AND activated_at IS NULL
      AND bridge_owner_epoch IS NULL
      AND active_owner_epoch IS NULL
      AND fenced_owner_epoch >= 3
    )
  )
);

INSERT INTO attribution_runtime_state_v2 (
  id,
  mode,
  activated_at,
  bridge_owner_epoch,
  active_owner_epoch,
  fenced_owner_epoch,
  updated_at
)
SELECT
  id,
  mode,
  activated_at,
  CASE
    WHEN mode IN ('bridge', 'active') THEN 2
    ELSE NULL
  END,
  CASE
    WHEN mode = 'active' THEN 3
    ELSE NULL
  END,
  NULL,
  updated_at
FROM attribution_runtime_state;

DROP TABLE attribution_runtime_state;

ALTER TABLE attribution_runtime_state_v2
  RENAME TO attribution_runtime_state;

CREATE VIEW attribution_runtime_dispatchable_deliveries AS
SELECT delivery.id AS delivery_id
FROM attribution_deliveries AS delivery
INNER JOIN attribution_facts AS fact
  ON fact.id = delivery.fact_id
INNER JOIN attribution_runtime_state AS runtime
  ON runtime.id = 'global'
WHERE delivery.transport = 'server'
  AND (
    (
      runtime.mode = 'active'
      AND delivery.runtime_owner_epoch IN (
        runtime.bridge_owner_epoch,
        runtime.active_owner_epoch
      )
    )
    OR (
      fact.fact_origin = 'synthetic'
      AND runtime.mode = 'shadow'
      AND delivery.runtime_owner_epoch = 2
    )
    OR (
      runtime.mode = 'bridge'
      AND delivery.runtime_owner_epoch = runtime.bridge_owner_epoch
    )
  );

CREATE TRIGGER attribution_runtime_fence_cancel_server_deliveries
AFTER UPDATE OF mode ON attribution_runtime_state
WHEN NEW.mode = 'fenced' AND OLD.mode <> 'fenced'
BEGIN
  UPDATE attribution_deliveries
  SET status = 'cancelled',
      last_error_code = 'runtime_fenced',
      updated_at = NEW.updated_at
  WHERE transport = 'server'
    AND status IN ('planned','queued','retrying');

  DELETE FROM attribution_outbox
  WHERE EXISTS (
    SELECT 1
    FROM attribution_deliveries AS delivery
    WHERE delivery.id = attribution_outbox.delivery_id
      AND delivery.provider = attribution_outbox.provider
      AND delivery.transport = 'server'
      AND delivery.status = 'cancelled'
      AND delivery.last_error_code = 'runtime_fenced'
  );
END;
