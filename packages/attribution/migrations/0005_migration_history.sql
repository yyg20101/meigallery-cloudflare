PRAGMA foreign_keys = ON;

CREATE TABLE attribution_history_daily (
  date TEXT NOT NULL CHECK (
    length(date) = 10
    AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  event_name TEXT NOT NULL CHECK (
    event_name IN ('Contact','CompleteRegistration')
  ),
  fact_origin TEXT NOT NULL CHECK (
    fact_origin IN ('historical_backfill','archived_live')
  ),
  provider TEXT NOT NULL CHECK (
    provider IN ('none','meta','tiktok','google')
  ),
  attribution_source TEXT NOT NULL,
  fact_count INTEGER NOT NULL CHECK (fact_count > 0),
  first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (
    date,
    event_name,
    fact_origin,
    provider,
    attribution_source
  )
);

CREATE INDEX attribution_history_daily_event_date
  ON attribution_history_daily(event_name, date DESC);

CREATE TABLE attribution_migration_manifests (
  initial_run_id TEXT PRIMARY KEY,
  initial_snapshot_hash TEXT NOT NULL UNIQUE,
  source_configuration_hash TEXT NOT NULL,
  credential_set_hash TEXT NOT NULL,
  initial_captured_at TEXT NOT NULL,
  desired_runtime_policies_json TEXT NOT NULL
    CHECK (json_valid(desired_runtime_policies_json)),
  status TEXT NOT NULL CHECK (
    status IN ('initial_imported','reconciled')
  ),
  reconcile_run_id TEXT UNIQUE,
  reconcile_snapshot_hash TEXT UNIQUE,
  reconciled_captured_at TEXT,
  created_at TEXT NOT NULL,
  reconciled_at TEXT,
  CHECK (
    (
      status = 'initial_imported'
      AND reconcile_run_id IS NULL
      AND reconcile_snapshot_hash IS NULL
      AND reconciled_captured_at IS NULL
      AND reconciled_at IS NULL
    )
    OR (
      status = 'reconciled'
      AND reconcile_run_id IS NOT NULL
      AND reconcile_snapshot_hash IS NOT NULL
      AND reconciled_captured_at IS NOT NULL
      AND reconciled_at IS NOT NULL
    )
  )
);
