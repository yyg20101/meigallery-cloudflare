import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  cancelPendingAppMessageModerationCasesForAccount,
  claimAdminAppMessageModerationCase,
  decideAdminAppMessageModerationCase,
  evaluateAppMessageModeration,
  getAdminAppMessageModerationCaseDetail,
  listAdminAppMessageModerationCases,
  prepareAppMessageModerationStatements,
} from './app-message-moderation'

const NOTIFICATION_MIGRATION = readFileSync(
  new URL('../../migrations/0076_app_in_app_notifications.sql', import.meta.url),
  'utf8',
)
const NOTIFICATION_GOVERNANCE_MIGRATION = readFileSync(
  new URL('../../migrations/0097_app_notification_template_governance.sql', import.meta.url),
  'utf8',
)
const MODERATION_MIGRATION = readFileSync(
  new URL('../../migrations/0112_app_message_moderation.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-20T08:00:00.000Z')
const CONTEXT = { policyId: 'mmp_message_8_dev_1', requireProductionReady: false }

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `app-message-moderation-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(BASE_SCHEMA))
  await db.exec(executableSql(NOTIFICATION_MIGRATION))
  await db.exec(executableSql(NOTIFICATION_GOVERNANCE_MIGRATION))
  await db.exec(executableSql(MODERATION_MIGRATION))
  await db.exec(executableSql(`
    INSERT INTO users (id, email, nickname, role, status, created_at) VALUES
      (1, 'viewer@example.com', '观看者', 'user', 'active', '2026-08-20T00:00:00.000Z'),
      (10, 'operator@example.com', '运营作者', 'admin', 'active', '2026-08-20T00:00:00.000Z'),
      (11, 'reviewer@example.com', '独立复核员', 'admin', 'active', '2026-08-20T00:00:00.000Z'),
      (12, 'reviewer-two@example.com', '复核员二号', 'owner', 'active', '2026-08-20T00:00:00.000Z');
    INSERT INTO app_account_security (account_id, account_public_id, status)
      VALUES (1, 'acc_moderation_viewer', 'active');
    INSERT INTO person_profiles (id, display_name) VALUES ('pp_moderation', '小桃');
    INSERT INTO app_conversations (
      id, account_id, profile_id, status, queue_status, last_sequence,
      viewer_read_sequence, operator_read_sequence, last_message_at,
      created_at, updated_at, restriction_source, closed_by_type
    ) VALUES (
      'cv_moderation_main', 1, 'pp_moderation', 'active', 'awaiting_viewer',
      0, 0, 0, '2026-08-20T07:00:00.000Z',
      '2026-08-20T07:00:00.000Z', '2026-08-20T07:00:00.000Z', NULL, NULL
    );
    UPDATE app_message_moderation_policies
    SET evaluation_enabled = 1, effective_at = '2026-08-20T00:00:00.000Z'
    WHERE id = 'mmp_message_8_dev_1';
    INSERT INTO app_message_moderation_rules (
      id, policy_id, actor_scope, match_type, normalized_pattern,
      action, reason_code, priority, active, created_by, created_at
    ) VALUES
      ('mmr_reject_contact', 'mmp_message_8_dev_1', 'both', 'contains',
       'hard-reject', 'reject', 'unsafe_contact', 10, 1, 12, '2026-08-20T00:00:00.000Z'),
      ('mmr_review_manual', 'mmp_message_8_dev_1', 'both', 'contains',
       'manual-review', 'review', 'manual_review', 20, 1, 12, '2026-08-20T00:00:00.000Z');
  `))
}, 30_000)

afterEach(async () => {
  await miniflare.dispose()
}, 30_000)

describe('Message-8 文本审核 D1', () => {
  it('没有显式策略时保持 accepted，且不创建审核事实', async () => {
    const result = await evaluateAppMessageModeration(
      db,
      { policyId: null, requireProductionReady: false },
      'viewer',
      '普通消息',
      NOW,
    )

    expect(result).toMatchObject({ status: 'accepted', policyId: null, evaluationId: null, caseId: null })
    expect(prepareAppMessageModerationStatements(db, result, 'msg_not_created')).toEqual([])
    await expect(count('app_message_moderation_evaluations')).resolves.toBe(0)
    await expect(count('app_message_moderation_cases')).resolves.toBe(0)
  })

  it('命中 review 规则后只进入专用队列，普通运营查询看不到正文', async () => {
    const seeded = await seedModeratedMessage({
      messageId: 'msg_viewer_pending_01',
      sequence: 1,
      senderType: 'viewer',
      text: '这条需要 manual-review',
    })

    expect(seeded.evaluation.status).toBe('review_pending')
    const queue = await listAdminAppMessageModerationCases(
      db,
      11,
      { status: null, limit: 20 },
      NOW,
    )
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0]).toMatchObject({
      caseId: seeded.evaluation.caseId,
      messageId: 'msg_viewer_pending_01',
      status: 'pending',
      bodyLength: 18,
    })
    expect(JSON.stringify(queue)).not.toContain('这条需要')

    const normalWorkbench = await db.prepare(`
      SELECT body_text
      FROM app_conversation_messages
      WHERE conversation_id = 'cv_moderation_main'
        AND status IN ('accepted', 'recalled')
    `).all()
    expect(normalWorkbench.results).toEqual([])
  })

  it('独立复核通过后恢复消息与队列，并稳定回放原裁决', async () => {
    const seeded = await seedModeratedMessage({
      messageId: 'msg_viewer_pending_02',
      sequence: 2,
      senderType: 'viewer',
      text: 'manual-review 后通过',
    })
    const caseId = seeded.evaluation.caseId!
    const claim = await claimAdminAppMessageModerationCase(
      db,
      11,
      caseId,
      'moderation.claim.viewer.0001',
      { expectedVersion: 1 },
      NOW,
    )
    expect(claim).toMatchObject({ status: 'in_review', version: 2, assignedAdminId: 11, replayed: false })

    const detail = await getAdminAppMessageModerationCaseDetail(
      db,
      11,
      caseId,
      'request.moderation.viewer.0001',
      NOW,
    )
    expect(detail.text).toBe('manual-review 后通过')
    expect(detail.accessReason).toBe('message_moderation_review')

    const decided = await decideAdminAppMessageModerationCase(
      db,
      11,
      caseId,
      'moderation.decision.viewer.0001',
      { expectedVersion: 2, decision: 'accepted', reasonCode: 'review_accepted' },
      NOW,
    )
    expect(decided).toMatchObject({
      status: 'accepted',
      messageStatus: 'accepted',
      version: 3,
      autoAssignmentEligible: true,
      replayed: false,
    })
    await expect(messageStatus('msg_viewer_pending_02')).resolves.toBe('accepted')
    await expect(messageSequence('msg_viewer_pending_02')).resolves.toBeGreaterThan(2)
    await expect(conversationQueue('cv_moderation_main')).resolves.toBe('awaiting_operator')

    const replay = await decideAdminAppMessageModerationCase(
      db,
      11,
      caseId,
      'moderation.decision.viewer.0001',
      { expectedVersion: 2, decision: 'accepted', reasonCode: 'review_accepted' },
      NOW,
    )
    expect(replay).toMatchObject({
      status: 'accepted',
      version: 3,
      autoAssignmentEligible: true,
      replayed: true,
    })
    await expect(countWhere('app_message_moderation_case_events', "event_type = 'accepted'")).resolves.toBe(1)
    await expect(countWhere('admin_audit_logs', "action = 'app_message_moderation.body_access'")).resolves.toBe(1)
  })

  it('运营发送者不能领取自己的待审消息', async () => {
    const seeded = await seedModeratedMessage({
      messageId: 'msg_operator_pending_own',
      sequence: 3,
      senderType: 'platform_operator',
      actorAdminId: 10,
      text: 'manual-review 运营回复',
    })

    await expect(claimAdminAppMessageModerationCase(
      db,
      10,
      seeded.evaluation.caseId!,
      'moderation.claim.operator.own.0001',
      { expectedVersion: 1 },
      NOW,
    )).rejects.toMatchObject({ code: 'MODERATION_AUTHOR_SEPARATION_REQUIRED', status: 403 })
  })

  it('账号注销会取消待审租约并阻止继续读取正文', async () => {
    await enableNotificationGeneration()
    const seeded = await seedModeratedMessage({
      messageId: 'msg_viewer_pending_deletion',
      sequence: 3,
      senderType: 'viewer',
      text: 'manual-review 注销取消',
    })
    const caseId = seeded.evaluation.caseId!
    await claimAdminAppMessageModerationCase(
      db,
      11,
      caseId,
      'moderation.claim.deletion.0001',
      { expectedVersion: 1 },
      NOW,
    )

    await cancelPendingAppMessageModerationCasesForAccount(
      db,
      1,
      new Date('2026-08-20T08:05:00.000Z'),
    )

    const cancelled = await db.prepare(`
      SELECT status, version, assigned_admin_id, lease_expires_at, decision_reason_code
      FROM app_message_moderation_cases
      WHERE id = ?
    `).bind(caseId).first<{
      status: string
      version: number
      assigned_admin_id: number | null
      lease_expires_at: string | null
      decision_reason_code: string | null
    }>()
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      version: 3,
      assigned_admin_id: null,
      lease_expires_at: null,
      decision_reason_code: 'account_deletion',
    })
    await expect(countWhere(
      'app_message_moderation_case_events',
      `case_id = '${caseId}' AND event_type = 'cancelled'`,
    )).resolves.toBe(1)
    await expect(countWhere(
      'app_message_moderation_idempotency',
      `case_id = '${caseId}'`,
    )).resolves.toBe(0)
    await expect(messageStatus('msg_viewer_pending_deletion')).resolves.toBe('review_pending')
    await expect(outboxEvent('msg_viewer_pending_deletion')).resolves.toBeNull()
    await expect(getAdminAppMessageModerationCaseDetail(
      db,
      11,
      caseId,
      'request.moderation.deletion.0001',
      new Date('2026-08-20T08:06:00.000Z'),
    )).rejects.toMatchObject({ code: 'MODERATION_CASE_ACCESS_DENIED', status: 403 })
  })

  it('拒绝结果只对消息发送者可见，且按消息偏好进入通知 Outbox', async () => {
    await enableNotificationGeneration()
    const seeded = await seedModeratedMessage({
      messageId: 'msg_viewer_pending_reject',
      sequence: 4,
      senderType: 'viewer',
      text: 'manual-review 最终拒绝',
    })
    const caseId = seeded.evaluation.caseId!
    await claimAdminAppMessageModerationCase(
      db,
      11,
      caseId,
      'moderation.claim.viewer.reject.0001',
      { expectedVersion: 1 },
      NOW,
    )
    await decideAdminAppMessageModerationCase(
      db,
      11,
      caseId,
      'moderation.decision.viewer.reject.0001',
      { expectedVersion: 2, decision: 'rejected', reasonCode: 'unsafe_contact' },
      NOW,
    )

    await expect(messageStatus('msg_viewer_pending_reject')).resolves.toBe('rejected')
    await expect(messageSequence('msg_viewer_pending_reject')).resolves.toBe(4)
    await expect(countWhere(
      'app_conversation_messages',
      "id = 'msg_viewer_pending_reject' AND status IN ('accepted', 'recalled')",
    )).resolves.toBe(0)
    await expect(countWhere(
      'app_conversation_messages',
      "id = 'msg_viewer_pending_reject' AND sender_type = 'viewer'",
    )).resolves.toBe(1)
    await expect(outboxEvent('msg_viewer_pending_reject')).resolves.toBe('message.review_rejected')
  })

  it('规则直接拒绝观看者消息时立即生成无正文结果通知', async () => {
    await enableNotificationGeneration()
    const seeded = await seedModeratedMessage({
      messageId: 'msg_viewer_immediate_reject',
      sequence: 6,
      senderType: 'viewer',
      text: 'hard-reject 直接拒绝',
    })

    expect(seeded.evaluation).toMatchObject({ status: 'rejected', caseId: null })
    await expect(count('app_message_moderation_cases')).resolves.toBe(0)
    await expect(outboxEvent('msg_viewer_immediate_reject')).resolves.toBe('message.review_rejected')
  })

  it('待审运营回复仅在通过后通知，管理员限制会话而观看者自关不会误通知', async () => {
    await enableNotificationGeneration()
    const seeded = await seedModeratedMessage({
      messageId: 'msg_operator_pending_approved',
      sequence: 5,
      senderType: 'platform_operator',
      actorAdminId: 10,
      text: 'manual-review 运营通过',
    })
    expect(await outboxEvent('msg_operator_pending_approved')).toBeNull()
    await claimAdminAppMessageModerationCase(
      db,
      11,
      seeded.evaluation.caseId!,
      'moderation.claim.operator.approve.0001',
      { expectedVersion: 1 },
      NOW,
    )
    await decideAdminAppMessageModerationCase(
      db,
      11,
      seeded.evaluation.caseId!,
      'moderation.decision.operator.approve.0001',
      { expectedVersion: 2, decision: 'accepted', reasonCode: 'review_accepted' },
      NOW,
    )
    await expect(outboxEvent('msg_operator_pending_approved')).resolves.toBe('message.platform_reply')

    await db.exec(executableSql(`
      INSERT INTO app_conversations (
        id, account_id, profile_id, status, queue_status, last_sequence,
        viewer_read_sequence, operator_read_sequence, last_message_at,
        created_at, updated_at, restriction_source, closed_by_type
      ) VALUES
        ('cv_admin_restricted', 1, 'pp_moderation', 'active', 'awaiting_viewer', 0, 0, 0,
         '2026-08-20T07:00:00.000Z', '2026-08-20T07:00:00.000Z',
         '2026-08-20T07:00:00.000Z', NULL, NULL),
        ('cv_viewer_closed', 1, 'pp_moderation', 'active', 'awaiting_viewer', 0, 0, 0,
         '2026-08-20T07:00:00.000Z', '2026-08-20T07:00:00.000Z',
         '2026-08-20T07:00:00.000Z', NULL, NULL);
      UPDATE app_conversations
      SET status = 'restricted', queue_status = 'closed',
          restriction_source = 'admin_safety', updated_at = '2026-08-20T08:10:00.000Z'
      WHERE id = 'cv_admin_restricted';
      UPDATE app_conversations
      SET status = 'closed', queue_status = 'closed', closed_by_type = 'viewer',
          updated_at = '2026-08-20T08:11:00.000Z'
      WHERE id = 'cv_viewer_closed';
    `))
    await expect(outboxEvent('cv_admin_restricted.restricted')).resolves.toBe('message.conversation_restricted')
    await expect(outboxEvent('cv_viewer_closed.closed')).resolves.toBeNull()

    await db.exec(executableSql(`
      UPDATE app_conversations
      SET status = 'closed', closed_by_type = 'admin', updated_at = '2026-08-20T08:12:00.000Z'
      WHERE id = 'cv_admin_restricted';
    `))
    await expect(outboxEvent('cv_admin_restricted.closed')).resolves.toBe('message.conversation_closed')
  })
})

async function seedModeratedMessage(input: {
  messageId: string
  sequence: number
  senderType: 'viewer' | 'platform_operator'
  actorAdminId?: number
  text: string
}) {
  const evaluation = await evaluateAppMessageModeration(
    db,
    CONTEXT,
    input.senderType,
    input.text,
    NOW,
  )
  const bodySha256 = await sha256Hex(input.text)
  await db.batch([
    db.prepare(`
      INSERT INTO app_conversation_messages (
        id, conversation_id, sequence, sender_type, client_message_id,
        content_type, body_text, body_sha256, status,
        actor_account_id, actor_admin_id, created_at, recalled_at
      ) VALUES (?, 'cv_moderation_main', ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      input.messageId,
      input.sequence,
      input.senderType,
      `client.${input.messageId}`,
      input.text,
      bodySha256,
      evaluation.status,
      input.senderType === 'viewer' ? 1 : null,
      input.senderType === 'platform_operator' ? input.actorAdminId ?? 10 : null,
      NOW.toISOString(),
    ),
    ...prepareAppMessageModerationStatements(db, evaluation, input.messageId),
    db.prepare(`
      UPDATE app_conversations
      SET last_sequence = MAX(last_sequence, ?), last_message_at = ?, updated_at = ?
      WHERE id = 'cv_moderation_main'
    `).bind(input.sequence, NOW.toISOString(), NOW.toISOString()),
  ])
  return { evaluation }
}

async function enableNotificationGeneration() {
  await db.prepare(`
    UPDATE app_notification_policies
    SET generation_enabled = 1, effective_at = '2026-08-20T00:00:00.000Z'
    WHERE id = 'ntp_app_1_0_message_3_dev_1'
  `).run()
}

async function sha256Hex(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function count(tableName: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first<{ count: number }>()
  return Number(row?.count ?? -1)
}

async function countWhere(tableName: string, where: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${where}`).first<{ count: number }>()
  return Number(row?.count ?? -1)
}

async function messageStatus(messageId: string) {
  const row = await db.prepare('SELECT status FROM app_conversation_messages WHERE id = ?')
    .bind(messageId)
    .first<{ status: string }>()
  return row?.status ?? null
}

async function messageSequence(messageId: string) {
  const row = await db.prepare('SELECT sequence FROM app_conversation_messages WHERE id = ?')
    .bind(messageId)
    .first<{ sequence: number }>()
  return Number(row?.sequence ?? -1)
}

async function conversationQueue(conversationId: string) {
  const row = await db.prepare('SELECT queue_status FROM app_conversations WHERE id = ?')
    .bind(conversationId)
    .first<{ queue_status: string }>()
  return row?.queue_status ?? null
}

async function outboxEvent(eventRef: string) {
  const row = await db.prepare('SELECT event_type FROM app_notification_outbox WHERE event_ref = ?')
    .bind(eventRef)
    .first<{ event_type: string }>()
  return row?.event_type ?? null
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
    account_id INTEGER PRIMARY KEY REFERENCES users(id),
    account_public_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL
  );
  CREATE TABLE person_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
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
  CREATE TABLE app_devices (id TEXT PRIMARY KEY);
  CREATE TABLE app_conversations (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES users(id),
    profile_id TEXT NOT NULL REFERENCES person_profiles(id),
    status TEXT NOT NULL,
    queue_status TEXT NOT NULL,
    last_sequence INTEGER NOT NULL,
    viewer_read_sequence INTEGER NOT NULL,
    operator_read_sequence INTEGER NOT NULL,
    last_message_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    restriction_source TEXT,
    closed_by_type TEXT
  );
  CREATE TABLE app_conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES app_conversations(id),
    sequence INTEGER NOT NULL,
    sender_type TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_account_id INTEGER REFERENCES users(id),
    actor_admin_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    recalled_at TEXT,
    UNIQUE (conversation_id, sequence),
    UNIQUE (conversation_id, client_message_id)
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
