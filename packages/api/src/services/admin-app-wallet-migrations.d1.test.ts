import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  createAdminAppWalletAdjustment,
  reviewAdminAppWalletAdjustment,
} from './admin-app-wallet'
import {
  createAdminAppWalletLegacyDryRun,
  executeAdminAppWalletLegacyJob,
  reviewAdminAppWalletLegacyItem,
  submitAdminAppWalletLegacyJob,
} from './admin-app-wallet-migrations'
import {
  APP_WALLET_POLICY_ID,
  getAppWalletSummary,
  type AppWalletRuntimeConfig,
} from './app-wallet'

const NOTIFICATION_MIGRATION = readFileSync(
  new URL('../../migrations/0076_app_in_app_notifications.sql', import.meta.url),
  'utf8',
)
const WALLET_MIGRATION = readFileSync(
  new URL('../../migrations/0077_app_wallet_ledger.sql', import.meta.url),
  'utf8',
)
const LEGACY_MIGRATION = readFileSync(
  new URL('../../migrations/0111_app_wallet_legacy_migrations.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-20T08:00:00.000Z')
const CONFIG: AppWalletRuntimeConfig = {
  enabled: true,
  adminEnabled: true,
  policyId: APP_WALLET_POLICY_ID,
  requireProductionReady: false,
}
const CREATOR = { id: 10, role: 'owner' }
const REVIEWER = { id: 11, role: 'owner' }
const EXECUTOR = { id: 12, role: 'owner' }

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `app-wallet-legacy-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(BASE_SCHEMA))
  await db.exec(executableSql(NOTIFICATION_MIGRATION))
  await db.exec(executableSql(WALLET_MIGRATION))
  await db.exec(executableSql(LEGACY_MIGRATION))
  await db.exec(executableSql(`
    INSERT INTO users (id, email, nickname, role, status, created_at) VALUES
      (1, 'viewer-one@example.com', '观看者一号', 'user', 'active', '2026-08-20T00:00:00.000Z'),
      (2, 'viewer-two@example.com', '观看者二号', 'user', 'active', '2026-08-20T00:00:00.000Z'),
      (10, 'owner-one@example.com', 'Owner 甲', 'owner', 'active', '2026-08-20T00:00:00.000Z'),
      (11, 'owner-two@example.com', 'Owner 乙', 'owner', 'active', '2026-08-20T00:00:00.000Z'),
      (12, 'owner-three@example.com', 'Owner 丙', 'owner', 'active', '2026-08-20T00:00:00.000Z');
    INSERT INTO app_account_security (account_id, account_public_id, status) VALUES
      (1, 'acc_viewer_one', 'active'),
      (2, 'acc_viewer_two', 'active');
    INSERT INTO app_operational_safety_controls (
      control_key, display_name, state, version, changed_at
    ) VALUES (
      'wallet_adjustments', '金币调整', 'available', 1, '2026-08-20T00:00:00.000Z'
    );
  `))
  await db.prepare('UPDATE app_wallet_policies SET adjustments_enabled = 1 WHERE id = ?')
    .bind(APP_WALLET_POLICY_ID)
    .run()
}, 30_000)

afterEach(async () => {
  await miniflare.dispose()
}, 30_000)

describe('Wallet-4 旧余额显式迁移 D1', () => {
  it('默认只允许 Dry-run 与独立复核，正式执行保持关闭', async () => {
    const ready = await createReadyJob()

    await expect(executeAdminAppWalletLegacyJob(
      db,
      ready.job.jobId,
      EXECUTOR,
      'wallet.migration.execute.disabled.0001',
      { expectedVersion: ready.job.version },
      CONFIG,
      NOW,
    )).rejects.toMatchObject({ code: 'WALLET_MIGRATION_EXECUTION_DISABLED', status: 403 })

    await expect(getAppWalletSummary(db, 1, CONFIG, NOW)).resolves.toMatchObject({ balance: 0, ledgerVersion: 0 })
    await expect(count('app_wallet_entries')).resolves.toBe(0)
  })

  it('完整执行只写一次普通不可变分录，并由侧表永久标记为旧余额迁移', async () => {
    const ready = await createReadyJob()
    await enableExecution()

    const executed = await executeAdminAppWalletLegacyJob(
      db,
      ready.job.jobId,
      EXECUTOR,
      'wallet.migration.execute.enabled.0001',
      { expectedVersion: ready.job.version },
      CONFIG,
      NOW,
    )
    expect(executed.workspace.job.status).toBe('completed')
    expect(executed.workspace.items[0]).toMatchObject({
      status: 'migrated',
      sourceBalance: 125,
      targetAccountId: 'acc_viewer_one',
    })
    expect(executed.refreshedAccountIds).toEqual(['acc_viewer_one'])
    await expect(getAppWalletSummary(db, 1, CONFIG, NOW)).resolves.toMatchObject({ balance: 125, ledgerVersion: 1 })

    const entry = await db.prepare(`
      SELECT entry.action_type, entry.reason_code, entry.amount,
             entry.business_reference, link.item_id
      FROM app_wallet_entries entry
      JOIN app_wallet_legacy_migration_links link ON link.adjustment_id = entry.adjustment_id
      LIMIT 1
    `).first<{
      action_type: string
      reason_code: string
      amount: number
      business_reference: string
      item_id: string
    }>()
    expect(entry).toMatchObject({
      action_type: 'admin_credit',
      reason_code: 'correction',
      amount: 125,
      item_id: executed.workspace.items[0]!.itemId,
    })
    expect(entry?.business_reference).toBe(`legacy:${executed.workspace.items[0]!.itemId}`)

    await disableExecution()
    const replay = await executeAdminAppWalletLegacyJob(
      db,
      ready.job.jobId,
      EXECUTOR,
      'wallet.migration.execute.enabled.0001',
      { expectedVersion: ready.job.version },
      CONFIG,
      NOW,
    )
    expect(replay.replayed).toBe(true)
    await expect(count('app_wallet_entries')).resolves.toBe(1)
  })

  it('冻结迁移申请后目标账本发生变化时先拒绝申请，再把条目标记为 stale', async () => {
    const ready = await createReadyJob()
    await enableExecution()
    const item = ready.items[0]!
    const frozen = await createAdminAppWalletAdjustment(
      db,
      CREATOR.id,
      `wallet.migration.adjustment:${item.itemId}`,
      {
        accountId: item.targetAccountId,
        actionType: 'admin_credit',
        amount: item.sourceBalance,
        reasonCode: 'correction',
        userVisibleNote: '旧版金币余额迁移',
        internalNote: `受控旧余额迁移 ${ready.job.jobId}/${item.itemId}`,
        businessReference: `legacy:${item.itemId}`,
      },
      CONFIG,
      NOW,
      { legacyMigrationItemId: item.itemId },
    )
    await createNormalEntryForFirstAccount()

    const executed = await executeAdminAppWalletLegacyJob(
      db,
      ready.job.jobId,
      EXECUTOR,
      'wallet.migration.execute.stale.0001',
      { expectedVersion: ready.job.version },
      CONFIG,
      NOW,
    )

    expect(executed.workspace.job.status).toBe('partial_failed')
    expect(executed.workspace.items[0]).toMatchObject({
      status: 'stale',
      failure: { code: 'TARGET_LEDGER_NOT_EMPTY' },
    })
    expect(executed.refreshedAccountIds).toEqual([])
    await expect(db.prepare('SELECT status FROM app_wallet_adjustments WHERE id = ?')
      .bind(frozen.adjustment.adjustmentId)
      .first<{ status: string }>()).resolves.toMatchObject({ status: 'rejected' })
    await expect(getAppWalletSummary(db, 1, CONFIG, NOW)).resolves.toMatchObject({ balance: 7, ledgerVersion: 1 })
    await expect(count('app_wallet_entries')).resolves.toBe(1)
  })

  it('普通调币入口不能创建或复核 legacy 保留业务引用', async () => {
    await expect(createAdminAppWalletAdjustment(
      db,
      CREATOR.id,
      'wallet.normal.legacy-reference.0001',
      {
        accountId: 'acc_viewer_one',
        actionType: 'admin_credit',
        amount: 10,
        reasonCode: 'correction',
        userVisibleNote: '尝试伪装迁移',
        internalNote: '普通调币入口不应接受保留引用',
        businessReference: 'legacy:wlmi_fake',
      },
      CONFIG,
      NOW,
    )).rejects.toMatchObject({ code: 'WALLET_MIGRATION_WORKFLOW_REQUIRED', status: 403 })

    const ready = await createReadyJob()
    await enableExecution()
    const executed = await executeAdminAppWalletLegacyJob(
      db,
      ready.job.jobId,
      EXECUTOR,
      'wallet.migration.execute.enabled.0002',
      { expectedVersion: ready.job.version },
      CONFIG,
      NOW,
    )
    const item = executed.workspace.items[0]!
    await expect(reviewAdminAppWalletAdjustment(
      db,
      item.resultAdjustmentId!,
      EXECUTOR.id,
      'approve',
      'wallet.normal.review-migration.0001',
      { expectedVersion: 2, reviewNote: '尝试从普通入口重复复核' },
      CONFIG,
      NOW,
    )).rejects.toMatchObject({ code: 'WALLET_MIGRATION_WORKFLOW_REQUIRED', status: 403 })
  })

  it('目标不存在、重复映射或已有分录时逐项冲突且不进入复核', async () => {
    await createNormalEntryForSecondAccount()
    const result = await createAdminAppWalletLegacyDryRun(
      db,
      CREATOR,
      'wallet.migration.dry-run.conflicts.0001',
      {
        sourceName: 'legacy-wallet-conflicts.csv',
        sourceSystem: 'legacy_web',
        extractedAt: '2026-08-20T07:00:00.000Z',
        mappingRule: 'legacy-account-id-to-app-public-id-v1',
        rows: [
          sourceRow('legacy-404', 'acc_missing', 30),
          sourceRow('legacy-dup-a', 'acc_viewer_one', 40),
          sourceRow('legacy-dup-b', 'acc_viewer_one', 50),
          sourceRow('legacy-has-ledger', 'acc_viewer_two', 60),
        ],
      },
      CONFIG,
      NOW,
    )
    expect(result.workspace.job.counts).toMatchObject({ draft: 0, conflict: 4 })
    expect(result.workspace.items.map(item => item.conflict?.code)).toEqual([
      'TARGET_ACCOUNT_NOT_FOUND',
      'TARGET_MAPPING_DUPLICATE',
      'TARGET_MAPPING_DUPLICATE',
      'TARGET_LEDGER_NOT_EMPTY',
    ])
    expect(result.workspace.permissions.canSubmit).toBe(false)
  })
})

async function createReadyJob() {
  const dryRun = await createAdminAppWalletLegacyDryRun(
    db,
    CREATOR,
    'wallet.migration.dry-run.ready.0001',
    {
      sourceName: 'legacy-wallet-2026-08-20.csv',
      sourceSystem: 'legacy_web',
      extractedAt: '2026-08-20T07:00:00.000Z',
      mappingRule: 'legacy-account-id-to-app-public-id-v1',
      rows: [sourceRow('legacy-balance-1', 'acc_viewer_one', 125)],
    },
    CONFIG,
    NOW,
  )
  const submitted = await submitAdminAppWalletLegacyJob(
    db,
    dryRun.workspace.job.jobId,
    CREATOR,
    'wallet.migration.submit.ready.0001',
    { expectedVersion: dryRun.workspace.job.version },
    CONFIG,
    NOW,
  )
  return (await reviewAdminAppWalletLegacyItem(
    db,
    submitted.workspace.job.jobId,
    submitted.workspace.items[0]!.itemId,
    REVIEWER,
    'wallet.migration.review.ready.0001',
    { expectedVersion: submitted.workspace.items[0]!.version, decision: 'approve', reviewNote: '来源与目标映射证据完整' },
    CONFIG,
    NOW,
  )).workspace
}

async function enableExecution() {
  await db.prepare(`
    UPDATE app_wallet_legacy_migration_controls
    SET execution_enabled = 1, decision_reference = 'OWNER-WALLET-MIGRATION-TEST',
        approved_by = ?, approved_at = ?, updated_at = ?
    WHERE policy_id = ?
  `).bind(EXECUTOR.id, NOW.toISOString(), NOW.toISOString(), APP_WALLET_POLICY_ID).run()
}

async function disableExecution() {
  await db.prepare(`
    UPDATE app_wallet_legacy_migration_controls
    SET execution_enabled = 0, updated_at = ?
    WHERE policy_id = ?
  `).bind(NOW.toISOString(), APP_WALLET_POLICY_ID).run()
}

async function createNormalEntryForFirstAccount() {
  const created = await createAdminAppWalletAdjustment(
    db,
    CREATOR.id,
    'wallet.normal.first-account.0001',
    {
      accountId: 'acc_viewer_one',
      actionType: 'admin_credit',
      amount: 7,
      reasonCode: 'manual_adjustment',
      userVisibleNote: '迁移冻结后的普通调币',
      internalNote: '用于验证迁移执行前账本变化会安全拒绝冻结申请',
      businessReference: 'NORMAL-FIRST-ACCOUNT-0001',
    },
    CONFIG,
    NOW,
  )
  await reviewAdminAppWalletAdjustment(
    db,
    created.adjustment.adjustmentId,
    EXECUTOR.id,
    'approve',
    'wallet.normal.first-review.0001',
    { expectedVersion: 1, reviewNote: '独立复核普通调币' },
    CONFIG,
    NOW,
  )
}

async function createNormalEntryForSecondAccount() {
  const created = await createAdminAppWalletAdjustment(
    db,
    CREATOR.id,
    'wallet.normal.second-account.0001',
    {
      accountId: 'acc_viewer_two',
      actionType: 'admin_credit',
      amount: 5,
      reasonCode: 'manual_adjustment',
      userVisibleNote: '普通测试调币',
      internalNote: '用于验证旧余额迁移拒绝非空账本',
      businessReference: 'NORMAL-SECOND-ACCOUNT-0001',
    },
    CONFIG,
    NOW,
  )
  await reviewAdminAppWalletAdjustment(
    db,
    created.adjustment.adjustmentId,
    REVIEWER.id,
    'approve',
    'wallet.normal.second-review.0001',
    { expectedVersion: 1, reviewNote: '独立复核普通调币' },
    CONFIG,
    NOW,
  )
}

function sourceRow(sourceRecordId: string, targetAccountId: string, sourceBalance: number) {
  return {
    sourceRecordId,
    sourceAccountReference: `opaque:${sourceRecordId}`,
    targetAccountId,
    sourceBalance,
  }
}

async function count(table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? -1)
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}

const BASE_SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    nickname TEXT,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_account_security (
    account_id INTEGER PRIMARY KEY,
    account_public_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL
  );
  CREATE TABLE admin_audit_logs (
    id TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    before_value TEXT,
    after_value TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_operational_safety_controls (
    control_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    incident_id TEXT,
    reason_code TEXT,
    reason_summary TEXT,
    changed_by INTEGER,
    changed_at TEXT NOT NULL
  );
  CREATE TABLE app_devices (id TEXT PRIMARY KEY);
  CREATE TABLE app_conversations (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL);
  CREATE TABLE app_conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_membership_applications (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL);
  CREATE TABLE app_membership_application_events (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_membership_grants (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    starts_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_membership_grant_revocations (grant_id TEXT PRIMARY KEY, revoked_at TEXT NOT NULL);
  CREATE TABLE app_safety_reports (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL);
  CREATE TABLE app_safety_report_events (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_safety_appeals (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL);
  CREATE TABLE app_safety_appeal_events (
    id TEXT PRIMARY KEY,
    appeal_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_account_security_events (
    id TEXT PRIMARY KEY,
    account_id INTEGER,
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE profile_public_projections (
    profile_id TEXT PRIMARY KEY,
    publication_status TEXT NOT NULL,
    visibility_status TEXT NOT NULL
  );
`
