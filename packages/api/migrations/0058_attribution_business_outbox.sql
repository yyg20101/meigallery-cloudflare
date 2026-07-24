-- API 只保存已经由业务事务确认成功的 CompleteRegistration 事件。
-- 平台选择、隐私判断和平台投递均由独立 Attribution Worker 负责。
CREATE TABLE attribution_business_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL CHECK (event_name = 'CompleteRegistration'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatching', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (julianday(next_attempt_at) IS NOT NULL),
  claim_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (julianday(updated_at) IS NOT NULL),
  completed_at TEXT CHECK (
    completed_at IS NULL OR julianday(completed_at) IS NOT NULL
  ),
  CHECK (length(id) BETWEEN 1 AND 160),
  CHECK (length(event_id) BETWEEN 1 AND 160),
  CHECK (id = event_id),
  CHECK (length(dedupe_key) BETWEEN 1 AND 240),
  CHECK (
    CASE
      WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.schemaVersion') = 1
        AND json_extract(payload_json, '$.eventId') = event_id
        AND json_extract(payload_json, '$.eventName') = event_name
        AND json_extract(payload_json, '$.dedupeKey') = dedupe_key
        AND json_type(payload_json, '$.payload.userId') = 'integer'
        AND json_extract(payload_json, '$.payload.userId') > 0
      ELSE 0
    END
  ),
  CHECK (
    (
      status = 'pending'
      AND claim_token IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'dispatching'
      AND claim_token IS NOT NULL
      AND length(claim_token) BETWEEN 16 AND 160
      AND completed_at IS NULL
    )
    OR (
      status = 'completed'
      AND claim_token IS NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_attribution_business_outbox_due
  ON attribution_business_outbox(status, next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'dispatching');

CREATE INDEX idx_attribution_business_outbox_completed
  ON attribution_business_outbox(completed_at, id)
  WHERE status = 'completed';
