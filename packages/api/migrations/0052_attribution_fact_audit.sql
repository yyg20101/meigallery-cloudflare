CREATE TABLE attribution_fact_audit_logs (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES attribution_conversion_facts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_attribution_fact_audit_logs_fact ON attribution_fact_audit_logs(fact_id, created_at);
