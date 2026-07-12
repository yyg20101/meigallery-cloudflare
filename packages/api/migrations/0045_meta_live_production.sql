PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS meta_live_challenges_new;

CREATE TABLE meta_live_challenges_new (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  contact_event_id TEXT,
  complete_registration_event_id TEXT,
  contact_event_digest TEXT,
  complete_registration_event_digest TEXT,
  events_received INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (id GLOB 'mlc_[0-9a-f]*' AND length(id) = 36),
  CHECK (environment = 'production'),
  CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9A-Fa-f]*'),
  CHECK (status IN ('pending', 'consuming', 'server_sent')),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending'
      AND contact_event_id IS NOT NULL
      AND complete_registration_event_id IS NOT NULL
      AND contact_event_digest IS NULL
      AND complete_registration_event_digest IS NULL
      AND events_received IS NULL)
    OR
    (status IN ('consuming', 'server_sent')
      AND contact_event_id IS NULL
      AND complete_registration_event_id IS NULL
      AND contact_event_digest GLOB 'sha256:[0-9a-f]*'
      AND length(contact_event_digest) = 71
      AND complete_registration_event_digest GLOB 'sha256:[0-9a-f]*'
      AND length(complete_registration_event_digest) = 71
      AND ((status = 'consuming' AND events_received IS NULL) OR (status = 'server_sent' AND events_received = 2))
      AND consumed_at IS NOT NULL)
  )
);

-- dev challenge 不可升级为 production 证据，迁移时直接丢弃短期测试记录。
DROP TABLE meta_live_challenges;
ALTER TABLE meta_live_challenges_new RENAME TO meta_live_challenges;

CREATE INDEX idx_meta_live_challenges_expiry
  ON meta_live_challenges(expires_at);

PRAGMA foreign_keys = ON;
