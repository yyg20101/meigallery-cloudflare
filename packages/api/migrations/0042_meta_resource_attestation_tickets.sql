CREATE TABLE meta_resource_attestation_tickets (
  ticket_digest TEXT PRIMARY KEY
    CHECK(length(ticket_digest) = 64 AND ticket_digest NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK(environment IN ('dev', 'production')),
  commit_sha TEXT NOT NULL
    CHECK(length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  nonce TEXT NOT NULL
    CHECK(length(nonce) BETWEEN 38 AND 134 AND nonce GLOB 'nonce_*'),
  owner_user_id INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS NOT NULL
    AND issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)),
  CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL
    AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  CHECK(expires_at > issued_at),
  CHECK(consumed_at IS NULL OR (
    strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS NOT NULL
    AND consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at)
  ))
);

CREATE INDEX idx_meta_resource_attestation_tickets_expiry
  ON meta_resource_attestation_tickets(expires_at, consumed_at);
