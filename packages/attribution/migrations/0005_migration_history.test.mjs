import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL(
  './0005_migration_history.sql',
  import.meta.url,
)

test('归因迁移历史只保存匿名日汇总', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE attribution_history_daily/i)
  assert.match(sql, /fact_count INTEGER NOT NULL/i)
  assert.match(sql, /first_occurred_at TEXT NOT NULL/i)
  assert.match(sql, /last_occurred_at TEXT NOT NULL/i)
  assert.doesNotMatch(
    sql,
    /visitor_id|session_id|user_id|email|ip_address|user_agent/i,
  )
})
