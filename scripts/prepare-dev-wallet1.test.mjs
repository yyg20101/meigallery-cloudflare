import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  WALLET1_DEV_DATABASE,
  WALLET1_EXPECTED_PENDING_MIGRATIONS,
  createWallet1DevReadiness,
  main,
  parsePendingMigrations,
  validatePreMigrationBackupSql,
  validateWallet1DevReadinessManifest,
  validateWalletMigrationSources,
  validateWalletRuntimeFlags,
} from './prepare-dev-wallet1.mjs'

const COMMIT = 'a'.repeat(40)
const BOOKMARK = '0000004b-00000000-000050c1-5d3a0b82ee4ac7c4df510c96f93fffee'
const NOW = new Date('2026-08-08T02:30:00.000Z')
const ALL_PENDING_MIGRATIONS = Object.freeze([
  ...WALLET1_EXPECTED_PENDING_MIGRATIONS,
  '0078_app_favorites_and_view_history.sql',
  '0119_legacy_import_processing_lease_guards.sql',
])

describe('Wallet-1 dev readiness', () => {
  it('必须显式确认 dev 数据库，不能把 production 当目标', async () => {
    await assert.rejects(
      createWallet1DevReadiness(baseOptions({ confirmDev: 'meigallery-db' })),
      /WALLET1_READINESS_DEV_CONFIRMATION_REQUIRED/u,
    )

    let output = ''
    const code = await main({
      argv: [],
      stdout: { write: value => { output += value } },
    })
    assert.equal(code, 1)
    assert.match(output, /WALLET1_READINESS_DEV_CONFIRMATION_REQUIRED/u)
  })

  it('生成仓库外 SQL、哈希、bookmark 和短期 manifest，并可再次校验', async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), 'wallet1-readiness-'))
    try {
      const options = baseOptions({
        backupDir,
        exportDatabase: output => writeFile(output, 'CREATE TABLE example (id TEXT PRIMARY KEY);\n'),
      })
      const created = await createWallet1DevReadiness(options)
      const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'))

      assert.equal(manifest.database, WALLET1_DEV_DATABASE)
      assert.equal(manifest.git.commit, COMMIT)
      assert.deepEqual(manifest.pendingMigrations, ALL_PENDING_MIGRATIONS)
      assert.equal(manifest.timeTravelBookmark, BOOKMARK)
      assert.equal(manifest.verifiedBoundary.walletUserRuntimeEnabled, false)
      assert.equal(manifest.verifiedBoundary.immutableLedgerCleanup, 'time_travel_or_disposable_database_only')
      assert.match(manifest.backup.sha256, /^[0-9a-f]{64}$/u)

      const validated = await validateWallet1DevReadinessManifest(created.manifestPath, options)
      assert.equal(validated.status, 'passed')
      assert.equal(validated.gitCommit, COMMIT)
    }
    finally {
      await rm(backupDir, { recursive: true, force: true })
    }
  })

  it('拒绝 migration 顺序变化、bookmark 变化和过期 manifest', async () => {
    const backupDir = await mkdtemp(path.join(tmpdir(), 'wallet1-readiness-'))
    try {
      await assert.rejects(
        createWallet1DevReadiness(baseOptions({
          backupDir,
          listPendingMigrations: async () => ['0077_app_wallet_ledger.sql'],
        })),
        /WALLET1_READINESS_PENDING_MIGRATIONS_UNEXPECTED/u,
      )
      await assert.rejects(
        createWallet1DevReadiness(baseOptions({
          backupDir,
          listPendingMigrations: async () => ALL_PENDING_MIGRATIONS.slice(0, -1),
        })),
        /WALLET1_READINESS_PENDING_MIGRATIONS_UNEXPECTED/u,
      )

      const options = baseOptions({
        backupDir,
        exportDatabase: output => writeFile(output, 'CREATE TABLE example (id TEXT PRIMARY KEY);\n'),
      })
      const created = await createWallet1DevReadiness(options)

      await assert.rejects(
        validateWallet1DevReadinessManifest(created.manifestPath, {
          ...options,
          getBookmark: async () => '0000004c-00000000-000050c1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
        /WALLET1_READINESS_BOOKMARK_CHANGED/u,
      )
      await assert.rejects(
        validateWallet1DevReadinessManifest(created.manifestPath, {
          ...options,
          now: () => new Date('2026-08-08T03:00:00.001Z'),
        }),
        /WALLET1_READINESS_MANIFEST_EXPIRED/u,
      )
    }
    finally {
      await rm(backupDir, { recursive: true, force: true })
    }
  })

  it('解析 Wrangler 表格但保持 migration 顺序和去重', () => {
    const output = `
      │ 0075_app_membership_applications.sql │
      │ 0076_app_in_app_notifications.sql    │
      │ 0077_app_wallet_ledger.sql           │
      │ 0077_app_wallet_ledger.sql           │
    `
    assert.deepEqual(parsePendingMigrations(output), WALLET1_EXPECTED_PENDING_MIGRATIONS)
  })

  it('拒绝已经存在钱包 schema 的备份和 Wallet-1 业务 seed', () => {
    assert.throws(
      () => validatePreMigrationBackupSql('CREATE TABLE app_wallets (id TEXT PRIMARY KEY);'),
      /WALLET1_READINESS_BACKUP_ALREADY_HAS_WALLET_SCHEMA/u,
    )

    const sources = validMigrationSources()
    assert.throws(
      () => validateWalletMigrationSources({
        ...sources,
        wallet: `${sources.wallet}\nINSERT INTO app_wallet_adjustment_events (id) VALUES ('wae_1');`,
      }),
      /WALLET1_READINESS_0077_BUSINESS_SEED_FORBIDDEN/u,
    )
  })

  it('production/dev 钱包运行时开关必须保持关闭且策略一致', () => {
    const block = `
APP_WALLET_ENABLED = "false"
APP_WALLET_ADMIN_ENABLED = "false"
APP_WALLET_POLICY_VERSION = "wlp_app_1_0_wallet_1_dev_1"
APP_WALLET_PRODUCTION_READY = "false"
`.trim()
    const source = `[vars]\n${block}\n\n[env.dev.vars]\n${block}`
    assert.equal(validateWalletRuntimeFlags(source), true)
    assert.throws(
      () => validateWalletRuntimeFlags(source.replace('APP_WALLET_ENABLED = "false"', 'APP_WALLET_ENABLED = "true"')),
      /WALLET1_READINESS_RUNTIME_FLAGS_NOT_CLOSED/u,
    )
  })
})

function baseOptions(overrides = {}) {
  return {
    confirmDev: WALLET1_DEV_DATABASE,
    now: () => NOW,
    getRepositoryState: async () => ({ commit: COMMIT, branch: 'dev', trackedStatus: '' }),
    validateLocalBoundary: async () => ({ databaseId: 'dev-database-id' }),
    listPendingMigrations: async () => [...ALL_PENDING_MIGRATIONS],
    listExpectedPendingMigrations: async () => [...ALL_PENDING_MIGRATIONS],
    getBookmark: async () => BOOKMARK,
    exportDatabase: output => writeFile(output, 'CREATE TABLE example (id TEXT PRIMARY KEY);\n'),
    ...overrides,
  }
}

function validMigrationSources() {
  return {
    membershipApplications: 'CREATE TABLE app_membership_applications (id TEXT);',
    notifications: 'CREATE TABLE app_notification_event_definitions (id TEXT);',
    wallet: `
CREATE TABLE app_wallet_policies (id TEXT);
CREATE TABLE app_wallets (id TEXT);
CREATE TABLE app_wallet_adjustments (id TEXT);
CREATE TABLE app_wallet_entries (id TEXT);
CREATE TABLE app_wallet_adjustment_events (id TEXT);
CREATE TABLE app_wallet_review_requests (id TEXT);
CREATE TRIGGER trg_app_wallet_entries_immutable_update BEFORE UPDATE ON app_wallet_entries BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_entries_immutable_delete BEFORE DELETE ON app_wallet_entries BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_balance_requires_entry BEFORE UPDATE ON app_wallets BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_adjustment_events_immutable_update BEFORE UPDATE ON app_wallet_adjustment_events BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_adjustment_events_immutable_delete BEFORE DELETE ON app_wallet_adjustment_events BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_review_requests_immutable_update BEFORE UPDATE ON app_wallet_review_requests BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_review_requests_immutable_delete BEFORE DELETE ON app_wallet_review_requests BEGIN SELECT 1; END;
CREATE TRIGGER trg_app_wallet_entry_notification_outbox AFTER INSERT ON app_wallet_entries BEGIN SELECT 1; END;
SELECT 'wlp_app_1_0_wallet_1_dev_1', 'unresolved';
`.trim(),
  }
}
