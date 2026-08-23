import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'

const MIGRATION = readFileSync(
  new URL('../../migrations/0110_app_data_export_failure_notifications.sql', import.meta.url),
  'utf8',
)
const POLICY_ID = 'ntp_app_1_0_message_3_dev_1'
const NOW = '2026-08-20T08:00:00.000Z'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: 'app-data-rights-notifications' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(`
    CREATE TABLE app_notification_policies (
      id TEXT PRIMARY KEY,
      generation_enabled INTEGER NOT NULL
    );
    CREATE TABLE app_notification_event_definitions (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL,
      necessity TEXT NOT NULL,
      preference_key TEXT,
      source_domain TEXT NOT NULL,
      target_type TEXT NOT NULL,
      action TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      privacy_level TEXT NOT NULL,
      minimum_client_version TEXT NOT NULL,
      template_variable_catalog_json TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE app_notification_template_versions (
      id TEXT PRIMARY KEY,
      event_definition_id TEXT NOT NULL,
      version_code TEXT NOT NULL,
      state TEXT NOT NULL,
      locale TEXT NOT NULL,
      region_scope TEXT NOT NULL,
      variable_allowlist_json TEXT NOT NULL,
      title_text TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      body_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE app_notification_outbox (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      event_definition_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_ref TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (account_id, event_type, event_ref)
    );
    CREATE TABLE app_data_rights_requests (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      request_type TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      failure_code TEXT
    );
    CREATE TABLE app_data_rights_export_artifacts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      request_version INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      failure_code TEXT
    );
    CREATE TABLE app_data_rights_request_events (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      request_version INTEGER NOT NULL,
      status_snapshot TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      visibility TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO app_notification_policies (id, generation_enabled)
    VALUES ('ntp_app_1_0_message_3_dev_1', 0);
  `))
  await db.exec(executableSql(MIGRATION))
})

beforeEach(async () => {
  await db.exec(executableSql(`
    DELETE FROM app_notification_outbox;
    DELETE FROM app_data_rights_request_events;
    DELETE FROM app_data_rights_export_artifacts;
    DELETE FROM app_data_rights_requests;
    UPDATE app_notification_policies SET generation_enabled = 0;
  `))
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('Message-7 数据导出失败通知 D1', () => {
  it('策略关闭时保留失败事实但不生成 Outbox', async () => {
    await insertFailedExport('req_disabled', 'dre_disabled')
    await expect(countOutbox()).resolves.toBe(0)
  })

  it('只为已与失败制品收敛的系统用户可见事件生成必要通知', async () => {
    await db.prepare('UPDATE app_notification_policies SET generation_enabled = 1 WHERE id = ?')
      .bind(POLICY_ID)
      .run()
    await insertFailedExport('req_ready', 'dre_ready')

    const outbox = await db.prepare(`
      SELECT account_id, event_type, event_ref, target_type, target_id, status, attempts
      FROM app_notification_outbox
      WHERE id = 'nto_drf_dre_ready'
    `).first<Record<string, string | number>>()
    expect(outbox).toEqual(expect.objectContaining({
      account_id: 1,
      event_type: 'data.export_failed',
      event_ref: 'dre_ready',
      target_type: 'data_task',
      target_id: 'req_ready',
      status: 'pending',
      attempts: 0,
    }))
  })

  it('版本、制品或事件来源不一致时 fail closed', async () => {
    await db.prepare('UPDATE app_notification_policies SET generation_enabled = 1 WHERE id = ?')
      .bind(POLICY_ID)
      .run()
    await insertFailedExport('req_bad_version', 'dre_bad_version', { eventVersion: 4 })
    await insertFailedExport('req_bad_artifact', 'dre_bad_artifact', { artifactStatus: 'collecting' })
    await insertFailedExport('req_bad_actor', 'dre_bad_actor', { actorType: 'admin' })
    await insertFailedExport('req_internal', 'dre_internal', { visibility: 'internal' })
    await insertFailedExport('req_bad_reason', 'dre_bad_reason', { reasonCode: 'other_failure' })
    await expect(countOutbox()).resolves.toBe(0)
  })
})

async function insertFailedExport(
  requestId: string,
  eventId: string,
  overrides: {
    eventVersion?: number
    artifactStatus?: string
    actorType?: string
    visibility?: string
    reasonCode?: string
  } = {},
) {
  await db.prepare(`
    INSERT INTO app_data_rights_requests (
      id, account_id, request_type, status, version, failure_code
    ) VALUES (?, 1, 'export', 'failed', 3, 'r2_archive_failed')
  `).bind(requestId).run()
  await db.prepare(`
    INSERT INTO app_data_rights_export_artifacts (
      id, request_id, request_version, account_id, status, failure_code
    ) VALUES (?, ?, 2, 1, ?, 'r2_archive_failed')
  `).bind(`drea_${eventId}`, requestId, overrides.artifactStatus ?? 'failed').run()
  await db.prepare(`
    INSERT INTO app_data_rights_request_events (
      id, request_id, request_version, status_snapshot, event_type,
      reason_code, visibility, actor_type, created_at
    ) VALUES (?, ?, ?, 'failed', 'processing_failed', ?, ?, ?, ?)
  `).bind(
    eventId,
    requestId,
    overrides.eventVersion ?? 3,
    overrides.reasonCode ?? 'private_export_generation_failed',
    overrides.visibility ?? 'user',
    overrides.actorType ?? 'system',
    NOW,
  ).run()
}

async function countOutbox() {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM app_notification_outbox')
    .first<{ count: number }>()
  return Number(row?.count ?? -1)
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}
