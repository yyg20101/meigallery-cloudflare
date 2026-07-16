import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const migrationPath = join(migrationDir, '0052_unified_attribution_contract.sql')
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0052-'))
const migrationCopyDir = join(tempDir, 'migrations')
const contractPersistDir = join(tempDir, 'contract-d1')
const freshPersistDir = join(tempDir, 'fresh-d1')
const blockedPersistDir = join(tempDir, 'blocked-d1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-attribution-0052-test'
const legacyTables = [
  'ad_platform_connections',
  'ad_platform_secure_outbox',
  'analytics_conversion_actions',
  'analytics_conversion_daily',
  'analytics_conversion_dedupe_claims',
  'analytics_conversion_deliveries',
  'analytics_conversion_delivery_daily',
  'analytics_release_verifications',
  'meta_capi_incidents',
  'meta_capi_secure_outbox',
  'meta_connection_verifications',
  'meta_dataset_quality_snapshots',
  'meta_live_challenges',
  'meta_resource_attestation_tickets',
  'tiktok_connection_verifications',
]

before(() => {
  assert.equal(existsSync(migrationPath), true, '0052 Contract migration 必须存在')
  mkdirSync(migrationCopyDir)
  const migrations = readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 52)
    .sort()
  assert.deepEqual(migrations.map(name => Number(name.slice(0, 4))), Array.from({ length: 52 }, (_, index) => index + 1))
  for (const name of migrations) copyFileSync(join(migrationDir, name), join(migrationCopyDir, name))
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000052"
migrations_dir = "migrations"
`)

  applyMigrations(contractPersistDir, 51)
  seedContractData(contractPersistDir)
  executeFile(contractPersistDir, migrationPath)
  applyMigrations(freshPersistDir, 52)

  applyMigrations(blockedPersistDir, 51)
  executeSql(blockedPersistDir, `
    INSERT INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id
    ) VALUES (
      'unmatched_action', 'contact', 'contact:unmatched',
      '2026-07-16T00:00:00.000Z', '2026-07-16', 'visitor', 'session'
    );
  `)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0052 通用归因 Contract migration', () => {
  it('从空库完整应用 0001 到 0052', () => {
    assert.equal(rows(freshPersistDir, `SELECT COUNT(*) AS count FROM attribution_platform_connections;`)[0].count, 0)
    assert.deepEqual(oldSchemaNames(freshPersistDir), [])
  })

  it('删除旧表、bridge trigger 和 Meta 身份列', () => {
    assert.deepEqual(oldSchemaNames(contractPersistDir), [])
    const triggers = rows(contractPersistDir, `
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND name GLOB 'trg_0049_bridge_*'
      ORDER BY name;
    `)
    assert.deepEqual(triggers, [])
    const userColumns = rows(contractPersistDir, `SELECT name FROM pragma_table_info('users') ORDER BY cid;`)
      .map(row => row.name)
    assert.equal(userColumns.includes('meta_external_id'), false)
    assert.equal(userColumns.includes('conversion_external_id'), true)
  })

  it('保留通用事实、用户身份、审计和迁移后的质量历史', () => {
    assert.deepEqual(rows(contractPersistDir, `
      SELECT id, canonical_event, attribution_provider
      FROM attribution_conversion_facts WHERE id = 'fact_contract';
    `), [{ id: 'fact_contract', canonical_event: 'Contact', attribution_provider: 'meta' }])
    assert.deepEqual(rows(contractPersistDir, `
      SELECT conversion_external_id FROM users WHERE email = 'contract@example.test';
    `), [{ conversion_external_id: 'identity_contract' }])
    assert.equal(rows(contractPersistDir, `SELECT COUNT(*) AS count FROM admin_audit_logs WHERE id = 'audit_contract';`)[0].count, 1)
    assert.deepEqual(rows(contractPersistDir, `
      SELECT provider, canonical_event, metric_key, metric_value, collection_status
      FROM attribution_quality_snapshots WHERE id = 'quality_contract';
    `), [{
      provider: 'meta',
      canonical_event: 'Contact',
      metric_key: 'emq_score',
      metric_value: '8.5',
      collection_status: 'success',
    }])
  })

  it('未完成业务事实回填时拒绝 Contract', () => {
    assert.throws(() => executeFile(blockedPersistDir, migrationPath))
    assert.equal(rows(blockedPersistDir, `
      SELECT COUNT(*) AS count
      FROM analytics_conversion_actions
      WHERE id = 'unmatched_action';
    `)[0].count, 1)
  })

  it('迁移不保留平台专用技术表或兼容触发器定义', () => {
    const sql = readFileSync(migrationPath, 'utf8')
    for (const table of legacyTables) assert.match(sql, new RegExp(`DROP TABLE ${table}`))
    assert.match(sql, /ALTER TABLE users DROP COLUMN meta_external_id/)
    assert.doesNotMatch(sql, /CREATE TRIGGER trg_0049_bridge_/)
  })
})

function seedContractData(persistDir) {
  executeSql(persistDir, `
    INSERT INTO users (
      email, password_hash, role, status, meta_external_id, conversion_external_id
    ) VALUES (
      'contract@example.test', 'hash', 'owner', 'active', 'identity_contract', 'identity_contract'
    );

    INSERT INTO admin_audit_logs (
      id, admin_id, action, target_type, target_id, before_value, after_value
    ) VALUES (
      'audit_contract', 1, 'contract_test', 'attribution', 'contract', '{}', '{}'
    );

    INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
      rollout_target_percentage, rollout_effective_percentage, connection_revision, credential_revision
    ) VALUES (
      'conn_meta', 'meta', 1, 'production', 1, 1, '{"pixelId":"123456789"}',
      10, 10, 'connection_contract', 'credential_contract'
    );

    INSERT INTO analytics_conversion_actions (
      id, action_type, dedupe_key, occurred_at, date, visitor_id, session_id, attribution_provider
    ) VALUES (
      'action_contract', 'contact', 'contact:contract',
      '2026-07-16T00:00:00.000Z', '2026-07-16', 'visitor', 'session', 'meta'
    );

    INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id, attribution_provider,
      attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
    ) VALUES (
      'fact_contract', 'Contact', 'historical_backfill', NULL, 'meta',
      'historical_backfill', '2026-07-16T00:00:00.000Z', 'contact:contract', '{}', '{}'
    );

    INSERT INTO meta_dataset_quality_snapshots (
      id, environment, dataset_id, event_name, metric_key, metric_value,
      collection_status, error_category, collected_at, contract_version, contract_digest
    ) VALUES (
      'quality_contract', 'production', '123456789', 'Contact', 'emq_score', 8.5,
      'success', '', '2026-07-16T00:00:00.000Z', 1,
      'sha256:28ec95b732afb273bd67c96d3e2780ce4ac1ebf40f206db5be2843fa72a685b4'
    );
  `)
}

function oldSchemaNames(persistDir) {
  const placeholders = legacyTables.map(name => `'${name}'`).join(',')
  return rows(persistDir, `
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name IN (${placeholders})
    ORDER BY name;
  `).map(row => row.name)
}

function applyMigrations(persistDir, lastMigration) {
  const selectedDir = join(tempDir, `migrations-${lastMigration}-${persistDir.split('/').at(-1)}`)
  mkdirSync(selectedDir)
  const names = readdirSync(migrationCopyDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= lastMigration)
    .sort()
  for (const name of names) copyFileSync(join(migrationCopyDir, name), join(selectedDir, name))
  const selectedConfigPath = join(tempDir, `wrangler-${lastMigration}-${persistDir.split('/').at(-1)}.toml`)
  writeFileSync(selectedConfigPath, readFileSync(configPath, 'utf8').replace('migrations_dir = "migrations"', `migrations_dir = "${selectedDir}"`))
  runWrangler(persistDir, selectedConfigPath, ['d1', 'migrations', 'apply'])
}

function executeFile(persistDir, file) {
  runWrangler(persistDir, configPath, ['d1', 'execute', '--file', file, '--json'])
}

function executeSql(persistDir, sql) {
  runWrangler(persistDir, configPath, ['d1', 'execute', '--command', sql, '--json'])
}

function rows(persistDir, sql) {
  return JSON.parse(runWrangler(persistDir, configPath, ['d1', 'execute', '--command', sql, '--json']))[0].results
}

function runWrangler(persistDir, selectedConfigPath, args) {
  return execFileSync(
    process.execPath,
    [join(apiDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args, databaseName, '--config', selectedConfigPath, '--local', '--persist-to', persistDir],
    { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}
