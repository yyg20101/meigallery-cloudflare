import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  APP_NOTIFICATION_POLICY_ID,
  purgeExpiredAppNotifications,
  type AppNotificationRuntimeConfig,
} from './app-notifications'

const CONTENT_LIFECYCLE_MIGRATION = readFileSync(
  new URL('../../migrations/0115_app_notification_content_lifecycle.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-20T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `notification-retention-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(SCHEMA))
  await db.exec(executableSql(CONTENT_LIFECYCLE_MIGRATION))
  await db.prepare(`
    INSERT INTO app_notification_policies (
      id, decision_status, retention_days, purge_enabled
    ) VALUES (?, 'unresolved', NULL, 0)
  `).bind(APP_NOTIFICATION_POLICY_ID).run()
})

afterEach(async () => {
  await miniflare.dispose()
})

describe('Message-9 站内通知内容生命周期', () => {
  it('没有显式策略 ID 时跳过，不把 development 默认 ID 当作删除授权', async () => {
    await seedNotification({
      id: 'ntf_unconfigured',
      createdAt: '2026-07-01T08:00:00.000Z',
      expiresAt: null,
    })

    await expect(purgeExpiredAppNotifications(
      db,
      runtimeConfig(false),
      NOW,
    )).resolves.toEqual({
      skipped: true,
      reason: 'policy_not_configured',
      deletedNotificationCount: 0,
      deletedReadEventCount: 0,
      hasMore: false,
    })
    await expect(listNotificationIds()).resolves.toEqual(['ntf_unconfigured'])
  })

  it('保留决策或 purge 门禁未就绪时不删除', async () => {
    await seedNotification({
      id: 'ntf_unapproved',
      createdAt: '2026-07-01T08:00:00.000Z',
      expiresAt: null,
    })

    await expect(purgeExpiredAppNotifications(
      db,
      runtimeConfig(),
      NOW,
    )).resolves.toEqual({
      skipped: true,
      reason: 'retention_not_ready',
      deletedNotificationCount: 0,
      deletedReadEventCount: 0,
      hasMore: false,
    })
    await expect(listNotificationIds()).resolves.toEqual(['ntf_unapproved'])
  })

  it('能力关闭后仍按稳定顺序有界删除正文与单条已读事件，并保留 Outbox 墓碑', async () => {
    await enablePurge(30)
    await seedNotification({
      id: 'ntf_explicit',
      createdAt: '2026-07-20T08:00:00.000Z',
      expiresAt: '2026-08-19T08:00:00.000Z',
      readEventId: 'nre_explicit',
    })
    await seedNotification({
      id: 'ntf_legacy',
      createdAt: '2026-07-01T08:00:00.000Z',
      expiresAt: null,
    })
    await seedNotification({
      id: 'ntf_future',
      createdAt: '2026-07-22T08:00:00.000Z',
      expiresAt: '2026-08-21T08:00:00.000Z',
    })
    await db.prepare(`
      INSERT INTO app_notification_read_events (
        id, account_id, operation, notification_id, category
      ) VALUES ('nre_category', 1, 'category_all', NULL, 'message')
    `).run()

    await expect(purgeExpiredAppNotifications(
      db,
      runtimeConfig(),
      NOW,
      1,
    )).resolves.toEqual({
      skipped: false,
      reason: null,
      deletedNotificationCount: 1,
      deletedReadEventCount: 1,
      hasMore: true,
    })
    await expect(listNotificationIds()).resolves.toEqual(['ntf_future', 'ntf_legacy'])
    await expect(listReadEventIds()).resolves.toEqual(['nre_category'])
    await expect(count('app_notification_outbox')).resolves.toBe(3)

    await expect(purgeExpiredAppNotifications(
      db,
      runtimeConfig(),
      NOW,
      10,
    )).resolves.toEqual({
      skipped: false,
      reason: null,
      deletedNotificationCount: 1,
      deletedReadEventCount: 0,
      hasMore: false,
    })
    await expect(listNotificationIds()).resolves.toEqual(['ntf_future'])
    await expect(count('app_notification_outbox')).resolves.toBe(3)
  })

  it('迁移拒绝非法到期时间，并阻止投递后篡改保留边界', async () => {
    await seedOutbox('ntf_invalid')
    await expect(db.prepare(`
      INSERT INTO app_notifications (id, outbox_id, account_id, created_at, expires_at)
      VALUES ('ntf_invalid', 'nto_ntf_invalid', 1, ?, ?)
    `).bind(
      '2026-08-20T08:00:00.000Z',
      '2026-08-20T08:00:00.000Z',
    ).run()).rejects.toThrow('app notification expiry invalid')

    await seedNotification({
      id: 'ntf_immutable',
      createdAt: '2026-08-20T08:00:00.000Z',
      expiresAt: '2026-08-21T08:00:00.000Z',
    })
    await expect(db.prepare(`
      UPDATE app_notifications
      SET expires_at = '2026-09-21T08:00:00.000Z'
      WHERE id = 'ntf_immutable'
    `).run()).rejects.toThrow('app notification retention boundary is immutable')
  })

  it('拒绝非法调度时间，不扩大删除范围', async () => {
    await enablePurge(30)
    await seedNotification({
      id: 'ntf_invalid_now',
      createdAt: '2026-07-01T08:00:00.000Z',
      expiresAt: null,
    })

    await expect(purgeExpiredAppNotifications(
      db,
      runtimeConfig(),
      new Date('invalid'),
    )).rejects.toThrow('NOTIFICATION_PURGE_TIME_INVALID')
    await expect(listNotificationIds()).resolves.toEqual(['ntf_invalid_now'])
  })
})

function runtimeConfig(policyConfigured = true): AppNotificationRuntimeConfig {
  return {
    enabled: false,
    adminEnabled: false,
    conversationSettingsEnabled: false,
    policyId: APP_NOTIFICATION_POLICY_ID,
    policyConfigured,
    requireProductionReady: false,
  }
}

async function enablePurge(retentionDays: number) {
  await db.prepare(`
    UPDATE app_notification_policies
    SET decision_status = 'approved', retention_days = ?, purge_enabled = 1
    WHERE id = ?
  `).bind(retentionDays, APP_NOTIFICATION_POLICY_ID).run()
}

async function seedNotification(input: {
  id: string
  createdAt: string
  expiresAt: string | null
  readEventId?: string
}) {
  await seedOutbox(input.id)
  await db.prepare(`
    INSERT INTO app_notifications (id, outbox_id, account_id, created_at, expires_at)
    VALUES (?, ?, 1, ?, ?)
  `).bind(
    input.id,
    outboxId(input.id),
    input.createdAt,
    input.expiresAt,
  ).run()
  if (input.readEventId) {
    await db.prepare(`
      INSERT INTO app_notification_read_events (
        id, account_id, operation, notification_id, category
      ) VALUES (?, 1, 'single', ?, NULL)
    `).bind(input.readEventId, input.id).run()
  }
}

async function seedOutbox(notificationId: string) {
  await db.prepare(`
    INSERT INTO app_notification_outbox (id, notification_id)
    VALUES (?, ?)
  `).bind(outboxId(notificationId), notificationId).run()
}

function outboxId(notificationId: string) {
  return `nto_${notificationId}`
}

async function listNotificationIds() {
  const rows = await db.prepare(`
    SELECT id FROM app_notifications ORDER BY id ASC
  `).all<{ id: string }>()
  return rows.results.map(row => row.id)
}

async function listReadEventIds() {
  const rows = await db.prepare(`
    SELECT id FROM app_notification_read_events ORDER BY id ASC
  `).all<{ id: string }>()
  return rows.results.map(row => row.id)
}

async function count(table: 'app_notification_outbox') {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>()
  return Number(row?.count ?? -1)
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE app_notification_policies (
    id TEXT PRIMARY KEY,
    decision_status TEXT NOT NULL,
    retention_days INTEGER,
    purge_enabled INTEGER NOT NULL
  );

  CREATE TABLE app_notification_outbox (
    id TEXT PRIMARY KEY,
    notification_id TEXT
  );

  CREATE TABLE app_notifications (
    id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL UNIQUE
      REFERENCES app_notification_outbox(id) ON DELETE RESTRICT,
    account_id INTEGER NOT NULL,
    created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
    expires_at TEXT CHECK (expires_at IS NULL OR julianday(expires_at) IS NOT NULL)
  );

  CREATE TABLE app_notification_read_events (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('single', 'category_all')),
    notification_id TEXT REFERENCES app_notifications(id) ON DELETE SET NULL,
    category TEXT,
    CHECK (
      (operation = 'single' AND notification_id IS NOT NULL AND category IS NULL)
      OR (operation = 'category_all' AND notification_id IS NULL AND category IS NOT NULL)
    )
  );
`
