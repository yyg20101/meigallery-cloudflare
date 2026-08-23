import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  countAppRecommendationEvidenceForAccount,
  isRecommendationEvidenceSigningSecretReady,
  purgeAppRecommendationEvidenceForAccount,
  purgeExpiredAppRecommendationEvidence,
  recommendationAccountHash,
} from './app-recommendation-evidence'
import type { AppRecommendationRuntimeConfig } from './app-recommendation-policy'

const RECOMMENDATION_MIGRATION = readFileSync(
  new URL('../../migrations/0083_app_recommendation_rules_and_editorial.sql', import.meta.url),
  'utf8',
)
const EVIDENCE_LIFECYCLE_MIGRATION = readFileSync(
  new URL('../../migrations/0114_app_recommendation_evidence_lifecycle.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-20T08:00:00.000Z')
const SIGNING_SECRET = 'recommendation-evidence-test-secret'
const ACCOUNT_ID = 'acc_recommendation_evidence_owner'

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `recommendation-evidence-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(BASE_SCHEMA))
  await db.exec(executableSql(RECOMMENDATION_MIGRATION))
  await db.exec(executableSql(EVIDENCE_LIFECYCLE_MIGRATION))
})

afterEach(async () => {
  await miniflare.dispose()
})

describe('Recommendation-6 解释证据生命周期', () => {
  it('账号摘要只接受可用于 HMAC 的稳定服务端密钥', async () => {
    expect(isRecommendationEvidenceSigningSecretReady('short-secret')).toBe(false)
    expect(isRecommendationEvidenceSigningSecretReady(SIGNING_SECRET)).toBe(true)
    await expect(recommendationAccountHash('short-secret', ACCOUNT_ID))
      .rejects.toThrow('RECOMMENDATION_EVIDENCE_SIGNING_SECRET_INVALID')
  })

  it('保留决策未批准时跳过清理，不把代码存在解释为删除授权', async () => {
    await seedSession('1', '2026-08-20T07:00:00.000Z', null)

    await expect(purgeExpiredAppRecommendationEvidence(
      db,
      runtimeConfig(),
      NOW,
    )).resolves.toEqual({
      skipped: true,
      reason: 'retention_not_ready',
      deletedSessionCount: 0,
      hasMore: false,
    })
    await expect(countSessions()).resolves.toBe(1)
  })

  it('只按到期时间有限删除，级联清理条目并保留未到期会话', async () => {
    await enableEvidencePurge()
    await seedSession('1', '2026-08-20T06:00:00.000Z', null)
    await seedSession('2', '2026-08-20T07:00:00.000Z', null)
    await seedSession('3', '2026-08-21T08:00:00.000Z', null)

    const first = await purgeExpiredAppRecommendationEvidence(db, runtimeConfig(), NOW, 1)
    expect(first).toEqual({
      skipped: false,
      reason: null,
      deletedSessionCount: 1,
      hasMore: true,
    })
    await expect(countSessions()).resolves.toBe(2)
    await expect(countItems()).resolves.toBe(2)
    await expect(listSessionIds()).resolves.toEqual([sessionId('2'), sessionId('3')])

    const second = await purgeExpiredAppRecommendationEvidence(db, runtimeConfig(), NOW, 10)
    expect(second).toMatchObject({ deletedSessionCount: 1, hasMore: false })
    await expect(countSessions()).resolves.toBe(1)
    await expect(countItems()).resolves.toBe(1)
  })

  it('账号注销使用同一 HMAC 定位并删除未到期证据，不影响其他账号', async () => {
    const accountHash = await recommendationAccountHash(SIGNING_SECRET, ACCOUNT_ID)
    const otherHash = await recommendationAccountHash(SIGNING_SECRET, 'acc_recommendation_evidence_other')
    await seedSession('1', '2026-08-21T08:00:00.000Z', accountHash)
    await seedSession('2', '2026-08-22T08:00:00.000Z', accountHash)
    await seedSession('3', '2026-08-23T08:00:00.000Z', otherHash)

    await expect(countAppRecommendationEvidenceForAccount(
      db,
      SIGNING_SECRET,
      ACCOUNT_ID,
    )).resolves.toBe(4)
    await expect(purgeAppRecommendationEvidenceForAccount(
      db,
      SIGNING_SECRET,
      ACCOUNT_ID,
    )).resolves.toEqual({ deletedSessionCount: 2, deletedItemCount: 2 })
    await expect(countSessions()).resolves.toBe(1)
    await expect(countItems()).resolves.toBe(1)
  })

  it('冻结会话与条目内容，但仍允许到期或注销删除', async () => {
    await seedSession('1', '2026-08-20T07:00:00.000Z', null)
    await expect(db.prepare(`
      UPDATE app_recommendation_sessions
      SET context_hash = ?
      WHERE session_id = ?
    `).bind('f'.repeat(64), sessionId('1')).run()).rejects.toThrow()
    await expect(db.prepare(`
      UPDATE app_recommendation_session_items
      SET reason_code = 'RECENTLY_POPULAR'
      WHERE session_id = ? AND rank = 1
    `).bind(sessionId('1')).run()).rejects.toThrow()

    await enableEvidencePurge()
    await expect(purgeExpiredAppRecommendationEvidence(
      db,
      runtimeConfig(),
      NOW,
    )).resolves.toMatchObject({ deletedSessionCount: 1 })
  })

  it('拒绝无法进入确定到期序列的会话时间', async () => {
    await expect(db.prepare(`
      INSERT INTO app_recommendation_sessions (
        session_id, account_hash, mode, rule_version_id, heat_version_id,
        context_hash, created_at, expires_at
      ) VALUES (?, NULL, 'non_personalized', ?, NULL, ?, 'invalid', 'also-invalid')
    `).bind(
      sessionId('4'),
      'rrv_app_1_0_recommendation_1_dev_1',
      '4'.repeat(64),
    ).run()).rejects.toThrow()
  })
})

async function enableEvidencePurge() {
  await db.prepare(`
    UPDATE app_recommendation_policies
    SET evidence_retention_decision_status = 'approved',
        evidence_retention_days = 30,
        purge_enabled = 1
    WHERE policy_id = ?
  `).bind('rcp_app_1_0_recommendation_1_dev_1').run()
}

async function seedSession(suffix: string, expiresAt: string, accountHash: string | null) {
  const id = sessionId(suffix)
  await db.batch([
    db.prepare(`
      INSERT INTO app_recommendation_sessions (
        session_id, account_hash, mode, rule_version_id, heat_version_id,
        context_hash, created_at, expires_at
      ) VALUES (?, ?, 'non_personalized', ?, NULL, ?, ?, ?)
    `).bind(
      id,
      accountHash,
      'rrv_app_1_0_recommendation_1_dev_1',
      suffix.padStart(64, '0'),
      '2026-08-19T08:00:00.000Z',
      expiresAt,
    ),
    db.prepare(`
      INSERT INTO app_recommendation_session_items (
        session_id, rank, profile_id, reason_code, source, placement_id
      ) VALUES (?, 1, ?, 'DISCOVERY_NEUTRAL', 'rule', NULL)
    `).bind(id, `pp_evidence_${suffix}`),
  ])
}

function runtimeConfig(): AppRecommendationRuntimeConfig {
  return {
    enabled: false,
    adminEnabled: false,
    policyId: 'rcp_app_1_0_recommendation_1_dev_1',
    policyConfigured: true,
    requireProductionReady: false,
    cursorSigningSecret: SIGNING_SECRET,
  }
}

function sessionId(suffix: string) {
  return `rcs_${suffix.padStart(64, '0')}`
}

async function countSessions() {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM app_recommendation_sessions')
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function countItems() {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM app_recommendation_session_items')
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function listSessionIds() {
  const rows = await db.prepare(`
    SELECT session_id
    FROM app_recommendation_sessions
    ORDER BY expires_at ASC, session_id ASC
  `).all<{ session_id: string }>()
  return rows.results.map(row => row.session_id)
}

function executableSql(sql: string) {
  return sql
    .split(/\r?\n/u)
    .filter(line => !line.trimStart().startsWith('--'))
    .join(' ')
}

const BASE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE app_taxonomy_catalogs (
  catalog_id TEXT PRIMARY KEY
);

CREATE TABLE person_profiles (
  id TEXT PRIMARY KEY
);

CREATE TABLE profile_public_projections (
  profile_id TEXT PRIMARY KEY
);

INSERT INTO users (id, role, status) VALUES (11, 'owner', 'active');
`
