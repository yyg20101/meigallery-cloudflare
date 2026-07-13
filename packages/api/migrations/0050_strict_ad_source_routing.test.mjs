import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-routing-0050-'))
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const schemaPath = join(tempDir, 'schema.sql')
const migrationPath = join(migrationDir, '0050_strict_ad_source_routing.sql')
const databaseName = 'meigallery-routing-0050-test'

before(() => {
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000050"
`)
  writeFileSync(schemaPath, `
    CREATE TABLE analytics_tracking_sources (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT 'referral',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO analytics_tracking_sources (id, channel)
    VALUES ('legacy_ad', 'ad'), ('legacy_social', 'social');
    CREATE TABLE analytics_conversion_actions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      action_type TEXT NOT NULL
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY,
      conversion_action_id TEXT NOT NULL,
      provider TEXT NOT NULL
    );
  `)
  executeFile(schemaPath)
  executeFile(migrationPath)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0050 广告来源严格路由 migration', () => {
  it('为来源与转化事实增加限定字段和查询索引', () => {
    const trackingColumns = queryJson('PRAGMA table_info(analytics_tracking_sources)')
    const actionColumns = queryJson('PRAGMA table_info(analytics_conversion_actions)')
    const indexes = queryJson(`SELECT name FROM sqlite_master WHERE type = 'index'`)

    assert.equal(trackingColumns.find(row => row.name === 'ad_provider')?.dflt_value, "''")
    assert.equal(actionColumns.find(row => row.name === 'attribution_provider')?.dflt_value, "''")
    assert.ok(indexes.some(row => row.name === 'idx_tracking_sources_ad_provider'))
    assert.ok(indexes.some(row => row.name === 'idx_conversion_actions_attribution_provider'))
  })

  it('历史未绑定广告来源被明确停用，非广告来源保持有效', () => {
    const rows = queryJson(`
      SELECT id, status, ad_provider
      FROM analytics_tracking_sources
      ORDER BY id
    `)
    assert.deepEqual(rows, [
      { id: 'legacy_ad', status: 'disabled', ad_provider: '' },
      { id: 'legacy_social', status: 'active', ad_provider: '' },
    ])
  })

  it('同平台投递可以写入，跨平台插入和更新均被数据库拒绝', () => {
    executeSql(`
      INSERT INTO analytics_conversion_actions (id, date, action_type, attribution_provider)
      VALUES ('action_meta', '2026-07-13', 'contact', 'meta');
      INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, provider)
      VALUES ('delivery_meta', 'action_meta', 'meta');
    `)

    expectFailure(`
      INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, provider)
      VALUES ('delivery_wrong', 'action_meta', 'tiktok');
    `, /AD_PROVIDER_SOURCE_MISMATCH/)
    expectFailure(`
      UPDATE analytics_conversion_deliveries
      SET provider = 'tiktok'
      WHERE id = 'delivery_meta';
    `, /AD_PROVIDER_SOURCE_MISMATCH/)
    assert.equal(queryJson(`SELECT provider FROM analytics_conversion_deliveries WHERE id = 'delivery_meta'`)[0].provider, 'meta')
  })

  it('migration 先于 Worker 部署时允许旧 Worker 的空来源事实完成原投递', () => {
    executeSql(`
      INSERT INTO analytics_conversion_actions (id, date, action_type)
      VALUES ('action_transition', '2026-07-13', 'contact');
      INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, provider)
      VALUES ('delivery_transition', 'action_transition', 'meta');
    `)
    assert.equal(queryJson(`
      SELECT COUNT(*) AS total
      FROM analytics_conversion_deliveries
      WHERE id = 'delivery_transition'
    `)[0].total, 1)
  })

  it('转化事实的来源一经写入不可修改', () => {
    expectFailure(`
      UPDATE analytics_conversion_actions
      SET attribution_provider = 'tiktok'
      WHERE id = 'action_meta';
    `, /AD_PROVIDER_SOURCE_IMMUTABLE/)
    assert.equal(queryJson(`SELECT attribution_provider FROM analytics_conversion_actions WHERE id = 'action_meta'`)[0].attribution_provider, 'meta')
  })

  it('非法平台值被字段 CHECK 拒绝', () => {
    expectFailure(`
      INSERT INTO analytics_tracking_sources (id, ad_provider)
      VALUES ('source_invalid', 'other');
    `, /CHECK constraint failed/)
  })
})

function executeFile(path) {
  runWrangler(['d1', 'execute', '--file', path, '--json'])
}

function executeSql(sql) {
  runWrangler(['d1', 'execute', '--command', sql, '--json'])
}

function queryJson(sql) {
  return JSON.parse(runWrangler(['d1', 'execute', '--command', sql, '--json']))[0].results
}

function expectFailure(sql, pattern) {
  try {
    executeSql(sql)
    assert.fail('预期 D1 拒绝该写入')
  }
  catch (error) {
    const output = `${error?.message || ''}\n${String(error?.stdout || '')}\n${String(error?.stderr || '')}`
    assert.match(output, pattern)
  }
}

function runWrangler(args) {
  return execFileSync(
    process.execPath,
    [join(apiDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args, databaseName, '--config', configPath, '--local', '--persist-to', persistDir],
    { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}
