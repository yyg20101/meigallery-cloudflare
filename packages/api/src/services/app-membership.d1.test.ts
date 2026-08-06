import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  grantAdminAppMembership,
  previewAdminAppMembershipGrant,
  revokeAdminAppMembershipGrant,
} from './admin-app-membership'
import {
  APP_MEMBERSHIP_DRAFT_CATALOG_ID,
  getAppMembershipCatalog,
  getAppMembershipSummary,
  resolveAppMembershipSnapshot,
} from './app-membership'

const MIGRATION = readFileSync(
  new URL('../../migrations/0071_app_membership_catalog_and_grants.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-06T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-membership' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE app_account_security (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      account_public_id TEXT NOT NULL UNIQUE
    );
    CREATE TABLE membership_levels (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      rank INTEGER NOT NULL
    );
    CREATE TABLE user_memberships (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      level_id TEXT NOT NULL REFERENCES membership_levels(id),
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT NOT NULL
    );
  `))
  await db.exec(executableSql(MIGRATION))
})

beforeEach(async () => {
  await db.exec(executableSql(`
    DELETE FROM app_membership_admin_requests;
    DELETE FROM app_membership_grant_revocations;
    DELETE FROM app_membership_grants;
    DELETE FROM admin_audit_logs;
    DELETE FROM user_memberships;
    DELETE FROM membership_levels;
    DELETE FROM app_account_security;
    DELETE FROM users;
    INSERT INTO users (id, email, status) VALUES
      (1, 'admin@example.com', 'active'),
      (2, 'viewer@example.com', 'active');
    INSERT INTO app_account_security (user_id, account_public_id)
      VALUES (2, 'acc_membership_viewer');
  `))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('App 五级会员目录与手动发放', () => {
  it('只提供开发草案五级目录，全部执行权益保持 planned', async () => {
    const catalog = await getAppMembershipCatalog(db, APP_MEMBERSHIP_DRAFT_CATALOG_ID)

    expect(catalog).toMatchObject({
      versionCode: 'app-1.0-draft-1',
      state: 'development',
      productionReady: false,
      acquisition: {
        mode: 'contact_platform',
        applicationEnabled: false,
        paymentEnabled: false,
      },
    })
    expect(catalog.tiers.map(tier => [tier.displayName, tier.rank])).toEqual([
      ['心遇', 10],
      ['心悦', 20],
      ['心知', 30],
      ['心契', 40],
      ['心耀', 50],
    ])
    expect(catalog.definitions).toHaveLength(7)
    expect(catalog.tiers.every(tier => (
      tier.entitlements.length === 7
      && tier.entitlements.every(entitlement => entitlement.availability === 'planned')
    ))).toBe(true)
  })

  it('不把旧 vip/svip 自动映射为 App 会员', async () => {
    await db.exec(executableSql(`
      INSERT INTO membership_levels (id, code, name, rank) VALUES ('ml_svip', 'svip', 'SVIP', 999);
      INSERT INTO user_memberships (id, user_id, level_id, starts_at, expires_at)
      VALUES ('legacy_active', 2, 'ml_svip', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    `))

    await expect(getAppMembershipSummary(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
    )).resolves.toEqual({ code: 'free', name: '普通用户', rank: 0, expiresAt: null })
  })

  it('预览后发放并按幂等键返回同一结果，同时不把内部备注写入审计正文', async () => {
    const input = grantInput()
    const preview = await previewAdminAppMembershipGrant(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      input,
      NOW,
    )
    expect(preview).toMatchObject({
      action: 'grant',
      tier: { displayName: '心知', rank: 30 },
      durationDays: 30,
      willBecomeCurrentImmediately: true,
      warnings: ['DEVELOPMENT_CATALOG', 'ENTITLEMENTS_PLANNED'],
    })
    const committedInput = { ...input, startsAt: preview.startsAt }
    const committedAt = new Date(NOW.getTime() + 60_000)

    const first = await grantAdminAppMembership(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      1,
      'membership.grant.test.0001',
      committedInput,
      committedAt,
    )
    const repeated = await grantAdminAppMembership(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      1,
      'membership.grant.test.0001',
      committedInput,
      committedAt,
    )

    expect(first).toMatchObject({ replayed: false, tierName: '心知', rank: 30 })
    expect(first.startsAt).toBe(preview.startsAt)
    expect(first.expiresAt).toBe(preview.expiresAt)
    expect(repeated).toMatchObject({ replayed: true, grantId: first.grantId })
    await expect(count('app_membership_grants')).resolves.toBe(1)
    await expect(count('app_membership_admin_requests')).resolves.toBe(1)
    const audit = await db.prepare(`
      SELECT after_value FROM admin_audit_logs WHERE action = 'app_membership_grant'
    `).first<{ after_value: string }>()
    expect(audit?.after_value).toContain('"hasInternalNote":true')
    expect(audit?.after_value).not.toContain('仅管理员可见的敏感备注')

    const snapshot = await resolveAppMembershipSnapshot(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
    )
    expect(snapshot).toMatchObject({
      status: 'active',
      tier: { displayName: '心知', rank: 30 },
      grant: { grantId: first.grantId, sourceType: 'manual_admin' },
    })
    expect(snapshot.entitlements.every(entitlement => !entitlement.executable)).toBe(true)
  })

  it('同一幂等键绑定请求正文，续期从既有同级到期时间顺延', async () => {
    const first = await grantAdminAppMembership(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      1,
      'membership.grant.test.0002',
      grantInput(),
      NOW,
    )
    await expect(grantAdminAppMembership(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      1,
      'membership.grant.test.0002',
      { ...grantInput(), durationDays: 31 },
      NOW,
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 })
    await expect(previewAdminAppMembershipGrant(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      grantInput(),
      NOW,
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_BUSINESS_REFERENCE_CONFLICT', status: 409 })

    const renewalInput = {
      ...grantInput(),
      action: 'renew' as const,
      durationDays: 15,
      businessReference: 'CASE-RENEW-0001',
    }
    const preview = await previewAdminAppMembershipGrant(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      renewalInput,
      NOW,
    )
    expect(preview.startsAt).toBe(first.expiresAt)
    expect(new Date(preview.expiresAt).getTime() - new Date(preview.startsAt).getTime())
      .toBe(15 * 86_400_000)
  })

  it('撤销使用追加记录，grant 本体保留且用户立即回落为普通用户', async () => {
    const grant = await grantAdminAppMembership(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      1,
      'membership.grant.test.0003',
      grantInput(),
      NOW,
    )
    const revokeInput = {
      reasonCode: 'admin_correction' as const,
      userVisibleNote: '平台更正了本次会员发放。',
      internalNote: '复核记录 2026-08-06',
      businessReference: 'CASE-REVOKE-0001',
    }
    const revoked = await revokeAdminAppMembershipGrant(
      db,
      1,
      grant.grantId,
      'membership.revoke.test.001',
      revokeInput,
      NOW,
    )
    const repeated = await revokeAdminAppMembershipGrant(
      db,
      1,
      grant.grantId,
      'membership.revoke.test.001',
      revokeInput,
      NOW,
    )

    expect(revoked).toMatchObject({ revoked: true, replayed: false })
    expect(repeated).toMatchObject({ revoked: true, replayed: true })
    await expect(count('app_membership_grants')).resolves.toBe(1)
    await expect(count('app_membership_grant_revocations')).resolves.toBe(1)
    await expect(resolveAppMembershipSnapshot(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
    )).resolves.toMatchObject({ status: 'free', tier: null, grant: null })
  })

  it('生产目录门禁拒绝 development 草案', async () => {
    await expect(getAppMembershipCatalog(db, APP_MEMBERSHIP_DRAFT_CATALOG_ID, {
      requireProductionReady: true,
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CATALOG_NOT_READY', status: 503 })
    await expect(getAppMembershipSummary(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
      { requireProductionReady: true },
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_CATALOG_NOT_READY', status: 503 })
  })
})

function grantInput() {
  return {
    userId: 2,
    tierId: 'amt_heart_insight',
    action: 'grant' as const,
    durationDays: 30,
    reasonCode: 'manual_review' as const,
    userVisibleNote: '平台已完成审核并发放会员。',
    internalNote: '仅管理员可见的敏感备注',
    businessReference: 'CASE-GRANT-0001',
  }
}

async function count(tableName: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .first<{ count: number }>()
  return Number(row?.count ?? -1)
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
