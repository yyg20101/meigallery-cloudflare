import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('./0003_queue_runtime.sql', import.meta.url)

test('Queue 运行 Schema 持久化平台回执和连续故障窗口', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /CREATE TABLE attribution_delivery_receipts/i,
  )
  assert.match(
    migration,
    /UNIQUE\s*\(delivery_id,\s*attempt_count\)/i,
  )
  assert.match(
    migration,
    /CREATE TABLE attribution_circuit_observations/i,
  )
  assert.match(
    migration,
    /consecutive_transient_failures\s+INTEGER\s+NOT NULL/i,
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX attribution_incidents_one_open_server_code/i,
  )
  assert.doesNotMatch(
    migration,
    /\b(access_token|email|client_ip|user_agent|payload_json)\b/i,
  )
})
