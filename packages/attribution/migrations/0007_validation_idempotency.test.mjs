import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  './0007_validation_idempotency.sql',
  import.meta.url,
)

test('候选验证具备独立幂等键和脱敏请求摘要', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /ALTER TABLE attribution_validations[\s\S]*ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''/i,
  )
  assert.match(
    migration,
    /ALTER TABLE attribution_validations[\s\S]*ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''/i,
  )
  assert.match(
    migration,
    /UPDATE attribution_validations[\s\S]*idempotency_key = 'legacy-validation:' \|\| id[\s\S]*request_hash = lower\(hex\(randomblob\(32\)\)\)/i,
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX attribution_validations_idempotency_key[\s\S]*WHERE idempotency_key <> ''/i,
  )
  assert.doesNotMatch(
    migration,
    /\b(test_event_code|access_token|credential_plaintext)\b/i,
  )
})
