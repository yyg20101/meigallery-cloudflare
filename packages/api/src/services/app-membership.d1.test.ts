import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import {
  cancelAppMembershipApplication,
  resubmitAppMembershipApplication,
  submitAppMembershipApplication,
} from './app-membership-applications'
import {
  approveAdminAppMembershipApplication,
  claimAdminAppMembershipApplication,
  transitionAdminAppMembershipApplication,
} from './admin-app-membership-applications'
import { reviewAdminAppMembershipChangeRequest } from './admin-app-membership-reviews'

const MIGRATION = readFileSync(
  new URL('../../migrations/0071_app_membership_catalog_and_grants.sql', import.meta.url),
  'utf8',
)
const APPLICATION_MIGRATION = readFileSync(
  new URL('../../migrations/0075_app_membership_applications.sql', import.meta.url),
  'utf8',
)
const REVIEW_MIGRATION = readFileSync(
  new URL('../../migrations/0088_app_membership_change_reviews.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-06T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `app-membership-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      email_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE app_account_security (
      account_id INTEGER PRIMARY KEY REFERENCES users(id),
      account_public_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active'
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
  await db.exec(executableSql(APPLICATION_MIGRATION))
  await db.exec(executableSql(REVIEW_MIGRATION))
  await db.exec(executableSql(`
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
    INSERT INTO users (id, email, nickname, role, status, email_verified) VALUES
      (1, 'admin@example.com', '申请管理员', 'admin', 'active', 1),
      (2, 'viewer@example.com', '观看者', 'user', 'active', 1),
      (3, 'reviewer@example.com', '复核管理员', 'admin', 'active', 1);
    INSERT INTO app_account_security (account_id, account_public_id)
      VALUES (2, 'acc_membership_viewer');
    INSERT INTO app_membership_review_policies (
      id, version_code, state, production_ready, risk_decision_status, review_mode,
      grant_rank_threshold, grant_duration_days_threshold, review_lower_rank_grant,
      review_revocation, created_by, created_at, published_at
    ) VALUES (
      'amrp_legacy_fixture', 'legacy-fixture-v1', 'published', 1, 'approved', 'risk_based',
      1000, 366, 0, 0, 1, '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
    );
    INSERT OR REPLACE INTO app_operational_safety_controls (
      control_key, display_name, state, version, incident_id, reason_code,
      reason_summary, changed_by, changed_at
    ) VALUES (
      'membership_grants', '会员发放', 'available', 1, NULL, NULL,
      NULL, NULL, '2026-08-06T00:00:00.000Z'
    );
  `))
})

afterEach(async () => {
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
      lifecycle: {
        state: 'expiring_soon',
        expiringSoonWindowDays: 30,
        remainingDays: 30,
        endedGrant: null,
      },
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
    )).resolves.toMatchObject({
      status: 'free',
      tier: null,
      grant: null,
      lifecycle: {
        state: 'revoked',
        remainingDays: null,
        endedGrant: {
          tier: { displayName: '心知', rank: 30 },
          grant: { grantId: grant.grantId },
          endedAt: NOW.toISOString(),
          userVisibleNote: revokeInput.userVisibleNote,
        },
      },
    })
  })

  it('会员快照区分有效、即将到期与已到期，历史 grant 不恢复任何权限', async () => {
    const grant = await grantAdminAppMembership(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      1,
      'membership.grant.lifecycle.0001',
      {
        ...grantInput(),
        durationDays: 60,
        businessReference: 'CASE-LIFECYCLE-0001',
      },
      NOW,
    )

    await expect(resolveAppMembershipSnapshot(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
    )).resolves.toMatchObject({
      status: 'active',
      lifecycle: { state: 'active', remainingDays: 60, endedGrant: null },
    })

    const expiredAt = new Date(NOW.getTime() + 60 * 86_400_000)
    await expect(resolveAppMembershipSnapshot(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      expiredAt,
    )).resolves.toMatchObject({
      status: 'free',
      tier: null,
      grant: null,
      lifecycle: {
        state: 'expired',
        remainingDays: null,
        endedGrant: {
          tier: { displayName: '心知', rank: 30 },
          grant: { grantId: grant.grantId },
          endedAt: grant.expiresAt,
          userVisibleNote: null,
        },
      },
    })
  })

  it('会员申请重复提交返回同一工单，且申请期间不产生任何 grant 或 entitlement', async () => {
    const first = await submitAppMembershipApplication(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      'membership.application.submit.0001',
      applicationInput(),
      NOW,
    )
    const replayed = await submitAppMembershipApplication(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      'membership.application.submit.0001',
      applicationInput(),
      NOW,
    )
    const duplicateActive = await submitAppMembershipApplication(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      'membership.application.submit.0002',
      { ...applicationInput(), tierId: 'amt_heart_radiance' },
      NOW,
    )

    expect(first).toMatchObject({ created: true, replayed: false })
    expect(first.application).toMatchObject({
      status: 'submitted',
      intendedTier: { displayName: '心知', rank: 30 },
      contact: { method: 'verified_email', maskedValue: 'vi****@example.com' },
      canCancel: true,
      canResubmit: false,
      grantId: null,
    })
    expect(replayed).toMatchObject({
      created: false,
      replayed: true,
      application: { applicationId: first.application.applicationId },
    })
    expect(duplicateActive.application.applicationId).toBe(first.application.applicationId)
    await expect(count('app_membership_applications')).resolves.toBe(1)
    await expect(count('app_membership_grants')).resolves.toBe(0)
    await expect(resolveAppMembershipSnapshot(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
    )).resolves.toMatchObject({ status: 'free', tier: null, grant: null })
  })

  it('支持待补充后重新入队，只有正式 grant 成功才标记已发放', async () => {
    const submitted = await submitAppMembershipApplication(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      'membership.application.submit.0003',
      applicationInput(),
      NOW,
    )
    const applicationId = submitted.application.applicationId
    const claimed = await claimAdminAppMembershipApplication(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      applicationId,
      1,
      1,
      NOW,
    )
    expect(claimed.application).toMatchObject({ status: 'processing', version: 2, grantId: null })

    const requested = await transitionAdminAppMembershipApplication(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      applicationId,
      1,
      'request_information',
      {
        expectedVersion: 2,
        reasonCode: 'application_statement',
        message: '请补充希望使用的主要会员服务。',
      },
      NOW,
    )
    expect(requested.application).toMatchObject({
      status: 'needs_information',
      version: 3,
      canResubmit: true,
    })

    const resubmitted = await resubmitAppMembershipApplication(
      db,
      2,
      applicationId,
      'membership.application.resubmit.01',
      {
        ...applicationInput(),
        statement: '主要希望使用平台话题能力。',
        expectedVersion: 3,
      },
      NOW,
    )
    expect(resubmitted.application).toMatchObject({ status: 'submitted', version: 4 })
    const reclaimed = await claimAdminAppMembershipApplication(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      applicationId,
      1,
      4,
      NOW,
    )
    expect(reclaimed.application).toMatchObject({ status: 'processing', version: 5 })
    await expect(approveAdminAppMembershipApplication(
      db,
      'amc_runtime_replaced',
      applicationId,
      1,
      'membership.application.approve.old-catalog',
      { expectedVersion: 5, durationDays: 30 },
      NOW,
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_APPLICATION_CATALOG_CHANGED', status: 409 })
    await expect(count('app_membership_grants')).resolves.toBe(0)

    const submittedForReview = await approveAdminAppMembershipApplication(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      applicationId,
      1,
      'membership.application.approve.01',
      {
        expectedVersion: 5,
        durationDays: 30,
        internalNote: '申请正文不得进入审计日志',
      },
      NOW,
    )
    expect(submittedForReview).toMatchObject({
      application: {
        application: { status: 'processing', version: 5, grantId: null },
        grantReview: { status: 'pending_review', version: 1 },
      },
      review: { status: 'pending_review', version: 1, resultGrantId: null },
      replayed: false,
    })
    await expect(count('app_membership_grants')).resolves.toBe(0)

    const reviewed = await reviewAdminAppMembershipChangeRequest(
      db,
      submittedForReview.review.requestId,
      3,
      'approve',
      'membership.review.approve.01',
      { expectedVersion: 1, reviewNote: '独立复核通过，资料与发放范围一致。' },
      NOW,
    )
    expect(reviewed).toMatchObject({
      request: { status: 'approved', version: 2, resultGrantId: expect.any(String) },
      replayed: false,
    })
    const grantId = reviewed.request.resultGrantId!

    const approvedReplay = await approveAdminAppMembershipApplication(
      db,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      applicationId,
      1,
      'membership.application.approve.01',
      {
        expectedVersion: 5,
        durationDays: 30,
        internalNote: '申请正文不得进入审计日志',
      },
      NOW,
    )
    expect(approvedReplay).toMatchObject({
      application: { application: { status: 'approved', version: 6 } },
      review: { status: 'approved', resultGrantId: grantId },
      replayed: true,
    })
    expect(approvedReplay.application.application).toMatchObject({
      canCancel: false,
      grantId,
    })
    expect(approvedReplay.application.application.timeline.map(item => item.status)).toEqual([
      'submitted',
      'processing',
      'needs_information',
      'submitted',
      'processing',
      'approved',
    ])
    await expect(count('app_membership_grants')).resolves.toBe(1)
    await expect(resolveAppMembershipSnapshot(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      NOW,
    )).resolves.toMatchObject({ status: 'active', tier: { displayName: '心知' } })
    const auditRows = await db.prepare(`
      SELECT before_value, after_value FROM admin_audit_logs
      WHERE target_type = 'app_membership_application'
    `).all<{ before_value: string; after_value: string }>()
    const auditJson = JSON.stringify(auditRows.results)
    expect(auditJson).not.toContain('主要希望使用平台话题能力')
    expect(auditJson).not.toContain('viewer@example.com')
  })

  it('用户可取消未领取申请，旧版本写入会被拒绝', async () => {
    const submitted = await submitAppMembershipApplication(
      db,
      2,
      APP_MEMBERSHIP_DRAFT_CATALOG_ID,
      'membership.application.submit.0004',
      applicationInput(),
      NOW,
    )
    await expect(cancelAppMembershipApplication(
      db,
      2,
      submitted.application.applicationId,
      'membership.application.cancel.001',
      99,
      NOW,
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_APPLICATION_VERSION_CONFLICT', status: 409 })

    const cancelled = await cancelAppMembershipApplication(
      db,
      2,
      submitted.application.applicationId,
      'membership.application.cancel.002',
      1,
      NOW,
    )
    expect(cancelled.application).toMatchObject({
      status: 'cancelled',
      version: 2,
      canCancel: false,
      grantId: null,
    })
    await expect(cancelAppMembershipApplication(
      db,
      2,
      submitted.application.applicationId,
      'membership.application.cancel.002',
      1,
      NOW,
    )).resolves.toMatchObject({ replayed: true, application: { status: 'cancelled', version: 2 } })
    await expect(cancelAppMembershipApplication(
      db,
      2,
      submitted.application.applicationId,
      'membership.application.cancel.003',
      2,
      NOW,
    )).rejects.toMatchObject({ code: 'MEMBERSHIP_APPLICATION_CANNOT_CANCEL', status: 409 })
    await expect(count('app_membership_grants')).resolves.toBe(0)
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

function applicationInput() {
  return {
    tierId: 'amt_heart_insight',
    preferredContactWindow: 'evening',
    statement: '希望了解并申请平台会员服务。',
    disclosureVersion: 'membership-application-development-1',
    disclosureConfirmed: true,
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
