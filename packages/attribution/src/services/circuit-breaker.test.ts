import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  openServerCircuitForFailure,
  recordServerSuccess,
  recordTransientFailure,
} from './circuit-breaker'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const start = new Date('2026-07-24T02:00:00.000Z')
let miniflare: Miniflare
let db: D1Database
let sequence = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'circuit-breaker' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const migration of MIGRATIONS) {
    await db.exec(migration.replace(/\s*\r?\n\s*/g, ' '))
  }
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  sequence = 0
  await seedConnection()
})

describe('Server 熔断', () => {
  it('连续五次瞬时错误只打开 Server 熔断', async () => {
    for (let index = 0; index < 4; index += 1) {
      const result = await recordTransientFailure(environment(index), {
        connectionId: 'conn_meta',
        provider: 'meta',
      })
      expect(result.opened).toBe(false)
    }

    expect(await runtimePolicy()).toMatchObject({
      enabled: 1,
      browser_enabled: 1,
      server_enabled: 1,
      server_target_percentage: 100,
      server_effective_percentage: 100,
      circuit_state: 'closed',
    })

    const fifth = await recordTransientFailure(environment(4), {
      connectionId: 'conn_meta',
      provider: 'meta',
    })
    expect(fifth).toEqual({
      consecutiveFailures: 5,
      opened: true,
    })
    expect(await runtimePolicy()).toMatchObject({
      enabled: 1,
      browser_enabled: 1,
      server_enabled: 1,
      server_target_percentage: 100,
      server_effective_percentage: 0,
      circuit_state: 'server_open',
    })
    expect(await incidentCount()).toBe(1)

    await recordTransientFailure(environment(5), {
      connectionId: 'conn_meta',
      provider: 'meta',
    })
    expect(await incidentCount()).toBe(1)
  })

  it('成功投递会重置连续失败计数', async () => {
    for (let index = 0; index < 4; index += 1) {
      await recordTransientFailure(environment(index), {
        connectionId: 'conn_meta',
        provider: 'meta',
      })
    }
    await recordServerSuccess(environment(4), {
      connectionId: 'conn_meta',
      provider: 'meta',
    })
    const result = await recordTransientFailure(environment(5), {
      connectionId: 'conn_meta',
      provider: 'meta',
    })

    expect(result).toEqual({
      consecutiveFailures: 1,
      opened: false,
    })
    expect((await runtimePolicy()).circuit_state).toBe('closed')
  })

  it('确定性凭证错误立即打开 Server 熔断且幂等记录 Incident', async () => {
    await openServerCircuitForFailure(environment(0), {
      connectionId: 'conn_meta',
      provider: 'meta',
      code: 'provider_credential_invalid',
    })
    await openServerCircuitForFailure(environment(1), {
      connectionId: 'conn_meta',
      provider: 'meta',
      code: 'provider_credential_invalid',
    })

    expect((await runtimePolicy()).circuit_state).toBe('server_open')
    expect(await incidentCount()).toBe(1)
  })
})

function environment(offsetMinutes: number) {
  return {
    db,
    now: () => new Date(start.getTime() + offsetMinutes * 60_000),
    idFactory: (prefix: string) => `${prefix}_${++sequence}`,
  }
}

async function seedConnection() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta', 'meta', 'Meta', 'ver_meta')
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_meta', 'conn_meta', 'meta', 'active', '{}',
        'hash_meta', 1, ?
      )
    `).bind(start.toISOString()),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by, updated_at
      ) VALUES (
        'conn_meta', 1, 1, 1, 100, 100, 'closed', 1, ?
      )
    `).bind(start.toISOString()),
  ])
}

async function runtimePolicy() {
  return db.prepare(`
    SELECT enabled, browser_enabled, server_enabled,
      server_target_percentage, server_effective_percentage, circuit_state
    FROM attribution_runtime_policies
    WHERE connection_id = 'conn_meta'
  `).first<{
    enabled: number
    browser_enabled: number
    server_enabled: number
    server_target_percentage: number
    server_effective_percentage: number
    circuit_state: string
  }>()
}

async function incidentCount() {
  const row = await db.prepare(`
    SELECT COUNT(*) AS value
    FROM attribution_incidents
    WHERE connection_id = 'conn_meta' AND status = 'open'
  `).first<{ value: number }>()
  return Number(row?.value ?? 0)
}
