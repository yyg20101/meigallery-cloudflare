import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('./0004_runtime_state.sql', import.meta.url)

test('运行时状态只使用 D1 单行状态机且默认 shadow', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  assert.match(
    migration,
    /CREATE TABLE attribution_runtime_state/i,
  )
  assert.match(
    migration,
    /PRIMARY KEY CHECK\s*\(\s*id\s*=\s*'global'\s*\)/i,
  )
  assert.match(
    migration,
    /CHECK\s*\(\s*mode\s+IN\s*\(\s*'shadow'\s*,\s*'bridge'\s*,\s*'active'\s*\)\s*\)/i,
  )
  assert.match(
    migration,
    /INSERT INTO attribution_runtime_state[\s\S]*'global'\s*,\s*'shadow'/i,
  )
  assert.doesNotMatch(
    migration,
    /\b(commit_sha|revision|git_commit|deployment_id)\b/i,
  )
})
