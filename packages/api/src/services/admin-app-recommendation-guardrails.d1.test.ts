import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  assertRecommendationGuardrailForActivation,
  createAdminRecommendationGuardrailPolicy,
  decideAdminRecommendationGuardrailPolicy,
  evaluateAdminRecommendationGuardrail,
  submitAdminRecommendationGuardrailPolicy,
} from './admin-app-recommendation-guardrails'
import { listCompatibleRecommendationRules } from './app-recommendation-policy'

const RECOMMENDATION_MIGRATION = readFileSync(
  new URL('../../migrations/0083_app_recommendation_rules_and_editorial.sql', import.meta.url),
  'utf8',
)
const GUARDRAIL_MIGRATION = readFileSync(
  new URL('../../migrations/0113_app_recommendation_guardrails.sql', import.meta.url),
  'utf8',
)
const NOW = new Date('2026-08-20T08:00:00.000Z')
const ADMIN = { adminId: 10, role: 'admin', requestId: 'req_guardrail_admin' }
const OWNER = { adminId: 11, role: 'owner', requestId: 'req_guardrail_owner' }

let miniflare: Miniflare
let db: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-12',
    d1Databases: { DB: `recommendation-guardrail-${crypto.randomUUID()}` },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(executableSql(BASE_SCHEMA))
  await db.exec(executableSql(RECOMMENDATION_MIGRATION))
  await db.exec(executableSql(GUARDRAIL_MIGRATION))
}, 30_000)

afterEach(async () => {
  await miniflare.dispose()
}, 30_000)

describe('Recommendation-5 灰度守护 D1', () => {
  it('默认关闭时阻止部分灰度启用，即使策略已完成独立复核', async () => {
    const policy = await createApprovedPolicy('guardrail-default-off-01')

    await expect(assertRecommendationGuardrailForActivation(db, {
      rule_version_id: 'rrv_guardrail_candidate',
      rollout_percent: 20,
      guardrail_policy_id: policy.policyId,
    }, false)).rejects.toMatchObject({ code: 'RECOMMENDATION_GUARDRAIL_DISABLED' })
  })

  it('命中停止反指标后冻结不可变阻断，并让运行时选择登记回退', async () => {
    const policy = await createApprovedPolicy('guardrail-stop-0001')
    await enableGuardrailControl()
    await seedRules(policy.policyId, 'rrv_guardrail_target', 'rrv_guardrail_fallback')

    const first = await evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_target',
      evaluationInput('aggregate:recommendation:stop:0001', {
        includeReasonCoverage: true,
        reportNumerator: 2,
      }),
      'guardrail-evaluate-stop-0001',
      OWNER,
      false,
      NOW,
    )

    expect(first).toMatchObject({
      replayed: false,
      evaluation: {
        status: 'breached',
        blockingReasonCode: 'guardrail_report_rate_ppm',
        block: {
          rollbackRuleVersionId: 'rrv_guardrail_fallback',
          deliveryBehavior: 'exclude_rule_and_use_registered_fallback',
        },
      },
    })
    const selected = await listCompatibleRecommendationRules(
      db,
      'non_personalized',
      '1.25.0',
      null,
      null,
      false,
      NOW,
    )
    expect(selected).toEqual([{ rule_version_id: 'rrv_guardrail_fallback' }])
    await expect(count('app_recommendation_guardrail_blocks')).resolves.toBe(1)
    await expect(assertRecommendationGuardrailForActivation(db, {
      rule_version_id: 'rrv_guardrail_target',
      rollout_percent: 100,
      guardrail_policy_id: policy.policyId,
    }, false)).rejects.toMatchObject({ code: 'RECOMMENDATION_GUARDRAIL_RULE_BLOCKED' })

    const replay = await evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_target',
      evaluationInput('aggregate:recommendation:stop:0001', {
        includeReasonCoverage: true,
        reportNumerator: 2,
      }),
      'guardrail-evaluate-stop-0001',
      OWNER,
      false,
      NOW,
    )
    expect(replay.replayed).toBe(true)
    expect(replay.evaluation.evaluationId).toBe(first.evaluation.evaluationId)
    await expect(count('app_recommendation_guardrail_evaluations')).resolves.toBe(1)
  })

  it('批准来源缺少策略必需指标时立即停止，不把不完整数据解释为健康', async () => {
    const policy = await createApprovedPolicy('guardrail-missing-01')
    await enableGuardrailControl()
    await seedRules(policy.policyId, 'rrv_guardrail_missing', 'rrv_guardrail_fallback_missing')

    const result = await evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_missing',
      evaluationInput('aggregate:recommendation:missing:01', {
        includeReasonCoverage: false,
        reportNumerator: 0,
      }),
      'guardrail-evaluate-missing-01',
      OWNER,
      false,
      NOW,
    )

    expect(result.evaluation).toMatchObject({
      status: 'source_incomplete',
      blockingReasonCode: 'guardrail_source_incomplete',
      block: { rollbackRuleVersionId: 'rrv_guardrail_fallback_missing' },
    })
    expect(result.evaluation.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'reason_coverage_rate_ppm', outcome: 'unavailable' }),
    ]))
  })

  it('样本不足时保持观察，即使当前停止指标越线也不提前阻断', async () => {
    const policy = await createApprovedPolicy('guardrail-observing-1')
    await enableGuardrailControl()
    await seedRules(policy.policyId, 'rrv_guardrail_observing', 'rrv_guardrail_fallback_observing')

    const result = await evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_observing',
      {
        ...evaluationInput('aggregate:recommendation:observing:01', {
          includeReasonCoverage: true,
          reportNumerator: 2,
        }),
        sampleSize: 99,
      },
      'guardrail-observing-key-01',
      OWNER,
      false,
      NOW,
    )

    expect(result.evaluation).toMatchObject({ status: 'observing', block: null })
    await expect(count('app_recommendation_guardrail_blocks')).resolves.toBe(0)
  })

  it('拒绝把账号或会话命名空间伪装成聚合快照引用', async () => {
    const policy = await createApprovedPolicy('guardrail-private-ref')
    await enableGuardrailControl()
    await seedRules(policy.policyId, 'rrv_guardrail_private_ref', 'rrv_guardrail_fallback_private_ref')

    await expect(evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_private_ref',
      evaluationInput('aggregate:recommendation:account:12345678', {
        includeReasonCoverage: true,
        reportNumerator: 0,
      }),
      'guardrail-private-ref-key',
      OWNER,
      false,
      NOW,
    )).rejects.toMatchObject({ code: 'RECOMMENDATION_GUARDRAIL_SNAPSHOT_REF_INVALID' })
  })

  it('同一来源引用改写摘要时拒绝，不产生第二份评估', async () => {
    const policy = await createApprovedPolicy('guardrail-conflict-1')
    await enableGuardrailControl()
    await seedRules(policy.policyId, 'rrv_guardrail_conflict', 'rrv_guardrail_fallback_conflict')
    const original = evaluationInput('aggregate:recommendation:conflict:01', {
      includeReasonCoverage: true,
      reportNumerator: 0,
    })
    await evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_conflict',
      original,
      'guardrail-conflict-key-0001',
      OWNER,
      false,
      NOW,
    )

    await expect(evaluateAdminRecommendationGuardrail(
      db,
      'rrv_guardrail_conflict',
      { ...original, sourceSnapshotSha256: 'b'.repeat(64) },
      'guardrail-conflict-key-0002',
      OWNER,
      false,
      NOW,
    )).rejects.toMatchObject({ code: 'RECOMMENDATION_GUARDRAIL_SNAPSHOT_CONFLICT' })
    await expect(count('app_recommendation_guardrail_evaluations')).resolves.toBe(1)
  })
})

async function createApprovedPolicy(idempotencyKey: string) {
  const created = await createAdminRecommendationGuardrailPolicy(db, {
    name: 'App 1.0 推荐灰度守护',
    description: '仅使用批准聚合来源；阈值为合成测试数据。',
    observationWindowMinutes: 60,
    minimumSampleSize: 100,
    minimumObservationCount: 1,
    consecutiveBreachCount: 1,
    metrics: [
      { code: 'reason_coverage_rate_ppm', threshold: 800_000 },
      { code: 'report_rate_ppm', threshold: 10_000, severity: 'stop' },
    ],
    productionReady: false,
  }, idempotencyKey.padEnd(16, '0'), ADMIN, NOW)
  const submitted = await submitAdminRecommendationGuardrailPolicy(db, created.policy.policyId, {
    expectedVersion: created.policy.version,
    reason: '提交另一位 Owner 复核',
  }, ADMIN, NOW)
  return decideAdminRecommendationGuardrailPolicy(db, created.policy.policyId, {
    expectedVersion: submitted.version,
    decision: 'approve',
    reason: '合成测试策略通过独立复核',
  }, OWNER, NOW)
}

async function enableGuardrailControl() {
  await db.prepare(`
    UPDATE app_recommendation_guardrail_controls
    SET evaluation_enabled = 1,
        source_decision_status = 'approved',
        retention_decision_status = 'approved',
        retention_days = 30,
        purge_enabled = 1,
        updated_at = ?
    WHERE control_id = 'recommendation_guardrails'
  `).bind(NOW.toISOString()).run()
}

async function seedRules(policyId: string, targetId: string, fallbackId: string) {
  const common = {
    weights: '{"quality":70,"heat":0,"freshness":30,"region":0,"preferredTaxonomy":0}',
    reasons: '{"editorial":"PLATFORM_SELECTED","region":"REGION_RELEVANT","popular":"RECENTLY_POPULAR","fresh":"RECENTLY_PUBLISHED","default":"DISCOVERY_NEUTRAL"}',
  }
  await db.prepare(`
    INSERT INTO app_recommendation_rule_versions (
      rule_version_id, rule_set_id, version_number, state, entry_point, mode,
      name, description, taxonomy_catalog_id, heat_version_id, weights_json,
      reason_map_json, target_region_codes_json, target_channels_json,
      max_consecutive_same_region, max_consecutive_same_term, repeat_exposure_cap,
      rollout_percent, minimum_client_version, effective_at, expires_at,
      rollback_rule_version_id, production_ready, last_dry_run_json, last_dry_run_at,
      lock_version, mutation_token, created_by, updated_by, reviewed_by, activated_by,
      created_at, updated_at, reviewed_at, activated_at, paused_at, guardrail_policy_id
    ) VALUES (
      ?, ?, 1, 'paused', 'discovery_home', 'non_personalized',
      '安全回退', NULL, NULL, NULL, ?, ?, '[]', '["app"]',
      3, 3, 3, 100, '1.0', NULL, NULL, NULL, 0,
      '{"candidateCount":10,"emptyResultRisk":false}', ?, 1, NULL,
      10, 10, 11, 11, ?, ?, ?, ?, ?, NULL
    )
  `).bind(
    fallbackId,
    `rrs_${fallbackId}`,
    common.weights,
    common.reasons,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
  ).run()
  await db.prepare(`
    INSERT INTO app_recommendation_rule_versions (
      rule_version_id, rule_set_id, version_number, state, entry_point, mode,
      name, description, taxonomy_catalog_id, heat_version_id, weights_json,
      reason_map_json, target_region_codes_json, target_channels_json,
      max_consecutive_same_region, max_consecutive_same_term, repeat_exposure_cap,
      rollout_percent, minimum_client_version, effective_at, expires_at,
      rollback_rule_version_id, production_ready, last_dry_run_json, last_dry_run_at,
      lock_version, mutation_token, created_by, updated_by, reviewed_by, activated_by,
      created_at, updated_at, reviewed_at, activated_at, paused_at, guardrail_policy_id
    ) VALUES (
      ?, ?, 1, 'active', 'discovery_home', 'non_personalized',
      '灰度目标', NULL, NULL, NULL, ?, ?, '[]', '["app"]',
      3, 3, 3, 20, '1.0', NULL, NULL, ?, 0,
      '{"candidateCount":10,"emptyResultRisk":false}', ?, 1, NULL,
      10, 10, 11, 11, ?, ?, ?, ?, NULL, ?
    )
  `).bind(
    targetId,
    `rrs_${targetId}`,
    common.weights,
    common.reasons,
    fallbackId,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    policyId,
  ).run()
}

function evaluationInput(
  sourceSnapshotRef: string,
  options: { includeReasonCoverage: boolean; reportNumerator: number },
) {
  const metrics: Array<Record<string, unknown>> = [
    { code: 'report_rate_ppm', numerator: options.reportNumerator, denominator: 100 },
  ]
  if (options.includeReasonCoverage) {
    metrics.push({ code: 'reason_coverage_rate_ppm', numerator: 90, denominator: 100 })
  }
  return {
    expectedRuleVersion: 1,
    sourceSnapshotRef,
    sourceSnapshotSha256: 'a'.repeat(64),
    windowStart: '2026-08-20T06:30:00.000Z',
    windowEnd: '2026-08-20T07:30:00.000Z',
    capturedAt: '2026-08-20T07:45:00.000Z',
    sampleSize: 100,
    metrics,
  }
}

async function count(table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
  return Number(row?.count ?? 0)
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

CREATE TABLE app_taxonomy_catalogs (
  catalog_id TEXT PRIMARY KEY
);

CREATE TABLE person_profiles (
  id TEXT PRIMARY KEY
);

CREATE TABLE profile_public_projections (
  profile_id TEXT PRIMARY KEY
);

INSERT INTO users (id, role, status) VALUES
  (10, 'admin', 'active'),
  (11, 'owner', 'active'),
  (12, 'owner', 'active');
`
