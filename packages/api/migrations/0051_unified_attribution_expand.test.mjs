import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const migrationPath = join(migrationDir, '0051_unified_attribution_expand.sql')
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0051-'))
const migrationCopyDir = join(tempDir, 'migrations')
const preExpandPersistDir = join(tempDir, 'pre-expand-d1')
const emptyPersistDir = join(tempDir, 'empty-d1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-attribution-0051-test'
const ATTRIBUTION_TABLES = [
  'attribution_platform_connections',
  'attribution_event_bindings',
  'attribution_credentials',
  'attribution_conversion_facts',
  'attribution_deliveries',
  'attribution_outbox',
  'attribution_provider_receipts',
  'attribution_verifications',
  'attribution_incidents',
  'attribution_quality_snapshots',
  'attribution_usage_daily',
]
let legacySnapshot

before(() => {
  assert.equal(existsSync(migrationPath), true, '0051 Expand migration 必须存在')
  mkdirSync(migrationCopyDir)
  const migrations = readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 51)
    .sort()
  assert.deepEqual(
    migrations.map(name => Number(name.slice(0, 4))),
    Array.from({ length: 51 }, (_, index) => index + 1),
  )
  for (const name of migrations) copyFileSync(join(migrationDir, name), join(migrationCopyDir, name))
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000051"
migrations_dir = "migrations"
`)

  applyMigrations(preExpandPersistDir, 50)
  executeSql(preExpandPersistDir, `
    INSERT INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id
    ) VALUES (
      'action_0051_snapshot', 'contact', 'contact:0051:snapshot',
      '2026-07-15T00:00:00.000Z', '2026-07-15', 'visitor_0051', 'session_0051'
    );
    INSERT INTO analytics_conversion_deliveries (
      id, conversion_action_id, provider, transport, external_event_id, event_name, status
    ) VALUES (
      'delivery_0051_snapshot', 'action_0051_snapshot', 'meta', 'server',
      'legacy:0051:snapshot', 'Contact', 'pending'
    );
  `)
  legacySnapshot = schemaRows(preExpandPersistDir, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger')
      AND tbl_name NOT GLOB 'attribution_*'
    ORDER BY type, name;
  `)
  assert.ok(legacySnapshot.length > 0)

  executeFile(preExpandPersistDir, migrationPath)
  applyMigrations(emptyPersistDir, 51)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0051 通用归因 Expand migration', () => {
  it('从 0001 到 0051 可升级，且生产快照中的旧表和旧 trigger 原样保留', () => {
    assert.deepEqual(schemaRows(preExpandPersistDir, `
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'index', 'trigger')
        AND tbl_name NOT GLOB 'attribution_*'
      ORDER BY type, name;
    `), legacySnapshot)
    assert.equal(schemaRows(preExpandPersistDir, `
      SELECT COUNT(*) AS count
      FROM analytics_conversion_deliveries
      WHERE id = 'delivery_0051_snapshot';
    `)[0].count, 1)
  })

  it('在 production 快照和空库中均建立 11 张最终 attribution 表', () => {
    for (const persistDir of [preExpandPersistDir, emptyPersistDir]) {
      const rows = schemaRows(persistDir, `
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name GLOB 'attribution_*'
        ORDER BY name;
      `)
      assert.deepEqual(rows.map(row => row.name), [...ATTRIBUTION_TABLES].sort())
    }
  })

  it('只创建新表、新索引和新表之间的 trigger', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/i)
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*(?:analytics_|ad_platform_|meta_)/i)
    assert.doesNotMatch(sql, /CREATE\s+TRIGGER\s+(?!attribution_)/i)
    assert.doesNotMatch(sql, /\b(?:ON|REFERENCES)\s+(?:analytics_|ad_platform_|meta_)/i)
  })

  it('provider guard 使用远端 D1 migration query 可解析的单层 trigger', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    const guardNames = [
      'attribution_delivery_provider_guard',
      'attribution_delivery_provider_update_guard',
      'attribution_outbox_provider_guard',
      'attribution_outbox_provider_update_guard',
    ]

    for (const guardName of guardNames) {
      const start = sql.indexOf(`CREATE TRIGGER ${guardName}`)
      const end = sql.indexOf('\nEND;', start)
      assert.notEqual(start, -1, `${guardName} 必须存在`)
      assert.notEqual(end, -1, `${guardName} 必须完整结束`)
      const triggerSql = sql.slice(start, end + '\nEND;'.length)
      assert.match(triggerSql, /\bWHEN\s+NOT\s+EXISTS\s*\(/i)
      assert.doesNotMatch(triggerSql, /\bSELECT\s+CASE\b/i)
    }
  })

  it('provider 是开放字符串，Fact 的 live/historical external_event_id 约束严格生效', () => {
    executeSql(emptyPersistDir, connectionSql('connection_custom', 'future_platform'))
    executeSql(emptyPersistDir, factSql('fact_live', 'live', "'mg3_live'", "'future_platform'"))
    executeSql(emptyPersistDir, factSql('fact_backfill', 'historical_backfill', 'NULL', 'NULL'))

    expectFailure(() => executeSql(emptyPersistDir, factSql('fact_live_missing', 'live', 'NULL', "'future_platform'")), /CHECK constraint failed/)
    expectFailure(() => executeSql(emptyPersistDir, factSql('fact_backfill_external', 'historical_backfill', "'mg3_backfill'", 'NULL')), /CHECK constraint failed/)
    expectFailure(() => executeSql(emptyPersistDir, `
      UPDATE attribution_conversion_facts
      SET attribution_provider = 'another_future_platform'
      WHERE id = 'fact_live';
    `), /ATTRIBUTION_PROVIDER_IMMUTABLE/)
  })

  it("基础设施级 critical incident 允许 NULL connection_id 和 system provider", () => {
    executeSql(emptyPersistDir, `
      INSERT INTO attribution_incidents (
        id, connection_id, provider, status, severity, trigger_code, summary, evidence_json, opened_at
      ) VALUES (
        'incident_infrastructure', NULL, 'system', 'open', 'critical',
        'queue_message_invalid', '广告归因队列基础设施异常',
        '{"queue":"unknown-queue"}', '2026-07-15T00:00:00.000Z'
      );
    `)

    assert.deepEqual(schemaRows(emptyPersistDir, `
      SELECT connection_id, provider, status, severity, evidence_json
      FROM attribution_incidents
      WHERE id = 'incident_infrastructure';
    `), [{
      connection_id: null,
      provider: 'system',
      status: 'open',
      severity: 'critical',
      evidence_json: '{"queue":"unknown-queue"}',
    }])
  })

  it('Fact、Delivery、Outbox provider 必须一致，且 delivery 状态受最终状态机限制', () => {
    executeSql(emptyPersistDir, connectionSql('connection_other', 'another_future_platform'))
    executeSql(emptyPersistDir, deliverySql('delivery_valid', 'fact_live', 'connection_custom', 'future_platform', 'planned'))
    executeSql(emptyPersistDir, outboxSql('delivery_valid', 'future_platform'))

    expectFailure(() => executeSql(emptyPersistDir, deliverySql(
      'delivery_fact_mismatch', 'fact_live', 'connection_custom', 'another_future_platform', 'planned',
    )), /ATTRIBUTION_PROVIDER_MISMATCH/)
    expectFailure(() => executeSql(emptyPersistDir, deliverySql(
      'delivery_connection_mismatch', 'fact_live', 'connection_other', 'future_platform', 'planned',
    )), /ATTRIBUTION_PROVIDER_MISMATCH/)
    expectFailure(() => executeSql(emptyPersistDir, outboxSql('delivery_valid', 'another_future_platform')), /ATTRIBUTION_PROVIDER_MISMATCH/)
    expectFailure(() => executeSql(emptyPersistDir, `
      UPDATE attribution_deliveries
      SET provider = 'another_future_platform'
      WHERE id = 'delivery_valid';
    `), /ATTRIBUTION_PROVIDER_MISMATCH/)
    expectFailure(() => executeSql(emptyPersistDir, `
      UPDATE attribution_outbox
      SET provider = 'another_future_platform'
      WHERE delivery_id = 'delivery_valid';
    `), /ATTRIBUTION_PROVIDER_MISMATCH/)
    expectFailure(() => executeSql(emptyPersistDir, deliverySql(
      'delivery_invalid_status', 'fact_live', 'connection_custom', 'future_platform', 'pending',
    )), /CHECK constraint failed/)
  })
})

function connectionSql(id, provider) {
  return `
    INSERT INTO attribution_platform_connections (
      id, provider, public_config_json, connection_revision, credential_revision
    ) VALUES ('${id}', '${provider}', '{}', 'connection-revision', 'credential-revision');
  `
}

function factSql(id, origin, externalEventId, provider) {
  return `
    INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id, attribution_provider,
      attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
    ) VALUES (
      '${id}', 'Contact', '${origin}', ${externalEventId}, ${provider},
      'managed_link', '2026-07-15T00:00:00.000Z', 'dedupe:${id}', '{}', '{}'
    );
  `
}

function deliverySql(id, factId, connectionId, provider, status) {
  return `
    INSERT INTO attribution_deliveries (
      id, fact_id, connection_id, provider, transport, status
    ) VALUES ('${id}', '${factId}', '${connectionId}', '${provider}', 'server', '${status}');
  `
}

function outboxSql(deliveryId, provider) {
  return `
    INSERT INTO attribution_outbox (
      delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at
    ) VALUES (
      '${deliveryId}', '${provider}', 1, 'key', 'iv', 'ciphertext', 'tag', '2026-07-16T00:00:00.000Z'
    );
  `
}

function applyMigrations(persistDir, lastMigration) {
  const names = readdirSync(migrationCopyDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= lastMigration)
    .sort()
  const selectedDir = join(tempDir, `migrations-${lastMigration}`)
  mkdirSync(selectedDir)
  for (const name of names) copyFileSync(join(migrationCopyDir, name), join(selectedDir, name))
  const selectedConfigPath = join(tempDir, `wrangler-${lastMigration}.toml`)
  writeFileSync(selectedConfigPath, readFileSync(configPath, 'utf8').replace('migrations_dir = "migrations"', `migrations_dir = "migrations-${lastMigration}"`))
  runWrangler(persistDir, selectedConfigPath, ['d1', 'migrations', 'apply'])
}

function executeFile(persistDir, file) {
  runWrangler(persistDir, configPath, ['d1', 'execute', '--file', file, '--json'])
}

function executeSql(persistDir, sql) {
  runWrangler(persistDir, configPath, ['d1', 'execute', '--command', sql, '--json'])
}

function schemaRows(persistDir, sql) {
  return JSON.parse(runWrangler(persistDir, configPath, ['d1', 'execute', '--command', sql, '--json']))[0].results
}

function expectFailure(operation, pattern) {
  assert.throws(operation, error => {
    const output = `${error?.message || ''}\n${String(error?.stdout || '')}\n${String(error?.stderr || '')}`
    assert.match(output, pattern)
    return true
  })
}

function runWrangler(persistDir, selectedConfigPath, args) {
  return execFileSync(
    process.execPath,
    [join(apiDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args, databaseName, '--config', selectedConfigPath, '--local', '--persist-to', persistDir],
    { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}
