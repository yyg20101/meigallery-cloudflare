import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readConnectionAggregate } from '../repositories/connection-repository'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  closeServerCircuit,
  openServerCircuit,
  setRuntimePolicy,
  type RuntimePolicyCommandEnvironment,
  type RuntimePromotionHealth,
} from './runtime-policy-commands'

const MIGRATION = readFileSync(
  new URL('../../migrations/0001_attribution_runtime.sql', import.meta.url),
  'utf8',
)
const HEALTHY: RuntimePromotionHealth = {
  activeSnapshotReadable: true,
  credentialDecryptable: true,
  queueBound: true,
  adapterConstructable: true,
}

let miniflare: Miniflare
let db: D1Database
let idSequence = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'runtime-policy-commands' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  await seedActiveConnection()
  idSequence = 0
})

describe('独立运行策略命令', () => {
  it('调整 rollout 不改变 Active Version', async () => {
    const env = environment()
    const before = await readConnectionAggregate(db, 'conn_meta_team_a')

    await setRuntimePolicy(env, {
      connectionId: 'conn_meta_team_a',
      enabled: true,
      browserEnabled: true,
      serverEnabled: true,
      serverTargetPercentage: 50,
      idempotencyKey: 'policy-50',
      actorId: 1,
    })

    const after = await readConnectionAggregate(db, 'conn_meta_team_a')
    expect(after?.connection.activeVersionId)
      .toBe(before?.connection.activeVersionId)
    expect(after?.runtimePolicy.serverEffectivePercentage).toBe(50)
  })

  it('target 降低立即生效，重复值不推进策略或审计', async () => {
    const check = vi.fn().mockResolvedValue(HEALTHY)
    const env = environment(check)

    await setRuntimePolicy(env, policyInput(0, 'policy-0'))
    expect(check).not.toHaveBeenCalled()
    const generation = await runtimeGeneration()
    const auditCount = await auditCountValue()

    await setRuntimePolicy(env, policyInput(0, 'policy-0-repeat'))
    expect(await runtimeGeneration()).toBe(generation)
    expect(await auditCountValue()).toBe(auditCount)
  })

  it('target 提高健康失败时策略整体不变', async () => {
    const check = vi.fn().mockResolvedValue({
      ...HEALTHY,
      credentialDecryptable: false,
    })
    const env = environment(check)
    const before = await policyRow()

    await expect(setRuntimePolicy(env, policyInput(50, 'policy-blocked')))
      .rejects.toThrow('ATTRIBUTION_RUNTIME_PROMOTION_BLOCKED')

    expect(await policyRow()).toEqual(before)
    expect(await auditCountValue()).toBe(0)
  })

  it('并发重复调整只推进一次 generation，并返回同一回执', async () => {
    const env = environment()
    const input = policyInput(50, 'policy-concurrent')
    const results = await Promise.all([
      setRuntimePolicy(env, input),
      setRuntimePolicy(env, input),
    ])

    expect(results[1]).toEqual(results[0])
    expect(await runtimeGeneration()).toBe(2)
    expect(await auditCountValue()).toBe(1)
    expect(await receiptCountValue('policy-concurrent')).toBe(1)
  })

  it('策略 no-op 仍绑定幂等键，禁止随后改作其他请求', async () => {
    const env = environment()
    await setRuntimePolicy(env, policyInput(10, 'policy-noop-key'))

    await expect(setRuntimePolicy(
      env,
      policyInput(50, 'policy-noop-key'),
    )).rejects.toThrow('ATTRIBUTION_IDEMPOTENCY_CONFLICT')
    expect(await runtimeGeneration()).toBe(1)
    expect(await auditCountValue()).toBe(0)
    expect(await receiptCountValue('policy-noop-key')).toBe(1)
  })

  it('Server 熔断不修改 Browser 或 Active，恢复前重新检查健康', async () => {
    const healthyCheck = vi.fn().mockResolvedValue(HEALTHY)
    const env = environment(healthyCheck)
    const activeBefore = (await readConnectionAggregate(
      db,
      'conn_meta_team_a',
    ))?.connection.activeVersionId

    const opened = await openServerCircuit(env, {
      connectionId: 'conn_meta_team_a',
      idempotencyKey: 'circuit-open',
      actorId: 1,
    })
    expect(opened.circuitState).toBe('server_open')
    expect(opened.serverEffectivePercentage).toBe(0)
    expect(opened.browserEnabled).toBe(true)
    expect((await readConnectionAggregate(
      db,
      'conn_meta_team_a',
    ))?.connection.activeVersionId).toBe(activeBefore)

    const unhealthyEnv = environment(vi.fn().mockResolvedValue({
      ...HEALTHY,
      queueBound: false,
    }))
    await expect(closeServerCircuit(unhealthyEnv, {
      connectionId: 'conn_meta_team_a',
      idempotencyKey: 'circuit-close-blocked',
      actorId: 1,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_PROMOTION_BLOCKED')
    expect((await policyRow()).circuit_state).toBe('server_open')

    const closed = await closeServerCircuit(env, {
      connectionId: 'conn_meta_team_a',
      idempotencyKey: 'circuit-close',
      actorId: 1,
    })
    expect(closed.circuitState).toBe('closed')
    expect(closed.serverEffectivePercentage).toBe(10)
    expect(closed.browserEnabled).toBe(true)
  })
})

function environment(
  check = vi.fn().mockResolvedValue(HEALTHY),
): RuntimePolicyCommandEnvironment {
  return {
    db,
    health: { check },
    now: () => new Date('2026-07-24T00:00:00.000Z'),
    idFactory: prefix => `${prefix}_${++idSequence}`,
  }
}

function policyInput(
  percentage: 0 | 10 | 50 | 100,
  idempotencyKey: string,
) {
  return {
    connectionId: 'conn_meta_team_a',
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    serverTargetPercentage: percentage,
    idempotencyKey,
    actorId: 1,
  } as const
}

async function seedActiveConnection() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, is_default, active_version_id
      ) VALUES (
        'conn_meta_team_a', 'meta', 'team-a', 1, 'ver_meta_active'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_meta_active', 'conn_meta_team_a', 'meta', 'active',
        '{"pixelId":"123"}', 'hash_active', 1,
        '2026-07-24T00:00:00.000Z'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_version_credentials (
        version_id, provider, schema_version, key_id, iv, ciphertext,
        tag, credential_fingerprint
      ) VALUES (
        'ver_meta_active', 'meta', 1, 'key', 'iv', 'ciphertext',
        'tag', 'fingerprint'
      )
    `),
    ...(['Contact', 'CompleteRegistration'] as const).map(event =>
      db.prepare(`
        INSERT INTO attribution_version_bindings (
          version_id, canonical_event, enabled,
          browser_destination, server_destination
        ) VALUES (
          'ver_meta_active', ?, 1, 'meta_pixel', 'meta_capi'
        )
      `).bind(event)),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, runtime_generation, updated_by
      ) VALUES (
        'conn_meta_team_a', 1, 1, 1, 10, 10, 'closed', 1, 1
      )
    `),
  ])
}

async function policyRow() {
  const row = await db.prepare(`
    SELECT *
    FROM attribution_runtime_policies
    WHERE connection_id = 'conn_meta_team_a'
  `).first<Record<string, unknown>>()
  if (!row) throw new Error('测试策略不存在')
  return row
}

async function runtimeGeneration() {
  return Number((await policyRow()).runtime_generation)
}

async function auditCountValue() {
  const row = await db.prepare(`
    SELECT COUNT(*) AS value
    FROM attribution_audit_logs
  `).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

async function receiptCountValue(idempotencyKey: string) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS value
    FROM attribution_command_receipts
    WHERE idempotency_key = ?
  `).bind(idempotencyKey).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
