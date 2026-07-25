import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  './0006_runtime_owner_epoch.sql',
  import.meta.url,
)

test('owner epoch 同时约束状态、投递资格和 fenced 清理', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /mode IN \('shadow', 'bridge', 'active', 'fenced'\)/i,
  )
  assert.match(
    migration,
    /WHEN mode IN \('bridge', 'active'\) THEN 2/i,
  )
  assert.match(
    migration,
    /WHEN mode = 'active' THEN 3/i,
  )
  assert.match(
    migration,
    /CREATE VIEW attribution_runtime_dispatchable_deliveries/i,
  )
  assert.match(
    migration,
    /ALTER TABLE attribution_deliveries[\s\S]*ADD COLUMN runtime_owner_epoch INTEGER NOT NULL DEFAULT 1[\s\S]*CHECK\s*\(\s*runtime_owner_epoch >= 1\s*\)/i,
  )
  assert.match(
    migration,
    /runtime_owner_epoch = 1[\s\S]*status IN\s*\(\s*'planned'\s*,\s*'queued'\s*,\s*'retrying'\s*\)/i,
  )
  assert.match(
    migration,
    /CREATE TRIGGER attribution_deliveries_require_runtime_owner_epoch_insert[\s\S]*NEW\.runtime_owner_epoch < 2[\s\S]*RAISE\s*\(\s*ABORT\s*,\s*'runtime_owner_epoch_required'\s*\)/i,
  )
  assert.match(
    migration,
    /delivery\.runtime_owner_epoch IN\s*\(\s*runtime\.bridge_owner_epoch,\s*runtime\.active_owner_epoch\s*\)/i,
  )
  assert.match(
    migration,
    /runtime\.mode = 'bridge'[\s\S]*delivery\.runtime_owner_epoch = runtime\.bridge_owner_epoch/i,
  )
  assert.match(
    migration,
    /runtime\.mode = 'shadow'[\s\S]*delivery\.runtime_owner_epoch = 2/i,
  )
  assert.match(
    migration,
    /CREATE TRIGGER attribution_runtime_fence_cancel_server_deliveries/i,
  )
  assert.match(
    migration,
    /NEW\.mode = 'fenced'[\s\S]*status = 'cancelled'[\s\S]*last_error_code = 'runtime_fenced'[\s\S]*DELETE FROM attribution_outbox/i,
  )
  assert.doesNotMatch(
    migration,
    /\b(commit_sha|revision|git_commit|deployment_id)\b/i,
  )
})
