import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  APP_NOTIFICATION_POLICY_ID,
  AppNotificationError,
  getAppNotificationPreferences,
  getAppNotificationUnreadCounts,
  listAppNotifications,
  markAppNotificationRead,
  markAppNotificationsReadAll,
  parseAppNotificationListQuery,
  updateAppNotificationPreferences,
  type AppNotificationRuntimeConfig,
  type AppNotificationTargetCapabilities,
} from './app-notifications'

const BASE_MIGRATION = readFileSync(
  new URL('../../migrations/0076_app_in_app_notifications.sql', import.meta.url),
  'utf8',
)
const TEMPLATE_GOVERNANCE_MIGRATION = readFileSync(
  new URL('../../migrations/0097_app_notification_template_governance.sql', import.meta.url),
  'utf8',
)
const CONTENT_LIFECYCLE_MIGRATION = readFileSync(
  new URL('../../migrations/0115_app_notification_content_lifecycle.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-08T08:00:00.000Z')
const CONFIG: AppNotificationRuntimeConfig = {
  enabled: true,
  adminEnabled: true,
  conversationSettingsEnabled: false,
  policyId: APP_NOTIFICATION_POLICY_ID,
  policyConfigured: true,
  requireProductionReady: false,
}
const CAPABILITIES: AppNotificationTargetCapabilities = {
  messaging: true,
  profiles: true,
  membership: true,
  membershipApplications: true,
  safetyReports: true,
  safetyAppeals: true,
  accountSecurity: true,
  wallet: false,
  dataRights: false,
}

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-notifications' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE app_devices (id TEXT PRIMARY KEY);
    CREATE TABLE app_conversations (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL
    );
    CREATE TABLE app_conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE app_membership_applications (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL
    );
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
      tier_name_snapshot TEXT NOT NULL DEFAULT 'VIP',
      starts_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE app_membership_grant_revocations (
      grant_id TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL
    );
    CREATE TABLE app_safety_reports (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL
    );
    CREATE TABLE app_safety_report_events (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE app_safety_appeals (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL
    );
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
  `))
  await db.exec(executableSql(BASE_MIGRATION))
  await db.exec(executableSql(TEMPLATE_GOVERNANCE_MIGRATION))
  await db.exec(executableSql(CONTENT_LIFECYCLE_MIGRATION))
})

beforeEach(async () => {
  await db.exec(executableSql(`
    DELETE FROM app_notification_read_events;
    DELETE FROM app_notifications;
    DELETE FROM app_notification_outbox;
    DELETE FROM app_notification_preference_events;
    DELETE FROM app_notification_preferences;
    DELETE FROM app_conversation_messages;
    DELETE FROM app_conversations;
    DELETE FROM app_membership_grant_revocations;
    DELETE FROM app_membership_grants;
    DELETE FROM app_membership_application_events;
    DELETE FROM app_membership_applications;
    DELETE FROM app_safety_report_events;
    DELETE FROM app_safety_reports;
    DELETE FROM app_safety_appeal_events;
    DELETE FROM app_safety_appeals;
    DELETE FROM app_account_security_events;
    DELETE FROM profile_public_projections;
    DELETE FROM app_devices;
    DELETE FROM users;
    UPDATE app_notification_policies
    SET generation_enabled = 0, decision_status = 'unresolved',
        retention_days = NULL, purge_enabled = 0, effective_at = NULL;
    INSERT INTO users (id) VALUES (1), (2);
    INSERT INTO app_devices (id) VALUES ('dev_one'), ('dev_two');
  `))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('Message-3 站内通知 D1', () => {
  it('数据库策略默认关闭，业务事件不会偷跑生成 Outbox', async () => {
    await insertConversationReply('msg_disabled')
    await expect(count('app_notification_outbox')).resolves.toBe(0)
    await expect(getAppNotificationUnreadCounts(db, 1, CONFIG, NOW))
      .rejects.toMatchObject({ code: 'NOTIFICATION_POLICY_NOT_READY', status: 503 })
  })

  it('平台回复原子写入 Outbox，拉取时投影安全文案且不复制正文', async () => {
    await enablePolicy()
    await insertConversationReply('msg_reply_1')

    const result = await listAppNotifications(
      db,
      1,
      'acc_one',
      CONFIG,
      CAPABILITIES,
      parseAppNotificationListQuery({ accountScope: 'acc_one' }),
      NOW,
    )

    expect(result.data).toEqual([
      expect.objectContaining({
        category: 'message',
        eventType: 'message.platform_reply',
        title: '平台话题有新回复',
        summary: expect.not.stringContaining('私密正文'),
        state: 'available',
        target: {
          type: 'conversation',
          id: 'cv_one',
          action: 'open_conversation',
          available: true,
          unavailableReason: null,
        },
      }),
    ])
    expect(result.hasMore).toBe(false)
    await expect(count('app_notifications')).resolves.toBe(1)
    const outbox = await db.prepare(`
      SELECT status, attempts, notification_id FROM app_notification_outbox WHERE event_ref = ?
    `).bind('msg_reply_1').first<{ status: string; attempts: number; notification_id: string }>()
    expect(outbox).toMatchObject({ status: 'delivered', attempts: 1 })
    expect(outbox?.notification_id).toMatch(/^ntf_[a-f0-9]{48}$/u)
  })

  it('批准保留策略后按原始事件时间写入不可变到期边界', async () => {
    await enableRetentionPolicy(30)
    await insertConversationReply('msg_retention', '2026-08-01T08:00:00.000Z')

    await listAppNotifications(
      db,
      1,
      'acc_one',
      CONFIG,
      CAPABILITIES,
      parseAppNotificationListQuery({ accountScope: 'acc_one' }),
      NOW,
    )

    const notification = await db.prepare(`
      SELECT created_at, expires_at
      FROM app_notifications
      WHERE event_type = 'message.platform_reply'
    `).first<{ created_at: string; expires_at: string }>()
    expect(notification).toEqual({
      created_at: '2026-08-01T08:00:00.000Z',
      expires_at: '2026-08-31T08:00:00.000Z',
    })
  })

  it('延迟超过已批准保留期的事件只收敛 Outbox，不再创建通知正文', async () => {
    await enableRetentionPolicy(30)
    await insertConversationReply('msg_already_expired', '2026-06-01T08:00:00.000Z')

    const result = await listAppNotifications(
      db,
      1,
      'acc_one',
      CONFIG,
      CAPABILITIES,
      parseAppNotificationListQuery({ accountScope: 'acc_one' }),
      NOW,
    )

    expect(result.data).toEqual([])
    await expect(count('app_notifications')).resolves.toBe(0)
    await expect(db.prepare(`
      SELECT status, notification_id
      FROM app_notification_outbox
      WHERE event_ref = 'msg_already_expired'
    `).first<{ status: string; notification_id: string | null }>()).resolves.toEqual({
      status: 'suppressed',
      notification_id: null,
    })
  })

  it('可选分类遵循偏好，必要的会员通知不受偏好关闭影响', async () => {
    await enablePolicy()
    const initial = await getAppNotificationPreferences(db, 1, CONFIG, NOW)
    expect(initial).toMatchObject({
      version: 1,
      optional: { message: true, interaction: true, marketing: false },
      required: { membershipCoin: true, systemSecurity: true },
    })
    const updated = await updateAppNotificationPreferences(
      db,
      1,
      { expectedVersion: 1, message: false, interaction: true, marketing: false },
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-pref-0001' },
      NOW,
    )
    expect(updated).toMatchObject({ version: 2, optional: { message: false } })
    await expect(updateAppNotificationPreferences(
      db,
      1,
      { expectedVersion: 1, message: true, interaction: true, marketing: false },
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-pref-0002' },
      NOW,
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 })

    await insertConversationReply('msg_suppressed')
    await db.prepare(`
      INSERT INTO app_membership_grants (id, user_id, starts_at, expires_at, created_at)
      VALUES ('amg_required', 1, ?, ?, ?)
    `).bind(
      '2026-08-08T00:00:00.000Z',
      '2026-09-08T00:00:00.000Z',
      NOW.toISOString(),
    ).run()

    const result = await listAppNotifications(
      db,
      1,
      'acc_one',
      CONFIG,
      CAPABILITIES,
      parseAppNotificationListQuery({ accountScope: 'acc_one' }),
      NOW,
    )
    expect(result.data.map(item => item.eventType)).toEqual(['membership.granted'])
    const suppressed = await db.prepare(`
      SELECT status FROM app_notification_outbox WHERE event_ref = 'msg_suppressed'
    `).first<{ status: string }>()
    expect(suppressed?.status).toBe('suppressed')
  })

  it('策略版本切换时保留用户选择、单调提升版本并追加切换审计', async () => {
    await enablePolicy()
    await getAppNotificationPreferences(db, 1, CONFIG, NOW)
    await updateAppNotificationPreferences(
      db,
      1,
      { expectedVersion: 1, message: false, interaction: true, marketing: false },
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-pref-rebind-0001' },
      NOW,
    )
    await getAppNotificationPreferences(db, 2, CONFIG, NOW)

    const nextPolicyId = 'ntp_app_1_0_message_3_dev_2'
    await db.batch([
      db.prepare(`
        UPDATE app_notification_policies
        SET generation_enabled = 0
        WHERE id = ?
      `).bind(APP_NOTIFICATION_POLICY_ID),
      db.prepare(`
        INSERT INTO app_notification_policies (
          id, version_code, state, production_ready, generation_enabled,
          decision_status, retention_days, purge_enabled, minimum_client_version,
          effective_at, created_at
        ) VALUES (?, 'app-1.0-message-3-dev-2', 'development', 0, 1,
                  'unresolved', NULL, 0, '1.0', ?, ?)
      `).bind(nextPolicyId, NOW.toISOString(), NOW.toISOString()),
    ])
    const nextConfig = { ...CONFIG, policyId: nextPolicyId }

    const rebound = await getAppNotificationPreferences(db, 1, nextConfig, NOW)
    expect(rebound).toMatchObject({
      policyId: nextPolicyId,
      version: 3,
      optional: { message: false, interaction: true, marketing: false },
    })
    await expect(getAppNotificationPreferences(db, 1, nextConfig, NOW))
      .resolves.toMatchObject({ policyId: nextPolicyId, version: 3 })

    const events = await db.prepare(`
      SELECT policy_id, version, message_enabled, device_id, request_id
      FROM app_notification_preference_events
      WHERE account_id = 1
      ORDER BY version ASC
    `).all<{
      policy_id: string
      version: number
      message_enabled: number
      device_id: string | null
      request_id: string
    }>()
    expect(events.results).toEqual([
      expect.objectContaining({
        policy_id: APP_NOTIFICATION_POLICY_ID,
        version: 2,
        message_enabled: 0,
        device_id: 'dev_one',
      }),
      expect.objectContaining({
        policy_id: nextPolicyId,
        version: 3,
        message_enabled: 0,
        device_id: null,
        request_id: expect.stringMatching(/^policy-rebind-applied-/u),
      }),
    ])

    const untouched = await getAppNotificationPreferences(db, 2, nextConfig, NOW)
    expect(untouched).toMatchObject({
      policyId: nextPolicyId,
      version: 2,
      optional: { message: true, interaction: true, marketing: false },
    })
    const untouchedEvents = await db.prepare(`
      SELECT policy_id, version, device_id, request_id
      FROM app_notification_preference_events
      WHERE account_id = 2
      ORDER BY version ASC
    `).all<{
      policy_id: string
      version: number
      device_id: string | null
      request_id: string
    }>()
    expect(untouchedEvents.results).toEqual([
      expect.objectContaining({
        policy_id: APP_NOTIFICATION_POLICY_ID,
        version: 1,
        device_id: null,
        request_id: expect.stringMatching(/^policy-rebind-baseline-/u),
      }),
      expect.objectContaining({
        policy_id: nextPolicyId,
        version: 2,
        device_id: null,
        request_id: expect.stringMatching(/^policy-rebind-applied-/u),
      }),
    ])
  })

  it('未读数由服务端统计，单条已读幂等并记录设备审计', async () => {
    await enablePolicy()
    await insertConversationReply('msg_read')
    const before = await getAppNotificationUnreadCounts(db, 1, CONFIG, NOW)
    expect(before).toMatchObject({ total: 1, categories: { message: 1 } })
    const row = await db.prepare('SELECT id FROM app_notifications LIMIT 1')
      .first<{ id: string }>()

    const first = await markAppNotificationRead(
      db,
      1,
      row!.id,
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-read-0001' },
      NOW,
    )
    const replay = await markAppNotificationRead(
      db,
      1,
      row!.id,
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-read-0002' },
      NOW,
    )
    expect(first).toMatchObject({ state: 'read', replayed: false })
    expect(replay).toMatchObject({ state: 'read', replayed: true, readAt: first.readAt })
    await expect(getAppNotificationUnreadCounts(db, 1, CONFIG, NOW))
      .resolves.toMatchObject({ total: 0, categories: { message: 0 } })
    await expect(count('app_notification_read_events')).resolves.toBe(2)
    const events = await db.prepare(`
      SELECT marked_count FROM app_notification_read_events ORDER BY created_at, id
    `).all<{ marked_count: number }>()
    expect(events.results.map(event => Number(event.marked_count)).sort()).toEqual([0, 1])
  })

  it('分类全部已读与审计在同一批次收敛，重复操作不重复计数', async () => {
    await enablePolicy()
    await insertConversationReply('msg_read_all_1', '2026-08-08T07:59:00.000Z')
    await insertConversationReply('msg_read_all_2', '2026-08-08T07:58:00.000Z')
    await getAppNotificationUnreadCounts(db, 1, CONFIG, NOW)

    const first = await markAppNotificationsReadAll(
      db,
      1,
      'message',
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-read-all-0001' },
      NOW,
    )
    const replay = await markAppNotificationsReadAll(
      db,
      1,
      'message',
      CONFIG,
      { deviceId: 'dev_one', requestId: 'request-read-all-0002' },
      NOW,
    )

    expect(first).toMatchObject({ category: 'message', markedCount: 2 })
    expect(replay).toMatchObject({ category: 'message', markedCount: 0 })
    const events = await db.prepare(`
      SELECT marked_count FROM app_notification_read_events
      WHERE operation = 'category_all'
      ORDER BY created_at, id
    `).all<{ marked_count: number }>()
    expect(events.results.map(event => Number(event.marked_count)).sort((a, b) => a - b)).toEqual([0, 2])
  })

  it('目标 capability 关闭时仅禁用动作，通知仍可安全阅读', async () => {
    await enablePolicy()
    await insertConversationReply('msg_target_disabled')
    const result = await listAppNotifications(
      db,
      1,
      'acc_one',
      CONFIG,
      { ...CAPABILITIES, messaging: false },
      parseAppNotificationListQuery({ accountScope: 'acc_one' }),
      NOW,
    )
    expect(result.data[0]?.target).toMatchObject({
      action: 'open_conversation',
      available: false,
      unavailableReason: 'FEATURE_DISABLED',
    })
  })

  it('分页游标绑定账号与分类，不可跨范围复用', async () => {
    await enablePolicy()
    await insertConversationReply('msg_cursor_1', '2026-08-08T07:59:00.000Z')
    await insertConversationReply('msg_cursor_2', '2026-08-08T07:58:00.000Z')
    const first = await listAppNotifications(
      db,
      1,
      'acc_one',
      CONFIG,
      CAPABILITIES,
      parseAppNotificationListQuery({ accountScope: 'acc_one', category: 'message', limit: '1' }),
      NOW,
    )
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(() => parseAppNotificationListQuery({
      accountScope: 'acc_two',
      category: 'message',
      cursor: first.nextCursor!,
    })).toThrowError(AppNotificationError)
    expect(() => parseAppNotificationListQuery({
      accountScope: 'acc_one',
      category: 'system_security',
      cursor: first.nextCursor!,
    })).toThrowError(AppNotificationError)
  })
})

async function enablePolicy() {
  await db.prepare(`
    UPDATE app_notification_policies
    SET generation_enabled = 1, effective_at = ?
    WHERE id = ?
  `).bind('2026-08-08T00:00:00.000Z', APP_NOTIFICATION_POLICY_ID).run()
}

async function enableRetentionPolicy(retentionDays: number) {
  await db.prepare(`
    UPDATE app_notification_policies
    SET generation_enabled = 1,
        decision_status = 'approved',
        retention_days = ?,
        purge_enabled = 1,
        effective_at = ?
    WHERE id = ?
  `).bind(
    retentionDays,
    '2026-08-08T00:00:00.000Z',
    APP_NOTIFICATION_POLICY_ID,
  ).run()
}

async function insertConversationReply(
  messageId: string,
  createdAt = NOW.toISOString(),
) {
  await db.prepare(`
    INSERT OR IGNORE INTO app_conversations (id, account_id) VALUES ('cv_one', 1)
  `).run()
  await db.prepare(`
    INSERT INTO app_conversation_messages (id, conversation_id, sender_type, status, created_at)
    VALUES (?, 'cv_one', 'platform_operator', 'accepted', ?)
  `).bind(messageId, createdAt).run()
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
