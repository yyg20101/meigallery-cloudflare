import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  createAdminAppWalletAdjustment,
  previewAdminAppWalletAdjustment,
  reviewAdminAppWalletAdjustment,
} from './admin-app-wallet'
import {
  APP_WALLET_POLICY_ID,
  AppWalletError,
  getAppWalletEntry,
  getAppWalletSummary,
  listAppWalletEntries,
  parseAppWalletEntryListQuery,
  type AppWalletRuntimeConfig,
} from './app-wallet'
import {
  APP_NOTIFICATION_POLICY_ID,
  listAppNotifications,
  parseAppNotificationListQuery,
  type AppNotificationRuntimeConfig,
  type AppNotificationTargetCapabilities,
} from './app-notifications'

const NOTIFICATION_MIGRATION = readFileSync(
  new URL('../../migrations/0076_app_in_app_notifications.sql', import.meta.url),
  'utf8',
)
const WALLET_MIGRATION = readFileSync(
  new URL('../../migrations/0077_app_wallet_ledger.sql', import.meta.url),
  'utf8',
)
const TEMPLATE_GOVERNANCE_MIGRATION = readFileSync(
  new URL('../../migrations/0097_app_notification_template_governance.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-08T08:00:00.000Z')
const CONFIG: AppWalletRuntimeConfig = {
  enabled: true,
  adminEnabled: true,
  policyId: APP_WALLET_POLICY_ID,
  requireProductionReady: false,
}
const NOTIFICATION_CONFIG: AppNotificationRuntimeConfig = {
  enabled: true,
  adminEnabled: true,
  conversationSettingsEnabled: false,
  policyId: APP_NOTIFICATION_POLICY_ID,
  policyConfigured: true,
  requireProductionReady: false,
}
const NOTIFICATION_CAPABILITIES: AppNotificationTargetCapabilities = {
  messaging: false,
  profiles: false,
  membership: false,
  membershipApplications: false,
  safetyReports: false,
  safetyAppeals: false,
  accountSecurity: false,
  wallet: true,
  dataRights: false,
}

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `app-wallet-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(BASE_SCHEMA))
  await db.exec(executableSql(NOTIFICATION_MIGRATION))
  await db.exec(executableSql(WALLET_MIGRATION))
  await db.exec(executableSql(TEMPLATE_GOVERNANCE_MIGRATION))
  await db.exec(executableSql(`
    INSERT INTO users (id, email, nickname, status, created_at) VALUES
      (1, 'viewer-one@example.com', '观看者一号', 'active', '2026-08-08T00:00:00.000Z'),
      (2, 'viewer-two@example.com', '观看者二号', 'active', '2026-08-08T00:00:00.000Z'),
      (10, 'admin-one@example.com', '管理员甲', 'active', '2026-08-08T00:00:00.000Z'),
      (11, 'admin-two@example.com', '管理员乙', 'active', '2026-08-08T00:00:00.000Z');
    INSERT INTO app_account_security (account_id, account_public_id) VALUES
      (1, 'acc_viewer_one'),
      (2, 'acc_viewer_two');
    INSERT INTO app_operational_safety_controls (
      control_key, display_name, state, version, changed_at
    ) VALUES (
      'wallet_adjustments', '金币调整', 'available', 1, '2026-08-08T00:00:00.000Z'
    );
  `))
}, 30_000)

afterEach(async () => {
  await miniflare.dispose()
}, 30_000)

describe('Wallet-1 追加式账本 D1', () => {
  it('默认策略只允许虚拟零余额查询，不创建钱包或调币申请', async () => {
    const wallet = await getAppWalletSummary(db, 1, CONFIG, NOW)
    expect(wallet).toMatchObject({ balance: 0, ledgerVersion: 0, status: 'active' })
    await expect(count('app_wallets')).resolves.toBe(0)
    await expect(previewAdminAppWalletAdjustment(db, creditInput(), CONFIG))
      .rejects.toMatchObject({ code: 'WALLET_ADJUSTMENTS_DISABLED', status: 403 })
    await expect(count('app_wallet_adjustments')).resolves.toBe(0)
  })

  it('负余额预览不可提交，服务端拒绝创建申请', async () => {
    await enableAdjustments()
    const input = { ...creditInput(), actionType: 'admin_debit', amount: 1 }
    const preview = await previewAdminAppWalletAdjustment(db, input, CONFIG)
    expect(preview).toMatchObject({ balanceBefore: 0, balanceAfter: -1, canSubmit: false })
    expect(preview.riskCodes).toContain('NEGATIVE_BALANCE')
    await expect(createAdminAppWalletAdjustment(
      db,
      10,
      'request-negative-0001',
      input,
      CONFIG,
      NOW,
    )).rejects.toMatchObject({ code: 'NEGATIVE_BALANCE_FORBIDDEN', status: 422 })
  })

  it('申请不改余额，发起人不可自审，独立复核只入账一次', async () => {
    await enableAdjustments()
    const created = await createCredit('request-credit-0001', 'BUSINESS-CREDIT-0001')
    expect(created.adjustment.status).toBe('pending_review')
    await expect(count('app_wallets')).resolves.toBe(0)
    await expect(count('app_wallet_entries')).resolves.toBe(0)
    await expect(reviewAdminAppWalletAdjustment(
      db,
      created.adjustment.adjustmentId,
      10,
      'approve',
      'review-self-0001',
      { expectedVersion: 1, reviewNote: '尝试自行复核' },
      CONFIG,
      NOW,
    )).rejects.toMatchObject({ code: 'SELF_REVIEW_FORBIDDEN', status: 403 })

    const applied = await approve(created.adjustment.adjustmentId, 'review-credit-0001')
    expect(applied.adjustment).toMatchObject({
      status: 'applied',
      balanceBefore: 0,
      balanceAfter: 100,
      currentBalance: 100,
    })
    const replay = await approve(created.adjustment.adjustmentId, 'review-credit-0001')
    expect(replay.replayed).toBe(true)
    await expect(count('app_wallet_entries')).resolves.toBe(1)
    await expect(count('app_wallet_review_requests')).resolves.toBe(1)
    expect((await getAppWalletSummary(db, 1, CONFIG, NOW)).balance).toBe(100)
  })

  it('同一请求幂等键不能绑定不同业务内容', async () => {
    await enableAdjustments()
    await createCredit('request-idempotent-0001', 'BUSINESS-IDEMPOTENT-0001')
    const replay = await createCredit('request-idempotent-0001', 'BUSINESS-IDEMPOTENT-0001')
    expect(replay.replayed).toBe(true)
    await expect(createAdminAppWalletAdjustment(
      db,
      10,
      'request-idempotent-0001',
      { ...creditInput('BUSINESS-IDEMPOTENT-0002'), amount: 101 },
      CONFIG,
      NOW,
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 })
  })

  it('并发旧预览不会覆盖新余额，冲突申请保持待复核', async () => {
    await enableAdjustments()
    const first = await createCredit('request-stale-a-0001', 'BUSINESS-STALE-A')
    const stale = await createCredit('request-stale-b-0001', 'BUSINESS-STALE-B')
    await approve(first.adjustment.adjustmentId, 'review-stale-a-0001')
    await expect(approve(stale.adjustment.adjustmentId, 'review-stale-b-0001'))
      .rejects.toMatchObject({ code: 'WALLET_BALANCE_CHANGED', status: 409 })
    const row = await db.prepare('SELECT status FROM app_wallet_adjustments WHERE id = ?')
      .bind(stale.adjustment.adjustmentId)
      .first<{ status: string }>()
    expect(row?.status).toBe('pending_review')
    await expect(count('app_wallet_entries')).resolves.toBe(1)
  })

  it('完整冲正生成反向分录，原分录和审计事件不可修改', async () => {
    await enableAdjustments()
    const credit = await createCredit('request-reverse-credit', 'BUSINESS-REVERSE-CREDIT')
    const appliedCredit = await approve(credit.adjustment.adjustmentId, 'review-reverse-credit')
    const originalEntryId = appliedCredit.adjustment.entryId!
    const reversal = await createAdminAppWalletAdjustment(
      db,
      10,
      'request-reversal-0001',
      {
        accountId: 'acc_viewer_one',
        actionType: 'reversal',
        originalEntryId,
        userVisibleNote: '撤销原金币调整',
        internalNote: '原业务确认录入错误，执行完整冲正',
        businessReference: 'BUSINESS-REVERSAL-0001',
      },
      CONFIG,
      NOW,
    )
    expect(reversal.adjustment).toMatchObject({ direction: 'debit', amount: 100 })
    await approve(reversal.adjustment.adjustmentId, 'review-reversal-0001')
    expect((await getAppWalletSummary(db, 1, CONFIG, NOW)).balance).toBe(0)
    const detail = await getAppWalletEntry(db, 1, originalEntryId, CONFIG)
    expect(detail.reversalEntryId).toMatch(/^wle_/u)
    await expect(db.prepare('UPDATE app_wallet_entries SET user_visible_note = ? WHERE id = ?')
      .bind('恶意修改', originalEntryId).run()).rejects.toThrow()
    await expect(db.prepare('DELETE FROM app_wallet_entries WHERE id = ?')
      .bind(originalEntryId).run()).rejects.toThrow()
    const secondPreview = await previewAdminAppWalletAdjustment(db, {
      accountId: 'acc_viewer_one',
      actionType: 'reversal',
      originalEntryId,
      userVisibleNote: '再次冲正测试',
      internalNote: '确认同一原分录不能重复执行冲正',
      businessReference: 'BUSINESS-REVERSAL-0002',
    }, CONFIG)
    expect(secondPreview.riskCodes).toContain('ORIGINAL_ENTRY_NOT_REVERSIBLE')
  })

  it('明细游标绑定账号和方向，详情不可跨账号访问', async () => {
    await enableAdjustments()
    const first = await createCredit('request-list-a-0001', 'BUSINESS-LIST-A')
    const firstApplied = await approve(first.adjustment.adjustmentId, 'review-list-a-0001')
    const second = await createCredit('request-list-b-0001', 'BUSINESS-LIST-B')
    await approve(second.adjustment.adjustmentId, 'review-list-b-0001')
    const page = await listAppWalletEntries(
      db,
      1,
      'acc_viewer_one',
      CONFIG,
      parseAppWalletEntryListQuery({ accountScope: 'acc_viewer_one', direction: 'credit', limit: '1' }),
    )
    expect(page.data).toHaveLength(1)
    expect(page.nextCursor).toEqual(expect.any(String))
    expect(() => parseAppWalletEntryListQuery({
      accountScope: 'acc_viewer_two',
      direction: 'credit',
      cursor: page.nextCursor!,
    })).toThrowError(AppWalletError)
    await expect(getAppWalletEntry(db, 2, firstApplied.adjustment.entryId!, CONFIG))
      .rejects.toMatchObject({ code: 'WALLET_ENTRY_NOT_FOUND', status: 404 })
  })

  it('通知总策略开启后才生成金币通知，并使用固定原因文案', async () => {
    await enableAdjustments()
    await db.prepare(`
      UPDATE app_notification_policies
      SET generation_enabled = 1, effective_at = ?
      WHERE id = ?
    `).bind('2026-08-08T00:00:00.000Z', APP_NOTIFICATION_POLICY_ID).run()
    const request = await createCredit('request-notify-0001', 'BUSINESS-NOTIFY-0001')
    const applied = await approve(request.adjustment.adjustmentId, 'review-notify-0001')
    const notifications = await listAppNotifications(
      db,
      1,
      'acc_viewer_one',
      NOTIFICATION_CONFIG,
      NOTIFICATION_CAPABILITIES,
      parseAppNotificationListQuery({ accountScope: 'acc_viewer_one' }),
      NOW,
    )
    expect(notifications.data[0]).toMatchObject({
      eventType: 'wallet.entry_posted',
      title: '金币已增加',
      summary: '金币已增加 100 · 管理员调整',
      target: {
        type: 'wallet_entry',
        id: applied.adjustment.entryId,
        action: 'open_wallet_entry',
        available: true,
      },
    })
  })
})

async function enableAdjustments() {
  await db.prepare('UPDATE app_wallet_policies SET adjustments_enabled = 1 WHERE id = ?')
    .bind(APP_WALLET_POLICY_ID)
    .run()
}

function creditInput(businessReference = 'BUSINESS-CREDIT-DEFAULT') {
  return {
    accountId: 'acc_viewer_one',
    actionType: 'admin_credit',
    amount: 100,
    reasonCode: 'manual_adjustment',
    userVisibleNote: '管理员发放测试金币',
    internalNote: 'Wallet-1 自动化测试所需的人工调币记录',
    businessReference,
  }
}

function createCredit(idempotencyKey: string, businessReference: string) {
  return createAdminAppWalletAdjustment(
    db,
    10,
    idempotencyKey,
    creditInput(businessReference),
    CONFIG,
    NOW,
  )
}

function approve(adjustmentId: string, idempotencyKey: string) {
  return reviewAdminAppWalletAdjustment(
    db,
    adjustmentId,
    11,
    'approve',
    idempotencyKey,
    { expectedVersion: 1, reviewNote: '独立管理员复核通过' },
    CONFIG,
    NOW,
  )
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
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE app_account_security (
    account_id INTEGER PRIMARY KEY,
    account_public_id TEXT NOT NULL UNIQUE
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
