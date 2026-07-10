import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-meta-0037-'))
const migrationCopyDir = join(tempDir, 'migrations')
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-meta-0037-test'
const REVISION_A = '1'.repeat(32)
const REVISION_B = '2'.repeat(32)
let initial
let summary

before(() => {
  mkdirSync(migrationCopyDir)
  const migrations = readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 37)
    .sort()
  assert.equal(migrations.length, 37)
  for (const name of migrations) copyFileSync(join(migrationDir, name), join(migrationCopyDir, name))
  appendHistoricalFixture()
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000037"
migrations_dir = "migrations"
`)

  applyMigrations()
  initial = queryJson(`
    SELECT
      (SELECT revision FROM meta_connection_verifications WHERE environment = 'dev') AS verification_revision,
      (SELECT meta_connection_revision FROM analytics_conversion_deliveries WHERE id = 'delivery_legacy_revision') AS delivery_revision,
      (SELECT count(*) FROM pragma_table_info('meta_connection_verifications') WHERE name = 'revision') AS verification_column_count,
      (SELECT count(*) FROM pragma_table_info('analytics_conversion_deliveries') WHERE name = 'meta_connection_revision') AS delivery_column_count,
      (SELECT count(*) FROM pragma_index_list('meta_connection_verifications') WHERE name = 'idx_meta_connection_verifications_revision' AND [unique] = 1) AS revision_unique_index_count
  `)[0]
  prepareAssertions()
  summary = queryJson(`
    SELECT
      (SELECT revision FROM meta_connection_verifications WHERE environment = 'dev') AS dev_revision,
      (SELECT revision FROM meta_connection_verifications WHERE environment = 'production') AS production_revision,
      (SELECT meta_connection_revision FROM analytics_conversion_deliveries WHERE id = 'delivery_bound_revision') AS delivery_revision
  `)[0]
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0037 MetaConnection revision migration', () => {
  it('真实顺序迁移保留历史 verification 与 delivery 的空 revision', () => {
    assert.equal(initial.verification_revision, null)
    assert.equal(initial.delivery_revision, null)
    assert.equal(initial.verification_column_count, 1)
    assert.equal(initial.delivery_column_count, 1)
  })

  it('建立 verification revision 唯一索引并接受合法绑定', () => {
    assert.equal(initial.revision_unique_index_count, 1)
    assert.equal(summary.dev_revision, REVISION_A)
    assert.equal(summary.production_revision, REVISION_B)
    assert.equal(summary.delivery_revision, REVISION_B)
  })

  it('verification 和 delivery 均拒绝错误长度、非小写 hex revision', () => {
    for (const revision of ['short', 'g'.repeat(32), 'A'.repeat(32)]) {
      assert.throws(() => executeSql(`
        UPDATE meta_connection_verifications SET revision = '${revision}' WHERE environment = 'dev';
      `))
      assert.throws(() => executeSql(`
        UPDATE analytics_conversion_deliveries SET meta_connection_revision = '${revision}' WHERE id = 'delivery_bound_revision';
      `))
    }
  })

  it('唯一索引拒绝不同环境复用同一 verification revision', () => {
    assert.throws(() => executeSql(`
      UPDATE meta_connection_verifications SET revision = '${REVISION_A}' WHERE environment = 'production';
    `))
  })

  it('Wrangler 可按真实顺序重复执行 migration gate', () => {
    applyMigrations()
  })
})

function appendHistoricalFixture() {
  const migrationPath = join(migrationCopyDir, '0036_meta_capi_v2_secure_delivery.sql')
  writeFileSync(migrationPath, `${readFileSync(migrationPath, 'utf8')}

INSERT INTO meta_connection_verifications (
  environment, pixel_id, token_fingerprint, graph_api_version,
  verified_event_name, verified_commit, verified_at
) VALUES (
  'dev', '1234567890', lower(hex(randomblob(32))), 'v25.0',
  'Contact', lower(hex(randomblob(20))), '2026-07-11 00:00:00'
);

INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date)
VALUES ('conversion_legacy_revision', 'contact', 'dedupe_legacy_revision', '2026-07-11 00:00:00', '2026-07-11');

INSERT INTO analytics_conversion_deliveries (
  id, conversion_action_id, channel, external_event_id, event_name, tracking_mode
) VALUES (
  'delivery_legacy_revision', 'conversion_legacy_revision', 'meta_capi',
  'event_legacy_revision', 'Contact', 'test'
);
`)
}

function prepareAssertions() {
  executeSql(`
    UPDATE meta_connection_verifications
    SET revision = '${REVISION_A}'
    WHERE environment = 'dev';

    INSERT INTO meta_connection_verifications (
      environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, verified_at, revision
    ) VALUES (
      'production', '1234567890', lower(hex(randomblob(32))), 'v25.0',
      'Contact', lower(hex(randomblob(20))), '2026-07-11 00:00:00', '${REVISION_B}'
    );

    INSERT INTO analytics_conversion_actions (id, action_type, dedupe_key, occurred_at, date)
    VALUES ('conversion_bound_revision', 'contact', 'dedupe_bound_revision', '2026-07-11 00:01:00', '2026-07-11');

    INSERT INTO analytics_conversion_deliveries (
      id, conversion_action_id, channel, external_event_id, event_name,
      tracking_mode, meta_connection_revision
    ) VALUES (
      'delivery_bound_revision', 'conversion_bound_revision', 'meta_capi',
      'event_bound_revision', 'Contact', 'production', '${REVISION_B}'
    );
  `)
}

function applyMigrations() {
  return runWrangler(['d1', 'migrations', 'apply', databaseName, '--config', configPath, '--local', '--persist-to', persistDir])
}

function executeSql(command) {
  return runWrangler(['d1', 'execute', databaseName, '--config', configPath, '--local', '--persist-to', persistDir, '--command', command, '--json'])
}

function queryJson(command) {
  return JSON.parse(executeSql(command))[0].results
}

function runWrangler(args) {
  try {
    return execFileSync('corepack', ['pnpm', 'exec', 'wrangler', ...args], {
      cwd: apiDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).trim()
      : ''
    throw new Error(`Wrangler 本地 D1 命令失败${stderr ? `: ${stderr}` : ''}`, { cause: error })
  }
}
