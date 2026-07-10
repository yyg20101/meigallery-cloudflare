import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const apiDir = dirname(migrationDir)
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-conversion-0038-'))
const migrationCopyDir = join(tempDir, 'migrations')
const persistDir = join(tempDir, 'd1')
const configPath = join(tempDir, 'wrangler.toml')
const databaseName = 'meigallery-conversion-0038-test'
let schemaSummary

before(() => {
  mkdirSync(migrationCopyDir)
  const migrations = readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 38)
    .sort()
  assert.equal(migrations.length, 38)
  for (const name of migrations) copyFileSync(join(migrationDir, name), join(migrationCopyDir, name))
  writeFileSync(configPath, `
name = "${databaseName}"
compatibility_date = "2026-05-26"

[[d1_databases]]
binding = "DB"
database_name = "${databaseName}"
database_id = "00000000-0000-0000-0000-000000000038"
migrations_dir = "migrations"
`)

  applyMigrations()
  schemaSummary = queryJson(`
    SELECT
      (SELECT count(*) FROM pragma_table_info('analytics_conversion_dedupe_claims')) AS column_count,
      (SELECT count(*) FROM pragma_index_list('analytics_conversion_dedupe_claims')
        WHERE name = 'sqlite_autoindex_analytics_conversion_dedupe_claims_1' AND [unique] = 1) AS primary_index_count,
      (SELECT count(*) FROM pragma_index_list('analytics_conversion_dedupe_claims')
        WHERE name = 'idx_analytics_conversion_dedupe_claims_expiry') AS expiry_index_count
  `)[0]
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0038 conversion dedupe claim migration', () => {
  it('按真实顺序创建唯一 claim 与过期索引', () => {
    assert.equal(schemaSummary.column_count, 5)
    assert.equal(schemaSummary.primary_index_count, 1)
    assert.equal(schemaSummary.expiry_index_count, 1)
  })

  it('只允许严格 ISO 时间且 expires_at 必须晚于 claimed_at', () => {
    executeSql(`
      INSERT INTO analytics_conversion_dedupe_claims (
        dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
      ) VALUES (
        '${'a'.repeat(64)}', 'conv_owner_migration', '${'b'.repeat(32)}',
        '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'
      );
    `)
    for (const [dedupeDigest, claimToken, claimedAt, expiresAt] of [
      ['c'.repeat(64), 'd'.repeat(31), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['c'.repeat(64), 'd'.repeat(33), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['c'.repeat(64), `${'d'.repeat(31)}G`, '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['c'.repeat(64), 'D'.repeat(32), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['c'.repeat(63), 'd'.repeat(32), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['c'.repeat(65), 'd'.repeat(32), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      [`${'c'.repeat(63)}G`, 'd'.repeat(32), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['C'.repeat(64), 'd'.repeat(32), '2026-07-11T00:00:00.000Z', '2026-07-11T00:01:00.000Z'],
      ['e'.repeat(64), 'f'.repeat(32), '2026-07-11 00:00:00', '2026-07-11T00:01:00.000Z'],
      ['f'.repeat(64), '0'.repeat(32), '2026-07-11T00:02:00.000Z', '2026-07-11T00:01:00.000Z'],
    ]) {
      assert.throws(() => executeSql(`
        INSERT INTO analytics_conversion_dedupe_claims (
          dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
        ) VALUES (
          '${dedupeDigest}', 'conv_owner_invalid', '${claimToken}', '${claimedAt}', '${expiresAt}'
        );
      `))
    }
  })

  it('同一 dedupe digest 不能出现两个 owner，且重复执行 migration gate 安全', () => {
    assert.throws(() => executeSql(`
      INSERT INTO analytics_conversion_dedupe_claims (
        dedupe_digest, owner_action_id, claim_token, claimed_at, expires_at
      ) VALUES (
        '${'a'.repeat(64)}', 'conv_other_owner', '${'c'.repeat(32)}',
        '2026-07-11T00:00:10.000Z', '2026-07-11T00:01:10.000Z'
      );
    `))
    applyMigrations()
  })
})

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
  }
  catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr).trim()
      : ''
    throw new Error(`Wrangler 本地 D1 命令失败${stderr ? `: ${stderr}` : ''}`, { cause: error })
  }
}
