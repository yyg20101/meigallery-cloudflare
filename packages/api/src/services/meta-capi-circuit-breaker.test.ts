import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import {
  closeMetaCapiIncident,
  createMetaIncidentTrigger,
  evaluateDatasetPixelMismatch,
  evaluateMetaCircuit,
  MetaCapiCircuitError,
  openMetaCapiIncident,
  readMetaCircuitSnapshot,
  runMetaCapiCircuitEvaluation,
} from './meta-capi-circuit-breaker'

const RELEASE_COMMIT = 'a'.repeat(40)
const PIXEL_ID = '1234567890'
const ACCESS_TOKEN = 'meta-circuit-test-token'
const DATA_KEY = Buffer.alloc(32, 7).toString('base64')
const CONNECTION_REVISION = '1'.repeat(32)

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000303' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  const schema = `
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL);
    CREATE TABLE ad_platform_connections (
      provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, mode TEXT NOT NULL,
      browser_enabled INTEGER NOT NULL, server_enabled INTEGER NOT NULL,
      destination_id TEXT NOT NULL, debug_enabled INTEGER NOT NULL,
      rollout_percentage INTEGER NOT NULL, credential_secret_name TEXT NOT NULL,
      revision TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY,
      conversion_action_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      duplicate_suppressed_at TEXT,
      created_at TEXT NOT NULL,
      provider TEXT GENERATED ALWAYS AS ('meta') VIRTUAL
    );
    CREATE TABLE meta_capi_incidents (
      id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      trigger_code TEXT NOT NULL,
      trigger_summary TEXT NOT NULL DEFAULT '',
      target_rollout_percentage INTEGER NOT NULL,
      effective_rollout_percentage INTEGER NOT NULL DEFAULT 0,
      evidence TEXT NOT NULL DEFAULT '{}',
      opened_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      closed_at TEXT,
      closed_by_user_id INTEGER,
      resolution TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_meta_capi_incident_open_trigger
      ON meta_capi_incidents(environment, trigger_code)
      WHERE status = 'open';
    CREATE TABLE meta_connection_verifications (
      environment TEXT PRIMARY KEY,
      pixel_id TEXT NOT NULL,
      token_fingerprint TEXT NOT NULL,
      graph_api_version TEXT NOT NULL,
      verified_event_name TEXT NOT NULL,
      verified_commit TEXT NOT NULL,
      dataset_quality_status TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      verified_by_user_id INTEGER,
      invalidated_at TEXT,
      invalidation_reason TEXT NOT NULL,
      revision TEXT
    );
    CREATE TABLE analytics_release_verifications (
      id TEXT PRIMARY KEY,
      commit_sha TEXT NOT NULL,
      environment TEXT NOT NULL,
      verification_type TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `
  for (const statement of unstable_splitSqlQuery(schema)) await db.prepare(statement).run()
}, 30_000)

beforeEach(async () => {
  await execSql(`
    DELETE FROM admin_audit_logs;
    DELETE FROM analytics_release_verifications;
    DELETE FROM meta_connection_verifications;
    DELETE FROM meta_capi_incidents;
    DELETE FROM analytics_conversion_deliveries;
    DELETE FROM ad_platform_connections;
    DELETE FROM users;
    INSERT INTO users (id, role) VALUES (1, 'owner'), (2, 'admin');
    INSERT INTO ad_platform_connections
      (provider, enabled, mode, browser_enabled, server_enabled, destination_id,
       debug_enabled, rollout_percentage, credential_secret_name, revision)
    VALUES ('meta', 1, 'production', 1, 1, '1234567890', 0, 50,
            'META_CAPI_ACCESS_TOKEN', '${CONNECTION_REVISION}');
  `)
})

afterAll(async () => {
  await miniflare.dispose()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Meta CAPI Circuit Breaker 阈值', () => {
  const base = {
    totalAttempts: 0,
    permanentFailures: 0,
    retryExhausted: 0,
    stalePending: 0,
    duplicateSuppressed: 0,
    duplicateDeliveryGroups: 0,
  }

  it('永久失败率要求至少 10 条，并使用整数 5% 边界', () => {
    expect(evaluateMetaCircuit({ ...base, totalAttempts: 9, permanentFailures: 9 }).criticalTriggers).toEqual([])
    expect(evaluateMetaCircuit({ ...base, totalAttempts: 10, permanentFailures: 1 }).criticalTriggers)
      .toEqual([expect.objectContaining({ code: 'permanent_failure_rate' })])
  })

  it.each([
    ['retry_exhausted', 'retryExhausted', 2, 3],
    ['stale_pending', 'stalePending', 4, 5],
    ['duplicate_delivery', 'duplicateDeliveryGroups', 0, 1],
  ] as const)('%s 在边界前不开、达到边界后打开', (code, key, before, at) => {
    expect(evaluateMetaCircuit({ ...base, [key]: before }).criticalTriggers).toEqual([])
    expect(evaluateMetaCircuit({ ...base, [key]: at }).criticalTriggers)
      .toEqual([expect.objectContaining({ code })])
  })

  it('duplicate_suppressed 样本至少 20 且达到 10% 时只 warning', () => {
    expect(evaluateMetaCircuit({ ...base, totalAttempts: 19, duplicateSuppressed: 19 }).warnings).toEqual([])
    const evaluated = evaluateMetaCircuit({ ...base, totalAttempts: 20, duplicateSuppressed: 2 })
    expect(evaluated.criticalTriggers).toEqual([])
    expect(evaluated.warnings).toEqual([
      expect.objectContaining({ code: 'duplicate_suppressed_rate', severity: 'warning' }),
    ])
  })

  it('Q5 contract 未完成时 dataset mismatch 边界显式 no-op', () => {
    expect(evaluateDatasetPixelMismatch()).toBeNull()
  })
})

describe('Meta CAPI incident 生命周期', () => {
  it('15 分钟 snapshot 只计明确终态，stale pending 额外使用 10 分钟边界', async () => {
    await execSql(`
      INSERT INTO analytics_conversion_deliveries VALUES
        ('d_sent', 'a1', 'server', 'sent', '', 1, datetime('now', '-1 minute'), NULL, datetime('now', '-2 minutes')),
        ('d_400', 'a2', 'server', 'failed', 'meta_http_400', 1, datetime('now', '-2 minutes'), NULL, datetime('now', '-3 minutes')),
        ('d_500', 'a3', 'server', 'failed', 'meta_http_500', 1, datetime('now', '-3 minutes'), NULL, datetime('now', '-4 minutes')),
        ('d_dlq', 'a4', 'server', 'failed', 'retry_exhausted', 5, datetime('now', '-4 minutes'), NULL, datetime('now', '-5 minutes')),
        ('d_stale', 'a5', 'server', 'pending', '', 0, NULL, NULL, datetime('now', '-11 minutes')),
        ('d_fresh', 'a6', 'server', 'pending', '', 0, NULL, NULL, datetime('now', '-9 minutes')),
        ('d_duplicate', 'a7', 'server', 'sent', '', 1, datetime('now', '-1 minute'), datetime('now', '-1 minute'), datetime('now', '-2 minutes')),
        ('d_old', 'a8', 'server', 'failed', 'meta_http_400', 1, datetime('now', '-16 minutes'), NULL, datetime('now', '-16 minutes'));
    `)

    await expect(readMetaCircuitSnapshot(db)).resolves.toEqual({
      totalAttempts: 5,
      permanentFailures: 1,
      retryExhausted: 1,
      stalePending: 1,
      duplicateSuppressed: 1,
      duplicateDeliveryGroups: 0,
    })
  })

  it('10 条 payload invalid 经 scheduled evaluation 仍不产生 critical incident', async () => {
    const values = Array.from({ length: 10 }, (_, index) => (
      `('payload_${index}', 'payload_action_${index}', 'server', 'failed', 'secure_context_payload_invalid', 1, datetime('now', '-1 minute'), NULL, datetime('now', '-2 minutes'))`
    )).join(',')
    await execSql(`INSERT INTO analytics_conversion_deliveries VALUES ${values};`)

    const evaluated = await runMetaCapiCircuitEvaluation(circuitEnv())

    expect(evaluated.snapshot).toMatchObject({ totalAttempts: 10, permanentFailures: 0 })
    expect(evaluated.criticalTriggers).toEqual([])
    expect(await incidentCount()).toBe(0)
  })

  it('旧 secure_context_invalid fail safe，不当作已确认认证失败', async () => {
    const values = Array.from({ length: 10 }, (_, index) => (
      `('legacy_${index}', 'legacy_action_${index}', 'server', 'failed', 'secure_context_invalid', 1, datetime('now', '-1 minute'), NULL, datetime('now', '-2 minutes'))`
    )).join(',')
    await execSql(`INSERT INTO analytics_conversion_deliveries VALUES ${values};`)

    const evaluated = await runMetaCapiCircuitEvaluation(circuitEnv())

    expect(evaluated.snapshot).toMatchObject({ totalAttempts: 10, permanentFailures: 0 })
    expect(evaluated.criticalTriggers).toEqual([])
    expect(await incidentCount()).toBe(0)
  })

  it('已确认 authentication failure 进入 scheduled 永久失败口径且分类准确', async () => {
    const values = Array.from({ length: 10 }, (_, index) => (
      `('auth_${index}', 'auth_action_${index}', 'server', '${index === 0 ? 'failed' : 'sent'}', '${index === 0 ? 'secure_context_authentication_failed' : ''}', 1, datetime('now', '-1 minute'), NULL, datetime('now', '-2 minutes'))`
    )).join(',')
    await execSql(`INSERT INTO analytics_conversion_deliveries VALUES ${values};`)

    const evaluated = await runMetaCapiCircuitEvaluation(circuitEnv())

    expect(evaluated.snapshot).toMatchObject({ totalAttempts: 10, permanentFailures: 1 })
    expect(evaluated.criticalTriggers).toEqual([
      expect.objectContaining({ code: 'permanent_failure_rate' }),
    ])
    await expect(db.prepare(`
      SELECT trigger_code FROM meta_capi_incidents WHERE status = 'open'
    `).first<{ trigger_code: string }>()).resolves.toEqual({ trigger_code: 'permanent_failure_rate' })
  })

  it('同 trigger 重复观察保留 opened_at，只更新观察时间、evidence 与 rollout 快照', async () => {
    const env = circuitEnv()
    const first = await openMetaCapiIncident(env, createMetaIncidentTrigger('meta_permission_denied'))
    const opened = await incident(first.id)
    await db.prepare("UPDATE ad_platform_connections SET rollout_percentage = 100 WHERE provider = 'meta'").run()
    const second = await openMetaCapiIncident(env, createMetaIncidentTrigger('meta_permission_denied', {
      failedCount: 2,
      errorCategory: 'permission_denied',
    }))
    const observed = await incident(first.id)

    expect(first.created).toBe(true)
    expect(second).toEqual({ id: first.id, created: false })
    expect(observed.opened_at).toBe(opened.opened_at)
    expect(observed.target_rollout_percentage).toBe(100)
    expect(observed.effective_rollout_percentage).toBe(0)
    expect(JSON.parse(observed.evidence)).toMatchObject({
      failedCount: 2,
      errorCategory: 'permission_denied',
      windowStart: expect.stringMatching(/Z$/),
      windowEnd: expect.stringMatching(/Z$/),
      observedAt: expect.stringMatching(/Z$/),
    })
    expect(await incidentCount()).toBe(1)
  })

  it('warning 保存当前 target/effective，且 evidence 拒绝外部原文和敏感标识', async () => {
    const warning = await openMetaCapiIncident(
      circuitEnv(),
      createMetaIncidentTrigger('duplicate_suppressed_rate', {
        duplicateCount: 2,
        duplicateRate: 0.1,
      }),
    )
    await expect(incident(warning.id)).resolves.toMatchObject({
      severity: 'warning',
      target_rollout_percentage: 50,
      effective_rollout_percentage: 50,
    })
    await expect(openMetaCapiIncident(circuitEnv(), {
      ...createMetaIncidentTrigger('meta_permission_denied'),
      evidence: { rawResponse: 'OAuth token owner@example.test' },
    })).rejects.toThrow(/evidence/i)
  })

  it.each(['pixelCount', 'userCount', 'payloadCount'])(
    'trigger 级 evidence allowlist 拒绝恶意后缀字段 %s',
    async field => {
      expect(() => createMetaIncidentTrigger('meta_permission_denied', {
        [field]: 1,
      })).toThrow(/evidence/i)
      await expect(openMetaCapiIncident(circuitEnv(), {
        ...createMetaIncidentTrigger('meta_permission_denied'),
        evidence: { [field]: 1 },
      })).rejects.toThrow(/evidence/i)
    },
  )

  it('乱序重复观察不得覆盖较新的 last_observed_at、evidence 或 rollout，opened_at 保持固定', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:05:00.000Z'))
    const first = await openMetaCapiIncident(
      circuitEnv(),
      createMetaIncidentTrigger('meta_permission_denied', { failedCount: 5 }),
    )
    const opened = await incident(first.id)
    await db.prepare("UPDATE ad_platform_connections SET rollout_percentage = 100 WHERE provider = 'meta'").run()

    vi.setSystemTime(new Date('2026-07-11T12:04:00.000Z'))
    await openMetaCapiIncident(
      circuitEnv(),
      createMetaIncidentTrigger('meta_permission_denied', { failedCount: 1 }),
    )
    const observed = await incident(first.id)

    expect(observed.opened_at).toBe(opened.opened_at)
    expect(observed.last_observed_at).toBe('2026-07-11T12:05:00.000Z')
    expect(observed.target_rollout_percentage).toBe(50)
    expect(JSON.parse(String(observed.evidence))).toMatchObject({
      failedCount: 5,
      observedAt: '2026-07-11T12:05:00.000Z',
    })
  })

  it.each([
    ['resolution_too_short', async () => ({ resolution: '太短' })],
    ['connection_unverified', async () => {
      await seedCloseEvidence()
      await db.prepare("UPDATE meta_connection_verifications SET invalidated_at = datetime('now'), invalidation_reason = 'access_token_changed'").run()
      return {}
    }],
    ['test_event_after_incident_missing', async () => {
      await seedCloseEvidence({ verificationTime: '2000-01-01T00:00:00.000Z' })
      return {}
    }],
    ['critical_trigger_present', async () => {
      await seedCloseEvidence()
      await seedCriticalFailures()
      return {}
    }],
    ['data_key_unavailable', async () => {
      await seedCloseEvidence()
      return { env: { META_CAPI_DATA_KEY_CURRENT: 'invalid' } }
    }],
    ['queue_binding_missing', async () => {
      await seedCloseEvidence()
      return { env: { META_CAPI_QUEUE: undefined } }
    }],
    ['meta_resources_verification_missing', async () => {
      await seedCloseEvidence({ resources: false })
      return {}
    }],
  ])('关闭门禁失败返回稳定 blocker %s，incident 保持 open', async (blocker, arrange) => {
    const incidentId = await seedOpenIncident()
    const arranged = await arrange() as { resolution?: string; env?: Partial<Bindings> }
    if (blocker === 'resolution_too_short') await seedCloseEvidence()

    const error = await closeMetaCapiIncident({ ...circuitEnv(), ...arranged.env }, {
      incidentId,
      ownerUserId: 1,
      resolution: arranged.resolution ?? '已完成连接复验、资源检查并确认投递窗口恢复正常。',
    }).catch(value => value as MetaCapiCircuitError)

    expect(error).toBeInstanceOf(MetaCapiCircuitError)
    expect(error).toMatchObject({
      code: 'META_CAPI_INCIDENT_CLOSE_BLOCKED',
      httpStatus: 409,
      blockers: expect.arrayContaining([blocker]),
    })
    expect((await incident(incidentId)).status).toBe('open')
  })

  it('非 Owner 返回 403，且不泄漏 incident 门禁状态', async () => {
    const incidentId = await seedOpenIncident()
    const error = await closeMetaCapiIncident(circuitEnv(), {
      incidentId,
      ownerUserId: 2,
      resolution: '已完成连接复验、资源检查并确认投递窗口恢复正常。',
    }).catch(value => value as MetaCapiCircuitError)

    expect(error).toMatchObject({ code: 'OWNER_REQUIRED', httpStatus: 403, blockers: [] })
  })

  it('成功关闭以同一 batch 原子 CAS + audit，并发 loser 返回 409 且只有一条审计', async () => {
    const incidentId = await seedOpenIncident()
    await seedCloseEvidence()
    const input = {
      incidentId,
      ownerUserId: 1,
      resolution: '已完成连接复验、资源检查并确认投递窗口恢复正常。',
    }

    const settled = await Promise.allSettled([
      closeMetaCapiIncident(circuitEnv(), input),
      closeMetaCapiIncident(circuitEnv(), input),
    ])

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'META_CAPI_INCIDENT_CLOSE_CONFLICT', httpStatus: 409 })
    const closed = await incident(incidentId)
    expect(closed).toMatchObject({ status: 'closed', closed_by_user_id: 1, resolution: input.resolution })
    const audits = await db.prepare("SELECT action, target_id, after_value FROM admin_audit_logs").all<{
      action: string
      target_id: string
      after_value: string
    }>()
    expect(audits.results).toHaveLength(1)
    expect(audits.results[0]).toMatchObject({ action: 'attribution.meta_incident_close', target_id: incidentId })
    expect(audits.results[0]!.after_value).not.toContain('evidence')
    expect(audits.results[0]!.after_value).not.toContain(ACCESS_TOKEN)
  })
})

function circuitEnv(overrides: Partial<Bindings> = {}) {
  return {
    DB: db,
    APP_ENV: 'dev',
    META_CAPI_ACCESS_TOKEN: ACCESS_TOKEN,
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_QUEUE: { send: async () => undefined },
    RELEASE_COMMIT,
    ...overrides,
  } as unknown as Bindings
}

async function seedOpenIncident() {
  const result = await openMetaCapiIncident(
    circuitEnv(),
    createMetaIncidentTrigger('connection_fingerprint_changed'),
  )
  await db.prepare(`
    UPDATE meta_capi_incidents
    SET opened_at = '2026-07-10T00:00:00.000Z',
        last_observed_at = '2026-07-10T00:00:00.000Z'
    WHERE id = ?
  `).bind(result.id).run()
  return result.id
}

async function seedCloseEvidence(options: { verificationTime?: string; resources?: boolean } = {}) {
  const fingerprint = await metaConnectionFingerprint(PIXEL_ID, ACCESS_TOKEN)
  await db.prepare(`
    INSERT OR REPLACE INTO meta_connection_verifications (
      environment, pixel_id, token_fingerprint, graph_api_version,
      verified_event_name, verified_commit, dataset_quality_status, verified_at,
      verified_by_user_id, invalidated_at, invalidation_reason, revision
    ) VALUES ('dev', ?, ?, 'v25.0', 'Contact', ?, 'not_checked', ?, 1, NULL, '', ?)
  `).bind(
    PIXEL_ID,
    fingerprint,
    RELEASE_COMMIT,
    options.verificationTime ?? '2026-07-10T00:01:00.000Z',
    CONNECTION_REVISION,
  ).run()
  if (options.resources !== false) {
    await db.prepare(`
      INSERT INTO analytics_release_verifications (
        id, commit_sha, environment, verification_type, status,
        summary, verified_at, expires_at, created_at
      ) VALUES ('resources_1', ?, 'dev', 'meta_resources', 'passed', '{}',
        '2026-07-10T00:02:00.000Z', '2099-01-01T00:00:00.000Z', '2026-07-10T00:02:00.000Z')
    `).bind(RELEASE_COMMIT).run()
  }
}

async function seedCriticalFailures() {
  const values = Array.from({ length: 10 }, (_, index) => (
    `('critical_${index}', 'critical_action_${index}', 'server', '${index === 0 ? 'failed' : 'sent'}', '${index === 0 ? 'meta_http_400' : ''}', 1, datetime('now', '-1 minute'), NULL, datetime('now', '-2 minutes'))`
  )).join(',')
  await execSql(`INSERT INTO analytics_conversion_deliveries VALUES ${values};`)
}

async function incident(id: string) {
  const row = await db.prepare('SELECT * FROM meta_capi_incidents WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!row) throw new Error('incident 不存在')
  return row
}

async function incidentCount() {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM meta_capi_incidents').first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function execSql(sql: string) {
  for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run()
}
