ALTER TABLE attribution_validations
  ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';

ALTER TABLE attribution_validations
  ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

UPDATE attribution_validations
SET idempotency_key = 'legacy-validation:' || id,
    request_hash = lower(hex(randomblob(32)))
WHERE idempotency_key = ''
  AND request_hash = '';

CREATE UNIQUE INDEX attribution_validations_idempotency_key
  ON attribution_validations(idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX attribution_validations_candidate_request
  ON attribution_validations(candidate_version_id, request_hash);
