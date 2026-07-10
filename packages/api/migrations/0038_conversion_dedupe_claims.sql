CREATE TABLE analytics_conversion_dedupe_claims (
  dedupe_key TEXT PRIMARY KEY,
  owner_action_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (length(dedupe_key) BETWEEN 1 AND 512),
  CHECK (length(owner_action_id) BETWEEN 1 AND 128),
  CHECK (length(claim_token) BETWEEN 1 AND 128),
  CHECK (claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at)),
  CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  CHECK (expires_at > claimed_at)
);

CREATE INDEX idx_analytics_conversion_dedupe_claims_expiry
  ON analytics_conversion_dedupe_claims(expires_at);
