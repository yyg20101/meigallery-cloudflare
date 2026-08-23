import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  claimAdminSafetyReport,
  decideAdminSafetyReport,
  getAdminSafetyReport,
  parseAdminSafetyReportListQuery,
  updateAdminMessagingRuntimeControl,
} from './admin-app-safety'
import {
  claimAdminSafetyAppeal,
  decideAdminSafetyAppeal,
  getAdminSafetyAppeal,
  parseAdminSafetyAppealListQuery,
} from './admin-app-safety-appeals'
import {
  claimAdminAppConversation,
  listAdminAppConversationMessages,
  parseAdminAppConversationMessageQuery,
} from './admin-app-messaging'
import {
  APP_MESSAGE_1_CATALOG_ID,
  APP_MESSAGING_DISCLOSURE_VERSION,
  createAppConversation,
  sendAppViewerMessage,
} from './app-messaging'
import {
  APP_SAFETY_REASON_CATALOG_ID,
  APP_SAFETY_APPEAL_POLICY_ID,
  createAppSafetyReport,
  getAppSafetyReport,
  setAppProfileBlock,
} from './app-safety'
import {
  createAppSafetyAppeal,
  getAppSafetyAppeal,
  listAppSafetyAppeals,
  parseAppAppealListQuery,
} from './app-safety-appeals'

const MEMBERSHIP_MIGRATION = migration('0071_app_membership_catalog_and_grants.sql')
const MESSAGE_MIGRATION = migration('0072_app_managed_conversations.sql')
const SAFETY_MIGRATION = migration('0073_app_messaging_safety_operations.sql')
const APPEAL_MIGRATION = migration('0074_app_safety_appeals.sql')
const COLLECTION_MIGRATION = migration('0078_app_favorites_and_view_history.sql')
const TAXONOMY_MIGRATION = migration('0081_app_taxonomy_catalog.sql')
const ROUTING_MIGRATION = migration('0086_app_conversation_routing_and_shifts.sql')
const NOW = new Date('2026-08-07T08:00:00.000Z')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-safety' },
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
    CREATE TABLE galleries (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      cover_key TEXT
    );
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY,
      gallery_id TEXT NOT NULL REFERENCES galleries(id)
    );
    CREATE TABLE person_profiles (
      id TEXT PRIMARY KEY,
      source_gallery_id TEXT NOT NULL REFERENCES galleries(id),
      display_name TEXT NOT NULL,
      content_version INTEGER NOT NULL DEFAULT 1,
      publication_status TEXT NOT NULL DEFAULT 'published',
      region_code TEXT
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
      published_at TEXT NOT NULL,
      projection_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE app_account_security (
      account_id INTEGER PRIMARY KEY REFERENCES users(id),
      account_public_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE app_viewer_interactions (
      account_id INTEGER NOT NULL REFERENCES users(id),
      profile_id TEXT NOT NULL REFERENCES person_profiles(id),
      interaction_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, profile_id, interaction_type)
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
  await db.exec(executableSql(APPEAL_MIGRATION))
  await db.exec(executableSql(COLLECTION_MIGRATION))
  await db.exec(executableSql(TAXONOMY_MIGRATION))
  await db.exec(executableSql(ROUTING_MIGRATION))
  await db.exec(executableSql(`
    ALTER TABLE app_safety_appeal_policies ADD COLUMN review_sla_hours INTEGER;
    ALTER TABLE app_safety_appeal_policies
      ADD COLUMN review_sla_decision_status TEXT NOT NULL DEFAULT 'unresolved';
    ALTER TABLE app_safety_appeals ADD COLUMN review_state TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE app_safety_appeals ADD COLUMN review_due_at TEXT;
    ALTER TABLE app_safety_appeals ADD COLUMN supplement_due_at TEXT;
    CREATE TABLE app_appeal_review_events (
      id TEXT PRIMARY KEY,
      appeal_kind TEXT NOT NULL,
      appeal_id TEXT NOT NULL,
      appeal_version INTEGER NOT NULL,
      actor_type TEXT NOT NULL,
      actor_account_id INTEGER,
      actor_admin_id INTEGER,
      event_type TEXT NOT NULL,
      review_state_from TEXT NOT NULL,
      review_state_to TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      user_visible_message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE app_safety_appeal_supplements (
      id TEXT PRIMARY KEY,
      appeal_id TEXT NOT NULL REFERENCES app_safety_appeals(id),
      sequence INTEGER NOT NULL,
      account_id INTEGER NOT NULL REFERENCES users(id),
      note_text TEXT NOT NULL,
      note_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (appeal_id, sequence)
    );
  `))
})

beforeEach(async () => {
  await db.exec(executableSql(`
    DELETE FROM app_safety_appeal_idempotency;
    DELETE FROM app_safety_appeal_events;
    DELETE FROM app_safety_appeals;
    DELETE FROM app_safety_report_events;
    DELETE FROM app_safety_report_evidence;
    DELETE FROM app_safety_reports;
    DELETE FROM app_safety_idempotency;
    DELETE FROM app_profile_block_events;
    DELETE FROM app_profile_blocks;
    DELETE FROM app_conversation_assignment_events;
    DELETE FROM app_conversation_assignment_state;
    DELETE FROM app_messaging_idempotency;
    DELETE FROM app_conversation_messages;
    DELETE FROM app_conversation_quota_consumptions;
    DELETE FROM app_conversations;
    DELETE FROM app_viewer_interactions;
    DELETE FROM app_membership_grant_revocations;
    DELETE FROM app_membership_grants;
    DELETE FROM admin_audit_logs;
    DELETE FROM profile_public_projections;
    DELETE FROM media_assets;
    DELETE FROM person_profiles;
    DELETE FROM galleries;
    DELETE FROM app_account_security;
    DELETE FROM users;

    UPDATE app_messaging_runtime_controls
    SET new_conversations_paused = 0,
        viewer_sends_paused = 0,
        operator_sends_paused = 0,
        emergency_reason_code = NULL,
        user_visible_message = '平台话题服务正常；如遇安全或容量事件，平台可能临时停止新话题或发送。',
        max_open_conversations = 100,
        max_active_assignments_per_operator = 10,
        assignment_lease_minutes = 30,
        version = 1,
        mutation_token = NULL,
        updated_by = NULL,
        updated_at = '2026-08-07T00:00:00.000Z';

    UPDATE app_membership_tier_entitlements
    SET value_json = '2'
    WHERE catalog_version_id = 'amc_app_1_0_message_1_dev_1'
      AND tier_id = 'amt_heart_meet'
      AND entitlement_key = 'direct_message.new_threads_per_day';

    INSERT INTO users (id, email, nickname, status) VALUES
      (1, 'admin-one@example.com', '审核一号', 'active'),
      (2, 'viewer@example.com', '观看者', 'active'),
      (3, 'admin-two@example.com', '审核二号', 'active');
    INSERT INTO app_account_security (account_id, account_public_id, status)
      VALUES (2, 'acc_safety_viewer', 'active');
    INSERT INTO galleries (id, status, cover_key) VALUES
      ('gallery_one', 'published', 'covers/one.jpg'),
      ('gallery_two', 'published', 'covers/two.jpg');
    INSERT INTO media_assets (id, gallery_id) VALUES ('media_one', 'gallery_one');
    INSERT INTO person_profiles (
      id, source_gallery_id, display_name, content_version, publication_status
    ) VALUES
      ('pp_one', 'gallery_one', '小桃', 1, 'published'),
      ('pp_two', 'gallery_two', '小满', 1, 'published');
    INSERT INTO profile_public_projections (
      profile_id, person_id, display_name, summary, source_gallery_id,
      tags_json, verification_status, verification_valid_until,
      publication_status, authorization_status, authorization_valid_from,
      authorization_valid_until, visibility_status, operation_mode,
      operation_label, region_code, region_label, region_precision,
      recommendation_score, heat_score, recommendation_reason_code,
      recommendation_rule_version, published_at, projection_version
    ) VALUES
      ('pp_one', 'per_one', '小桃', '清新写真', 'gallery_one', '[]',
       'verified', NULL, 'published', 'active', '2026-01-01T00:00:00.000Z',
       NULL, 'visible', 'platform_managed', '消息由平台运营接收',
       'shanghai', '上海', 'city', 100, 80, 'EDITORIAL_QUALITY',
       'discovery_v1', '2026-08-01T00:00:00.000Z', 1),
      ('pp_two', 'per_two', '小满', '生活记录', 'gallery_two', '[]',
       'verified', NULL, 'published', 'active', '2026-01-01T00:00:00.000Z',
       NULL, 'visible', 'platform_managed', '消息由平台运营接收',
       'hangzhou', '杭州', 'city', 90, 70, 'EDITORIAL_QUALITY',
       'discovery_v1', '2026-08-02T00:00:00.000Z', 1);
    INSERT INTO app_membership_grants (
      id, user_id, catalog_version_id, tier_id, tier_code_snapshot,
      tier_name_snapshot, rank_snapshot, starts_at, expires_at,
      source_type, reason_code, user_visible_note, internal_note,
      business_reference, granted_by, created_at
    ) VALUES (
      'amg_safety_test', 2, 'amc_app_1_0_message_1_dev_1', 'amt_heart_meet',
      'heart_meet', '心遇', 10, '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z', 'manual_admin', 'manual_review',
      '平台已发放心遇会员。', NULL, 'SAFETY-TEST-GRANT', 1,
      '2026-08-01T00:00:00.000Z'
    );
  `))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('Message-2 举报、拉黑和运营安全闭环', () => {
  it('安全审核队列默认只读取待处理案件并允许显式查看全部状态', () => {
    expect(parseAdminSafetyReportListQuery({})).toMatchObject({ status: 'open', limit: 40 })
    expect(parseAdminSafetyReportListQuery({ status: 'all', limit: '500' }))
      .toMatchObject({ status: null, limit: 100 })
  })

  it('申诉队列默认只读待处理案件且游标与账号隔离', () => {
    expect(parseAdminSafetyAppealListQuery({})).toMatchObject({ status: 'open', limit: 40 })
    expect(parseAdminSafetyAppealListQuery({ status: 'all', limit: '500' }))
      .toMatchObject({ status: 'all', limit: 100 })
    expect(parseAppAppealListQuery({ accountScope: 'acc_safety_viewer' }))
      .toMatchObject({ limit: 20, cursor: null })
  })

  it('举报幂等固定最小证据，领取后可形成无违规结论且审计不复制说明', async () => {
    const first = await createAppSafetyReport(
      db,
      2,
      APP_SAFETY_REASON_CATALOG_ID,
      'safety.report.profile.0001',
      {
        targetType: 'person_profile',
        profileId: 'pp_one',
        reasonCode: 'privacy_exposure',
        description: '这是只允许案件审核读取的举报说明。',
      },
      NOW,
    )
    const replay = await createAppSafetyReport(
      db,
      2,
      APP_SAFETY_REASON_CATALOG_ID,
      'safety.report.profile.0001',
      {
        targetType: 'person_profile',
        profileId: 'pp_one',
        reasonCode: 'privacy_exposure',
        description: '这是只允许案件审核读取的举报说明。',
      },
      NOW,
    )
    expect(replay).toMatchObject({ replayed: true, report: { reportId: first.report.reportId } })

    await expect(getAdminSafetyReport(db, 1, first.report.reportId, 'req_denied', NOW))
      .rejects.toMatchObject({ code: 'REPORT_ASSIGNMENT_REQUIRED', status: 403 })
    const claim = await claimAdminSafetyReport(
      db,
      1,
      first.report.reportId,
      'safety.report.claim.0001',
      NOW,
    )
    expect(claim.report.assignment.status).toBe('mine')
    const detail = await getAdminSafetyReport(db, 1, first.report.reportId, 'req_evidence', NOW)
    expect(detail).toMatchObject({
      description: '这是只允许案件审核读取的举报说明。',
      evidence: { profileContentVersion: 1, profileProjectionVersion: 1, messages: [] },
    })

    const decision = await decideAdminSafetyReport(
      db,
      1,
      first.report.reportId,
      'safety.report.decision.0001',
      {
        expectedVersion: claim.report.version,
        outcome: 'no_violation',
        actionType: 'none',
        decisionReasonCode: 'review_no_violation',
        userVisibleMessage: '平台已完成审核，当前未发现违规。',
      },
      NOW,
    )
    expect(decision.report).toMatchObject({ status: 'no_violation', userVisibleStatus: 'no_violation' })
    await expect(getAppSafetyReport(db, 2, first.report.reportId))
      .resolves.toMatchObject({ status: 'no_violation', userVisibleMessage: '平台已完成审核，当前未发现违规。' })

    const audits = await db.prepare(`SELECT action, before_value, after_value FROM admin_audit_logs`)
      .all<{ action: string; before_value: string | null; after_value: string | null }>()
    expect(audits.results.map(row => row.action)).toEqual(expect.arrayContaining([
      'moderation.report.assignment_denied',
      'moderation.report.claim',
      'moderation.report.evidence_access',
      'moderation.report.decision',
    ]))
    expect(JSON.stringify(audits.results)).not.toContain('这是只允许案件审核读取的举报说明')
  })

  it('未发现违规结论可由非原审核人独立复核，改判只重新打开原举报', async () => {
    const created = await createAppSafetyReport(
      db,
      2,
      APP_SAFETY_REASON_CATALOG_ID,
      'safety.appeal.report.0001',
      {
        targetType: 'person_profile',
        profileId: 'pp_one',
        reasonCode: 'authorization_impersonation',
        description: '原举报说明，不得复制到审计日志。',
      },
      NOW,
    )
    const reportClaim = await claimAdminSafetyReport(
      db,
      1,
      created.report.reportId,
      'safety.appeal.report.claim.0001',
      NOW,
    )
    await decideAdminSafetyReport(
      db,
      1,
      created.report.reportId,
      'safety.appeal.report.decision.0001',
      {
        expectedVersion: reportClaim.report.version,
        outcome: 'no_violation',
        actionType: 'none',
        decisionReasonCode: 'review_no_violation',
        userVisibleMessage: '平台已完成审核，当前未发现违规。',
      },
      NOW,
    )
    const report = await getAppSafetyReport(db, 2, created.report.reportId, {
      enabled: true,
      policyId: APP_SAFETY_APPEAL_POLICY_ID,
      requireProductionReady: false,
      now: NOW,
    })
    expect(report.appeal).toEqual({
      canAppeal: true,
      unavailableReason: null,
      appealId: null,
      status: null,
    })

    const first = await createAppSafetyAppeal(
      db,
      2,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.appeal.create.0001',
      {
        reportId: report.reportId,
        expectedReportVersion: report.version,
        statement: '请由不同审核人员复核这次结论。',
      },
      NOW,
    )
    const replay = await createAppSafetyAppeal(
      db,
      2,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.appeal.create.0001',
      {
        reportId: report.reportId,
        expectedReportVersion: report.version,
        statement: '请由不同审核人员复核这次结论。',
      },
      NOW,
    )
    expect(replay).toMatchObject({ replayed: true, appeal: { appealId: first.appeal.appealId } })
    await expect(claimAdminSafetyAppeal(
      db,
      1,
      first.appeal.appealId,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.appeal.claim.denied.0001',
      NOW,
    )).rejects.toMatchObject({ code: 'APPEAL_REVIEWER_SEPARATION_REQUIRED', status: 403 })

    const appealClaim = await claimAdminSafetyAppeal(
      db,
      3,
      first.appeal.appealId,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.appeal.claim.0001',
      NOW,
    )
    expect(appealClaim.appeal).toMatchObject({ assignedToMe: true, status: 'processing' })
    const detail = await getAdminSafetyAppeal(
      db,
      3,
      first.appeal.appealId,
      'req_appeal_review',
      NOW,
    )
    expect(detail).toMatchObject({
      statement: '请由不同审核人员复核这次结论。',
      report: { description: '原举报说明，不得复制到审计日志。' },
    })

    const decided = await decideAdminSafetyAppeal(
      db,
      3,
      first.appeal.appealId,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.appeal.decision.0001',
      {
        expectedVersion: appealClaim.appeal.version,
        outcome: 'changed',
        reasonCode: 'independent_review_changed',
        userVisibleMessage: '独立复核后，举报已重新进入审核。',
      },
      NOW,
    )
    expect(decided.appeal.status).toBe('changed')
    await expect(getAppSafetyAppeal(db, 2, first.appeal.appealId))
      .resolves.toMatchObject({ status: 'changed' })
    const reopened = await db.prepare(`
      SELECT status, user_visible_status, assigned_admin_id, resolved_at
      FROM app_safety_reports WHERE id = ?
    `).bind(report.reportId).first<{
      status: string
      user_visible_status: string
      assigned_admin_id: number
      resolved_at: string | null
    }>()
    expect(reopened).toEqual({
      status: 'investigating',
      user_visible_status: 'processing',
      assigned_admin_id: 3,
      resolved_at: null,
    })
    const appeals = await listAppSafetyAppeals(
      db,
      2,
      'acc_safety_viewer',
      parseAppAppealListQuery({ accountScope: 'acc_safety_viewer' }),
    )
    expect(appeals.data).toHaveLength(1)
    const audits = await db.prepare(`SELECT action, before_value, after_value FROM admin_audit_logs`)
      .all<{ action: string; before_value: string | null; after_value: string | null }>()
    expect(audits.results.map(row => row.action)).toEqual(expect.arrayContaining([
      'moderation.appeal.claim_denied',
      'moderation.appeal.claim',
      'moderation.appeal.detail_access',
      'moderation.appeal.decision',
    ]))
    expect(JSON.stringify(audits.results)).not.toContain('请由不同审核人员复核这次结论')
    expect(JSON.stringify(audits.results)).not.toContain('原举报说明')
  })

  it('独立复核维持原结论时不改写举报状态且同一结论不再开放申请', async () => {
    const created = await createAppSafetyReport(
      db,
      2,
      APP_SAFETY_REASON_CATALOG_ID,
      'safety.upheld.report.0001',
      {
        targetType: 'person_profile',
        profileId: 'pp_two',
        reasonCode: 'privacy_exposure',
        description: '请核实该资料是否存在隐私问题。',
      },
      NOW,
    )
    const reportClaim = await claimAdminSafetyReport(
      db,
      1,
      created.report.reportId,
      'safety.upheld.report.claim.0001',
      NOW,
    )
    const originalDecision = await decideAdminSafetyReport(
      db,
      1,
      created.report.reportId,
      'safety.upheld.report.decision.0001',
      {
        expectedVersion: reportClaim.report.version,
        outcome: 'no_violation',
        actionType: 'none',
        decisionReasonCode: 'review_no_violation',
        userVisibleMessage: '平台已完成审核，当前未发现违规。',
      },
      NOW,
    )
    const createdAppeal = await createAppSafetyAppeal(
      db,
      2,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.upheld.appeal.create.0001',
      {
        reportId: created.report.reportId,
        expectedReportVersion: originalDecision.report.version,
        statement: '我仍认为结论需要不同审核人员复核。',
      },
      NOW,
    )
    const appealClaim = await claimAdminSafetyAppeal(
      db,
      3,
      createdAppeal.appeal.appealId,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.upheld.appeal.claim.0001',
      NOW,
    )
    const upheld = await decideAdminSafetyAppeal(
      db,
      3,
      createdAppeal.appeal.appealId,
      APP_SAFETY_APPEAL_POLICY_ID,
      'safety.upheld.appeal.decision.0001',
      {
        expectedVersion: appealClaim.appeal.version,
        outcome: 'upheld',
        reasonCode: 'independent_review_upheld',
        userVisibleMessage: '独立复核已完成，维持原审核结论。',
      },
      NOW,
    )
    expect(upheld.appeal.status).toBe('upheld')

    const reportRow = await db.prepare(`
      SELECT status, version, assigned_admin_id, resolved_at
      FROM app_safety_reports
      WHERE id = ?
    `).bind(created.report.reportId).first<{
      status: string
      version: number
      assigned_admin_id: number
      resolved_at: string | null
    }>()
    expect(reportRow).toEqual({
      status: 'no_violation',
      version: originalDecision.report.version,
      assigned_admin_id: 1,
      resolved_at: NOW.toISOString(),
    })
    const reportDetail = await getAppSafetyReport(db, 2, created.report.reportId, {
      enabled: true,
      policyId: APP_SAFETY_APPEAL_POLICY_ID,
      requireProductionReady: false,
      now: NOW,
    })
    expect(reportDetail.appeal).toEqual({
      canAppeal: false,
      unavailableReason: 'APPEAL_ALREADY_EXISTS',
      appealId: createdAppeal.appeal.appealId,
      status: 'upheld',
    })
  })

  it('消息举报只返回目标消息和前后一条，并可将关联话题原子转为只读', async () => {
    const conversation = await createConversation('pp_one', 'safety.conversation.create.0001')
    const sent = await sendAppViewerMessage(
      db,
      2,
      conversation.conversation.conversationId,
      APP_MESSAGE_1_CATALOG_ID,
      'safety.viewer.message.0001',
      {
        clientMessageId: 'safety.viewer.client.0001',
        contentType: 'text',
        text: '这是一条仅供受控证据窗口读取的消息。',
      },
      NOW,
    )
    const created = await createAppSafetyReport(
      db,
      2,
      APP_SAFETY_REASON_CATALOG_ID,
      'safety.report.message.0001',
      {
        targetType: 'message',
        profileId: 'pp_one',
        conversationId: conversation.conversation.conversationId,
        messageId: sent.message.messageId,
        reasonCode: 'harassment',
        description: '请审核目标消息。',
      },
      NOW,
    )
    const claim = await claimAdminSafetyReport(
      db,
      1,
      created.report.reportId,
      'safety.report.claim.0002',
      NOW,
    )
    const detail = await getAdminSafetyReport(db, 1, created.report.reportId, 'req_message_evidence', NOW)
    expect(detail.evidence.messages).toHaveLength(2)
    expect(detail.evidence.messages.map(message => message.role)).toEqual(['before', 'target'])
    expect(detail.evidence.messages.find(message => message.role === 'target')).toMatchObject({
      text: '这是一条仅供受控证据窗口读取的消息。',
      snapshotIntegrityMatches: true,
    })

    const decision = await decideAdminSafetyReport(
      db,
      1,
      created.report.reportId,
      'safety.report.decision.0002',
      {
        expectedVersion: claim.report.version,
        outcome: 'actioned',
        actionType: 'conversation_restricted',
        decisionReasonCode: 'conversation_restricted_after_review',
        userVisibleMessage: '平台已完成审核，并将关联话题转为只读。',
      },
      NOW,
    )
    expect(decision.report.status).toBe('actioned')
    const state = await db.prepare(`SELECT status, queue_status FROM app_conversations WHERE id = ?`)
      .bind(conversation.conversation.conversationId)
      .first<{ status: string; queue_status: string }>()
    expect(state).toEqual({ status: 'restricted', queue_status: 'closed' })

    const audits = await db.prepare(`SELECT before_value, after_value FROM admin_audit_logs`)
      .all<{ before_value: string | null; after_value: string | null }>()
    expect(JSON.stringify(audits.results)).not.toContain('这是一条仅供受控证据窗口读取的消息')
  })

  it('拉黑清理互动并关闭既有话题，解除后不恢复旧关系或旧话题', async () => {
    const conversation = await createConversation('pp_one', 'safety.conversation.create.0002')
    await db.exec(executableSql(`
      INSERT INTO app_viewer_interactions (account_id, profile_id, interaction_type, created_at)
      VALUES
        (2, 'pp_one', 'like', '2026-08-07T08:00:00.000Z'),
        (2, 'pp_one', 'follow', '2026-08-07T08:00:00.000Z');
    `))
    const blocked = await setAppProfileBlock(
      db,
      2,
      'pp_one',
      true,
      'safety.profile.block.0001',
      NOW,
    )
    expect(blocked.state).toMatchObject({ blocked: true, version: 1 })
    await expect(count('app_viewer_interactions')).resolves.toBe(0)
    const closed = await db.prepare(`SELECT status FROM app_conversations WHERE id = ?`)
      .bind(conversation.conversation.conversationId)
      .first<{ status: string }>()
    expect(closed?.status).toBe('closed')
    await expect(createConversation('pp_one', 'safety.conversation.create.blocked'))
      .rejects.toMatchObject({ code: 'CONVERSATION_FORBIDDEN', status: 403 })

    const unblocked = await setAppProfileBlock(
      db,
      2,
      'pp_one',
      false,
      'safety.profile.unblock.0001',
      NOW,
    )
    expect(unblocked.state).toMatchObject({ blocked: false, version: 2 })
    await expect(count('app_viewer_interactions')).resolves.toBe(0)
    const existing = await createConversation('pp_one', 'safety.conversation.existing.0001')
    expect(existing).toMatchObject({
      created: false,
      conversation: { conversationId: conversation.conversation.conversationId, status: 'closed' },
    })
  })

  it('正文读取要求有效领取，操作员容量和全局暂停均由服务端执行', async () => {
    const first = await createConversation('pp_one', 'safety.conversation.create.0003')
    const second = await createConversation('pp_two', 'safety.conversation.create.0004')
    await expect(listAdminAppConversationMessages(
      db,
      1,
      first.conversation.conversationId,
      parseAdminAppConversationMessageQuery({}),
      NOW,
    )).rejects.toMatchObject({ code: 'ASSIGNMENT_REQUIRED', status: 403 })

    await claimAdminAppConversation(
      db,
      1,
      first.conversation.conversationId,
      'safety.assignment.claim.0001',
      NOW,
    )
    await expect(claimAdminAppConversation(
      db,
      3,
      first.conversation.conversationId,
      'safety.assignment.claim.0002',
      NOW,
    )).rejects.toMatchObject({ code: 'ASSIGNMENT_TAKEN', status: 409 })

    await db.prepare(`
      UPDATE app_messaging_runtime_controls
      SET max_active_assignments_per_operator = 1
      WHERE scope = 'global'
    `).run()
    await expect(claimAdminAppConversation(
      db,
      1,
      second.conversation.conversationId,
      'safety.assignment.claim.0003',
      NOW,
    )).rejects.toMatchObject({ code: 'ASSIGNMENT_CAPACITY_REACHED', status: 429 })

    const control = await updateAdminMessagingRuntimeControl(
      db,
      1,
      'safety.runtime.update.0001',
      {
        expectedVersion: 1,
        newConversationsPaused: false,
        viewerSendsPaused: true,
        operatorSendsPaused: false,
        reasonCode: 'incident_read_only',
        userVisibleMessage: '平台话题暂时只读，请稍后再试。',
        maxOpenConversations: 100,
        maxActiveAssignmentsPerOperator: 1,
        assignmentLeaseMinutes: 30,
      },
      NOW,
    )
    expect(control.control).toMatchObject({ viewerSendsPaused: true, version: 2 })
    await expect(sendAppViewerMessage(
      db,
      2,
      first.conversation.conversationId,
      APP_MESSAGE_1_CATALOG_ID,
      'safety.viewer.message.paused',
      {
        clientMessageId: 'safety.viewer.client.paused',
        contentType: 'text',
        text: '暂停期间不应发送成功。',
      },
      NOW,
    )).rejects.toMatchObject({ code: 'MESSAGING_PAUSED', status: 503 })
  })
})

function createConversation(profileId: string, idempotencyKey: string) {
  return createAppConversation(
    db,
    2,
    'acc_safety_viewer',
    APP_MESSAGE_1_CATALOG_ID,
    APP_MESSAGING_DISCLOSURE_VERSION,
    idempotencyKey,
    { profileId, disclosureVersion: APP_MESSAGING_DISCLOSURE_VERSION },
    'https://api.test/api/v2/conversations',
    NOW,
  )
}

async function count(tableName: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first<{ count: number }>()
  return Number(row?.count ?? -1)
}

function migration(name: string) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
