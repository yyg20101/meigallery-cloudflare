import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import type { AppInteractionCollectionRuntimeConfig } from './app-interaction-collections'
import { purgeExpiredAppViewHistory } from './app-view-history'

const NOW = new Date('2026-08-20T08:00:00.000Z')
const POLICY_ID = 'icp_app_1_0_interaction_2_dev_1'

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `view-history-retention-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(SCHEMA))
  await db.prepare(`
    INSERT INTO app_interaction_collection_policies (
      id, history_retention_decision_status, purge_enabled
    ) VALUES (?, 'unresolved', 0)
  `).bind(POLICY_ID).run()
})

afterEach(async () => {
  await miniflare.dispose()
})

describe('Interaction-4 浏览历史生命周期', () => {
  it('没有显式策略 ID 时跳过，不把 development 默认 ID 当作授权', async () => {
    await seedHistory(1, 'pp_one', '2026-08-20T07:00:00.000Z')

    await expect(purgeExpiredAppViewHistory(db, runtimeConfig(false), NOW)).resolves.toEqual({
      skipped: true,
      reason: 'policy_not_configured',
      deletedCount: 0,
      hasMore: false,
    })
    await expect(listProfiles()).resolves.toEqual(['pp_one'])
  })

  it('保留决策或 purge 门禁未就绪时不删除', async () => {
    await seedHistory(1, 'pp_one', '2026-08-20T07:00:00.000Z')

    await expect(purgeExpiredAppViewHistory(db, runtimeConfig(), NOW)).resolves.toEqual({
      skipped: true,
      reason: 'retention_not_ready',
      deletedCount: 0,
      hasMore: false,
    })
    await expect(listProfiles()).resolves.toEqual(['pp_one'])
  })

  it('能力关闭后仍按稳定顺序有界删除到期行并保留未到期行', async () => {
    await enablePurge()
    await seedHistory(2, 'pp_second', '2026-08-20T07:00:00.000Z')
    await seedHistory(1, 'pp_first', '2026-08-20T07:00:00.000Z')
    await seedHistory(1, 'pp_future', '2026-08-21T08:00:00.000Z')

    await expect(purgeExpiredAppViewHistory(db, runtimeConfig(), NOW, 1)).resolves.toEqual({
      skipped: false,
      reason: null,
      deletedCount: 1,
      hasMore: true,
    })
    await expect(listProfiles()).resolves.toEqual(['pp_future', 'pp_second'])

    await expect(purgeExpiredAppViewHistory(db, runtimeConfig(), NOW, 10)).resolves.toEqual({
      skipped: false,
      reason: null,
      deletedCount: 1,
      hasMore: false,
    })
    await expect(listProfiles()).resolves.toEqual(['pp_future'])
  })

  it('拒绝非法调度时间，不扩大删除范围', async () => {
    await enablePurge()
    await seedHistory(1, 'pp_one', '2026-08-20T07:00:00.000Z')

    await expect(purgeExpiredAppViewHistory(
      db,
      runtimeConfig(),
      new Date('invalid'),
    )).rejects.toThrow('VIEW_HISTORY_PURGE_TIME_INVALID')
    await expect(listProfiles()).resolves.toEqual(['pp_one'])
  })
})

function runtimeConfig(policyConfigured = true): AppInteractionCollectionRuntimeConfig {
  return {
    enabled: false,
    policyId: POLICY_ID,
    policyConfigured,
    requireProductionReady: false,
  }
}

async function enablePurge() {
  await db.prepare(`
    UPDATE app_interaction_collection_policies
    SET history_retention_decision_status = 'approved', purge_enabled = 1
    WHERE id = ?
  `).bind(POLICY_ID).run()
}

async function seedHistory(accountId: number, profileId: string, expiresAt: string) {
  await db.prepare(`
    INSERT INTO app_profile_view_history (account_id, profile_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(accountId, profileId, expiresAt).run()
}

async function listProfiles() {
  const rows = await db.prepare(`
    SELECT profile_id
    FROM app_profile_view_history
    ORDER BY profile_id ASC
  `).all<{ profile_id: string }>()
  return rows.results.map(row => row.profile_id)
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}

const SCHEMA = `
  CREATE TABLE app_interaction_collection_policies (
    id TEXT PRIMARY KEY,
    history_retention_decision_status TEXT NOT NULL,
    purge_enabled INTEGER NOT NULL
  );

  CREATE TABLE app_profile_view_history (
    account_id INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (account_id, profile_id)
  );

  CREATE INDEX idx_app_profile_view_history_expiry
    ON app_profile_view_history (expires_at, account_id);
`
