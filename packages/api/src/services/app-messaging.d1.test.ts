import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  auditAdminAppConversationAccess,
  claimAdminAppConversation,
  listAdminAppConversationMessages,
  listAdminAppConversations,
  markAdminAppConversationRead,
  parseAdminAppConversationListQuery,
  parseAdminAppConversationMessageQuery,
  sendAdminAppConversationMessage,
} from './admin-app-messaging'
import {
  APP_MESSAGE_1_CATALOG_ID,
  APP_MESSAGING_DISCLOSURE_TEXT,
  APP_MESSAGING_DISCLOSURE_VERSION,
  createAppConversation,
  listAppConversationMessages,
  markAppConversationRead,
  parseAppMessageListQuery,
  sendAppViewerMessage,
} from './app-messaging'

const MEMBERSHIP_MIGRATION = readFileSync(
  new URL('../../migrations/0071_app_membership_catalog_and_grants.sql', import.meta.url),
  'utf8',
)
const MESSAGE_MIGRATION = readFileSync(
  new URL('../../migrations/0072_app_managed_conversations.sql', import.meta.url),
  'utf8',
)
const SAFETY_MIGRATION = readFileSync(
  new URL('../../migrations/0073_app_messaging_safety_operations.sql', import.meta.url),
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
    d1Databases: { DB: 'app-messaging' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE app_account_security (
      account_id INTEGER PRIMARY KEY REFERENCES users(id),
      account_public_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE galleries (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      cover_key TEXT
    );
    CREATE TABLE person_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
    CREATE TABLE profile_public_projections (
      profile_id TEXT PRIMARY KEY REFERENCES person_profiles(id),
      person_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      summary TEXT,
      source_gallery_id TEXT NOT NULL REFERENCES galleries(id),
      tags_json TEXT NOT NULL DEFAULT '[]',
      verification_status TEXT NOT NULL,
      verification_valid_until TEXT,
      publication_status TEXT NOT NULL,
      authorization_status TEXT NOT NULL,
      authorization_valid_from TEXT,
      authorization_valid_until TEXT,
      visibility_status TEXT NOT NULL,
      operation_mode TEXT NOT NULL,
      operation_label TEXT NOT NULL,
      region_code TEXT,
      region_label TEXT,
      region_precision TEXT,
      recommendation_score INTEGER NOT NULL DEFAULT 0,
      heat_score INTEGER NOT NULL DEFAULT 0,
      recommendation_reason_code TEXT NOT NULL,
      recommendation_rule_version TEXT NOT NULL,
      published_at TEXT NOT NULL
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
  await db.exec(executableSql(MEMBERSHIP_MIGRATION))
  await db.exec(executableSql(MESSAGE_MIGRATION))
  await db.exec(executableSql(SAFETY_MIGRATION))
})

beforeEach(async () => {
  await db.exec(executableSql(`
    DELETE FROM app_safety_idempotency;
    DELETE FROM app_conversation_assignment_events;
    DELETE FROM app_conversation_assignment_state;
    DELETE FROM app_profile_block_events;
    DELETE FROM app_profile_blocks;
    DELETE FROM app_messaging_idempotency;
    DELETE FROM app_conversation_messages;
    DELETE FROM app_conversation_quota_consumptions;
    DELETE FROM app_conversations;
    DELETE FROM app_membership_admin_requests;
    DELETE FROM app_membership_grant_revocations;
    DELETE FROM app_membership_grants;
    DELETE FROM admin_audit_logs;
    DELETE FROM profile_public_projections;
    DELETE FROM person_profiles;
    DELETE FROM galleries;
    DELETE FROM app_account_security;
    DELETE FROM users;

    INSERT INTO users (id, email, nickname, status) VALUES
      (1, 'admin@example.com', '运营一号', 'active'),
      (2, 'viewer@example.com', '观看者', 'active');
    INSERT INTO app_account_security (account_id, account_public_id, status)
      VALUES (2, 'acc_message_viewer', 'active');
    INSERT INTO galleries (id, status, cover_key) VALUES
      ('gallery_one', 'published', 'covers/one.jpg'),
      ('gallery_two', 'published', 'covers/two.jpg');
    INSERT INTO person_profiles (id, display_name) VALUES
      ('pp_one', '小桃'),
      ('pp_two', '小满');
    INSERT INTO profile_public_projections (
      profile_id, person_id, display_name, summary, source_gallery_id,
      tags_json, verification_status, verification_valid_until,
      publication_status, authorization_status, authorization_valid_from,
      authorization_valid_until, visibility_status, operation_mode,
      operation_label, region_code, region_label, region_precision,
      recommendation_score, heat_score, recommendation_reason_code,
      recommendation_rule_version, published_at
    ) VALUES
      ('pp_one', 'per_one', '小桃', '清新写真', 'gallery_one', '["清新"]',
       'verified', NULL, 'published', 'active', '2026-01-01T00:00:00.000Z',
       NULL, 'visible', 'platform_managed', '消息由平台运营接收',
       'shanghai', '上海', 'city', 100, 80, 'EDITORIAL_QUALITY',
       'discovery_v1', '2026-08-01T00:00:00.000Z'),
      ('pp_two', 'per_two', '小满', '生活记录', 'gallery_two', '["生活"]',
       'verified', NULL, 'published', 'active', '2026-01-01T00:00:00.000Z',
       NULL, 'visible', 'platform_managed', '消息由平台运营接收',
       'hangzhou', '杭州', 'city', 90, 70, 'EDITORIAL_QUALITY',
       'discovery_v1', '2026-08-02T00:00:00.000Z');
    INSERT INTO app_membership_grants (
      id, user_id, catalog_version_id, tier_id, tier_code_snapshot,
      tier_name_snapshot, rank_snapshot, starts_at, expires_at,
      source_type, reason_code, user_visible_note, internal_note,
      business_reference, granted_by, created_at
    ) VALUES (
      'amg_message_test', 2, 'amc_app_1_0_message_1_dev_1', 'amt_heart_meet',
      'heart_meet', '心遇', 10, '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z', 'manual_admin', 'manual_review',
      '平台已发放心遇会员。', NULL, 'MESSAGE-TEST-GRANT', 1,
      '2026-08-01T00:00:00.000Z'
    );
  `))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('Message-1 平台话题 D1 闭环', () => {
  it('原子创建话题、写入不可省略的平台说明，并以幂等键返回同一结果', async () => {
    const first = await createConversation('pp_one', 'message.create.test.0001')
    const replay = await createConversation('pp_one', 'message.create.test.0001')
    const existing = await createConversation('pp_one', 'message.create.test.existing.0001')
    const existingReplay = await createConversation('pp_one', 'message.create.test.existing.0001')

    expect(first).toMatchObject({
      created: true,
      replayed: false,
      quota: { limit: 1, used: 1, remaining: 0, periodKey: '2026-08-06' },
      conversation: {
        profile: { displayName: '小桃', available: true },
        operationMode: 'platform_managed',
        receiverLabel: '平台运营接收',
        disclosureText: APP_MESSAGING_DISCLOSURE_TEXT,
        queueStatus: 'awaiting_viewer',
        canSend: true,
      },
    })
    expect(replay).toMatchObject({
      created: false,
      replayed: true,
      conversation: { conversationId: first.conversation.conversationId },
    })
    expect(existing).toMatchObject({
      created: false,
      replayed: false,
      conversation: { conversationId: first.conversation.conversationId },
    })
    expect(existingReplay).toMatchObject({
      created: false,
      replayed: true,
      conversation: { conversationId: first.conversation.conversationId },
    })
    await expect(
      createConversation('pp_two', 'message.create.test.existing.0001'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 })
    await expect(count('app_conversations')).resolves.toBe(1)
    await expect(count('app_conversation_quota_consumptions')).resolves.toBe(1)
    await expect(count('app_conversation_messages')).resolves.toBe(1)

    const messages = await listAppConversationMessages(
      db,
      2,
      first.conversation.conversationId,
      parseAppMessageListQuery({}),
    )
    expect(messages.items).toEqual([
      expect.objectContaining({
        sequence: 1,
        senderType: 'system',
        senderLabel: '服务说明',
        text: APP_MESSAGING_DISCLOSURE_TEXT,
      }),
    ])
  })

  it('同一会员等级每日新话题额度按上海自然日拒绝第二个人物', async () => {
    await createConversation('pp_one', 'message.create.test.0002')
    await expect(createConversation('pp_two', 'message.create.test.0003')).rejects.toMatchObject({
      status: 429,
      code: 'ENTITLEMENT_QUOTA_EXCEEDED',
    })
    await expect(count('app_conversations')).resolves.toBe(1)
  })

  it('观看者文本与运营回复保持幂等、已读和队列状态一致', async () => {
    const created = await createConversation('pp_one', 'message.create.test.0004')
    const conversationId = created.conversation.conversationId
    const viewer = await sendAppViewerMessage(
      db,
      2,
      conversationId,
      APP_MESSAGE_1_CATALOG_ID,
      'message.viewer.test.0001',
      {
        clientMessageId: 'client.viewer.0001',
        contentType: 'text',
        text: '你好，我想了解最近的内容。',
      },
      NOW,
    )
    const viewerReplay = await sendAppViewerMessage(
      db,
      2,
      conversationId,
      APP_MESSAGE_1_CATALOG_ID,
      'message.viewer.test.0001',
      {
        clientMessageId: 'client.viewer.0001',
        contentType: 'text',
        text: '你好，我想了解最近的内容。',
      },
      NOW,
    )
    expect(viewer).toMatchObject({ replayed: false, message: { sequence: 2, senderType: 'viewer' } })
    expect(viewerReplay).toMatchObject({ replayed: true, message: { messageId: viewer.message.messageId } })

    const queue = await listAdminAppConversations(
      db,
      1,
      parseAdminAppConversationListQuery({ queueStatus: 'awaiting_operator' }),
      NOW,
    )
    expect(queue).toEqual([
      expect.objectContaining({
        conversationId,
        account: { accountId: 'acc_message_viewer', nickname: '观看者' },
        profile: { profileId: 'pp_one', displayName: '小桃' },
        unreadViewerCount: 1,
      }),
    ])

    await claimAdminAppConversation(
      db,
      1,
      conversationId,
      'message.assignment.claim.0001',
      NOW,
    )

    const operator = await sendAdminAppConversationMessage(
      db,
      1,
      conversationId,
      'message.operator.test.001',
      {
        clientMessageId: 'client.operator.0001',
        contentType: 'text',
        text: '你好，这里是平台运营，我们会为你核对相关信息。',
      },
      NOW,
    )
    const operatorReplay = await sendAdminAppConversationMessage(
      db,
      1,
      conversationId,
      'message.operator.test.001',
      {
        clientMessageId: 'client.operator.0001',
        contentType: 'text',
        text: '你好，这里是平台运营，我们会为你核对相关信息。',
      },
      NOW,
    )
    expect(operator).toMatchObject({ replayed: false, message: { sequence: 3, senderType: 'platform_operator' } })
    expect(operatorReplay).toMatchObject({ replayed: true, message: { messageId: operator.message.messageId } })

    await expect(markAdminAppConversationRead(db, 1, conversationId, 2, NOW)).resolves.toMatchObject({
      readSequence: 3,
    })
    await expect(markAppConversationRead(db, 2, conversationId, 3)).resolves.toEqual({
      conversationId,
      readSequence: 3,
    })
    const messages = await listAdminAppConversationMessages(
      db,
      1,
      conversationId,
      parseAdminAppConversationMessageQuery({}),
      NOW,
    )
    expect(messages.items).toHaveLength(3)
    expect(messages.items.at(-1)).toMatchObject({
      senderLabel: '平台运营',
      readByReceiver: true,
    })
  })

  it('运营正文访问会审计目的但不记录正文，回复拒绝冒充真人的表达', async () => {
    const created = await createConversation('pp_one', 'message.create.test.0005')
    const conversationId = created.conversation.conversationId
    await claimAdminAppConversation(
      db,
      1,
      conversationId,
      'message.assignment.claim.0002',
      NOW,
    )
    await auditAdminAppConversationAccess(db, 1, conversationId, 'req_message_access', NOW)

    await expect(sendAdminAppConversationMessage(
      db,
      1,
      conversationId,
      'message.operator.test.002',
      {
        clientMessageId: 'client.operator.0002',
        contentType: 'text',
        text: '我是本人，很高兴认识你。',
      },
      NOW,
    )).rejects.toMatchObject({ code: 'OPERATOR_LANGUAGE_NOT_ALLOWED', status: 400 })

    const audits = await db.prepare(`
      SELECT action, after_value FROM admin_audit_logs ORDER BY created_at, id
    `).all<{ action: string; after_value: string }>()
    expect(audits.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'app_conversation.body_access',
        after_value: expect.stringContaining('service_operation'),
      }),
    ]))
    expect(JSON.stringify(audits.results)).not.toContain(APP_MESSAGING_DISCLOSURE_TEXT)
    expect(JSON.stringify(audits.results)).not.toContain('我是本人')
  })

  it('过期会员和失效人物不能继续创建或发送', async () => {
    await db.prepare(`
      UPDATE app_membership_grants SET expires_at = '2026-08-05T00:00:00.000Z'
      WHERE id = 'amg_message_test'
    `).run()
    await expect(createConversation('pp_one', 'message.create.test.0006')).rejects.toMatchObject({
      code: 'ENTITLEMENT_REQUIRED',
      status: 403,
    })

    await db.prepare(`
      UPDATE app_membership_grants SET expires_at = '2026-09-01T00:00:00.000Z'
      WHERE id = 'amg_message_test'
    `).run()
    const created = await createConversation('pp_one', 'message.create.test.0007')
    await db.prepare(`
      UPDATE profile_public_projections SET visibility_status = 'hidden' WHERE profile_id = 'pp_one'
    `).run()
    await expect(sendAppViewerMessage(
      db,
      2,
      created.conversation.conversationId,
      APP_MESSAGE_1_CATALOG_ID,
      'message.viewer.test.0002',
      {
        clientMessageId: 'client.viewer.0002',
        contentType: 'text',
        text: '这条消息不应成功。',
      },
      NOW,
    )).rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN', status: 403 })
  })
})

function createConversation(profileId: string, idempotencyKey: string) {
  return createAppConversation(
    db,
    2,
    'acc_message_viewer',
    APP_MESSAGE_1_CATALOG_ID,
    APP_MESSAGING_DISCLOSURE_VERSION,
    idempotencyKey,
    { profileId, disclosureVersion: APP_MESSAGING_DISCLOSURE_VERSION },
    'https://api.test/api/v2/conversations',
    NOW,
  )
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
