PRAGMA foreign_keys = ON;

CREATE TABLE attribution_managed_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  connection_id TEXT NOT NULL
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  campaign TEXT NOT NULL,
  medium TEXT NOT NULL,
  content TEXT NOT NULL,
  proof_hash TEXT NOT NULL UNIQUE CHECK (
    length(proof_hash) = 64
    AND proof_hash NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX attribution_managed_sources_connection_enabled
  ON attribution_managed_sources(connection_id, enabled, expires_at);

CREATE TABLE attribution_contexts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  connection_id TEXT NOT NULL
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  source_id TEXT
    REFERENCES attribution_managed_sources(id) ON DELETE CASCADE,
  identifiers_envelope_json TEXT NOT NULL
    CHECK (
      json_valid(identifiers_envelope_json)
      AND json_extract(identifiers_envelope_json, '$.schemaVersion') IS 1
      AND json_type(identifiers_envelope_json, '$.keyId') IS 'text'
      AND json_type(identifiers_envelope_json, '$.iv') IS 'text'
      AND json_type(identifiers_envelope_json, '$.ciphertext') IS 'text'
      AND json_type(identifiers_envelope_json, '$.tag') IS 'text'
    ),
  issued_at INTEGER NOT NULL CHECK (issued_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at)
);

CREATE INDEX attribution_contexts_connection_expiry
  ON attribution_contexts(connection_id, expires_at);

CREATE TABLE attribution_facts (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL CHECK (
    event_name IN ('Contact','CompleteRegistration')
  ),
  fact_origin TEXT NOT NULL CHECK (fact_origin IN ('live','synthetic')),
  dedupe_key TEXT NOT NULL,
  connection_id TEXT
    REFERENCES attribution_connections(id),
  version_id TEXT
    REFERENCES attribution_connection_versions(id),
  provider TEXT CHECK (
    provider IS NULL OR provider IN ('meta','tiktok','google')
  ),
  external_event_id TEXT,
  occurred_at TEXT NOT NULL,
  consent_json TEXT NOT NULL CHECK (json_valid(consent_json)),
  analytics_dimensions_json TEXT NOT NULL
    CHECK (json_valid(analytics_dimensions_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dedupe_key),
  CHECK (
    (
      connection_id IS NULL
      AND version_id IS NULL
      AND provider IS NULL
      AND external_event_id IS NULL
    )
    OR (
      connection_id IS NOT NULL
      AND version_id IS NOT NULL
      AND provider IS NOT NULL
      AND external_event_id IS NOT NULL
    )
  )
);

CREATE INDEX attribution_facts_connection_occurred
  ON attribution_facts(connection_id, occurred_at DESC);

CREATE INDEX attribution_facts_origin_occurred
  ON attribution_facts(fact_origin, occurred_at DESC);

CREATE TABLE attribution_deliveries (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL
    REFERENCES attribution_facts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL
    REFERENCES attribution_connections(id),
  version_id TEXT NOT NULL
    REFERENCES attribution_connection_versions(id),
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  transport TEXT NOT NULL CHECK (transport IN ('browser','server')),
  destination TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'planned',
      'queued',
      'accepted',
      'processed',
      'retrying',
      'rejected',
      'dead_letter',
      'cancelled'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  queue_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (queue_attempt_count >= 0),
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fact_id, connection_id, transport)
);

CREATE INDEX attribution_deliveries_provider_status_updated
  ON attribution_deliveries(provider, status, updated_at);

CREATE INDEX attribution_deliveries_version_status
  ON attribution_deliveries(version_id, status);

CREATE TABLE attribution_outbox (
  delivery_id TEXT PRIMARY KEY
    REFERENCES attribution_deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  version_id TEXT NOT NULL
    REFERENCES attribution_connection_versions(id),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX attribution_outbox_expiry_created
  ON attribution_outbox(expires_at, created_at);

CREATE TABLE attribution_browser_receipts (
  delivery_id TEXT PRIMARY KEY
    REFERENCES attribution_deliveries(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attribution_validations (
  id TEXT PRIMARY KEY,
  candidate_version_id TEXT NOT NULL
    REFERENCES attribution_connection_versions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  status TEXT NOT NULL CHECK (
    status IN ('queued','running','verified','failed','timed_out')
  ),
  evidence_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(evidence_json)),
  failure_code TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX attribution_validations_one_live_candidate
  ON attribution_validations(candidate_version_id)
  WHERE status IN ('queued','running');

CREATE TABLE attribution_validation_secrets (
  validation_id TEXT PRIMARY KEY
    REFERENCES attribution_validations(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE attribution_quality_daily (
  date TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('meta','tiktok','google')),
  connection_id TEXT NOT NULL
    REFERENCES attribution_connections(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  numerator INTEGER CHECK (numerator IS NULL OR numerator >= 0),
  denominator INTEGER CHECK (denominator IS NULL OR denominator >= 0),
  value REAL,
  availability TEXT NOT NULL CHECK (
    availability IN ('available','unavailable','error')
  ),
  PRIMARY KEY (date, connection_id, metric_key)
);

CREATE TABLE attribution_privacy_policy (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  default_mode TEXT NOT NULL CHECK (
    default_mode IN ('notice_opt_out','prior_consent','disabled')
  ),
  prior_consent_country_codes_json TEXT NOT NULL
    CHECK (json_valid(prior_consent_country_codes_json)),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO attribution_privacy_policy (
  id,
  default_mode,
  prior_consent_country_codes_json,
  policy_version
) VALUES (
  'global',
  'prior_consent',
  '[]',
  1
);
