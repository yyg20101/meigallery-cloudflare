import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-meta-0040-'))
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const schemaPath = join(tempDir, 'schema.sql')
const seedPath = join(tempDir, 'seed.sql')
const migrationPath = join(migrationDir, '0040_meta_capi_circuit_indexes.sql')
const databaseName = 'meigallery-meta-0040-test'

const WINDOW_QUERIES = {
  attempt: `
    SELECT COUNT(*) AS total_attempt_count
    FROM analytics_conversion_deliveries
    WHERE channel = 'meta_capi'
      AND last_attempt_at >= datetime('now', '-15 minutes')
  `,
  pending: `
    SELECT COUNT(*) AS stale_pending_count
    FROM analytics_conversion_deliveries
    WHERE channel = 'meta_capi'
      AND status = 'pending'
      AND created_at >= datetime('now', '-15 minutes')
      AND created_at < datetime('now', '-10 minutes')
  `,
  duplicate: `
    SELECT COUNT(*) AS duplicate_suppressed_count
    FROM analytics_conversion_deliveries
    WHERE channel = 'meta_capi'
      AND duplicate_suppressed_at >= datetime('now', '-15 minutes')
  `,
  created: `
    SELECT COUNT(*) AS current_created_count
    FROM analytics_conversion_deliveries
    WHERE channel = 'meta_capi'
      AND created_at >= datetime('now', '-15 minutes')
  `,
}

before(() => {
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000040"
`)
  writeFileSync(schemaPath, `
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY,
      conversion_action_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',
      last_attempt_at TEXT,
      duplicate_suppressed_at TEXT,
      created_at TEXT NOT NULL
    );
  `)
  const historicalRows = Array.from({ length: 500 }, (_, index) => `
    ('history_${index}', 'history_action_${index}', 'meta_capi', 'sent', '',
      datetime('now', '-${index + 60} minutes'), NULL, datetime('now', '-${index + 60} minutes'))
  `)
  const currentRows = [
    "('current_sent', 'current_action_1', 'meta_capi', 'sent', '', datetime('now', '-1 minute'), NULL, datetime('now', '-2 minutes'))",
    "('current_failed', 'current_action_2', 'meta_capi', 'failed', 'meta_http_400', datetime('now', '-2 minutes'), NULL, datetime('now', '-3 minutes'))",
    "('current_stale', 'current_action_3', 'meta_capi', 'pending', '', NULL, NULL, datetime('now', '-11 minutes'))",
    "('current_duplicate', 'current_action_4', 'meta_capi', 'sent', '', datetime('now', '-1 minute'), datetime('now', '-1 minute'), datetime('now', '-2 minutes'))",
  ]
  writeFileSync(seedPath, `
    INSERT INTO analytics_conversion_deliveries (
      id, conversion_action_id, channel, status, error_code,
      last_attempt_at, duplicate_suppressed_at, created_at
    ) VALUES ${[...historicalRows, ...currentRows].join(',')};
    ANALYZE;
  `)
  executeFile(schemaPath)
  executeFile(migrationPath)
  executeFile(seedPath)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0040 Meta CAPI Circuit Breaker 时间索引 migration', () => {
  it('migration 为四类 15 分钟窗口建立实际可命中的索引', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    for (const index of [
      'idx_meta_capi_delivery_attempt_window',
      'idx_meta_capi_delivery_pending_window',
      'idx_meta_capi_delivery_duplicate_window',
      'idx_meta_capi_delivery_created_window',
    ]) assert.match(sql, new RegExp(`CREATE INDEX ${index}`))

    const expected = {
      attempt: 'idx_meta_capi_delivery_attempt_window',
      pending: 'idx_meta_capi_delivery_pending_window',
      duplicate: 'idx_meta_capi_delivery_duplicate_window',
      created: 'idx_meta_capi_delivery_created_window',
    }
    for (const [key, query] of Object.entries(WINDOW_QUERIES)) {
      const plan = queryJson(`EXPLAIN QUERY PLAN ${query}`)
      assert.match(plan.map(row => row.detail).join('\n'), new RegExp(expected[key]))
    }
  })

  it('真实 D1 查询只统计窗口内行，500 条历史行不进入结果', () => {
    assert.equal(queryJson(WINDOW_QUERIES.attempt)[0].total_attempt_count, 3)
    assert.equal(queryJson(WINDOW_QUERIES.pending)[0].stale_pending_count, 1)
    assert.equal(queryJson(WINDOW_QUERIES.duplicate)[0].duplicate_suppressed_count, 1)
    assert.equal(queryJson(WINDOW_QUERIES.created)[0].current_created_count, 4)
  })
})

function executeFile(path) {
  runWrangler(['d1', 'execute', '--file', path, '--json'])
}

function queryJson(sql) {
  return JSON.parse(runWrangler(['d1', 'execute', '--command', sql, '--json']))[0].results
}

function runWrangler(args) {
  return execFileSync(
    process.execPath,
    [join(apiDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args, databaseName, '--config', configPath, '--local', '--persist-to', persistDir],
    { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}
