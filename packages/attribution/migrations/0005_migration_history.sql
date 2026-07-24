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
