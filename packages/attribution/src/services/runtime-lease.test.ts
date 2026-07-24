import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  issueRuntimeLease,
  verifyDelayedRuntimeEvent,
  verifyRuntimeLease,
} from './runtime-lease'

const MIGRATION = readFileSync(
  new URL('../../migrations/0001_attribution_runtime.sql', import.meta.url),
  'utf8',
)
const signingKey = 'runtime-lease-signing-key-with-32-bytes'
let miniflare: Miniflare
let db: D1Database
let now = new Date('2026-07-24T00:00:00.000Z')

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'runtime-lease' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  now = new Date('2026-07-24T00:00:00.000Z')
  await seedActiveRuntime()
})

describe('归因运行租约', () => {
  it('只从 D1 当前 Active 签发且切换后旧租约仍锁定旧版本', async () => {
    const lease = await issueRuntimeLease(environment(), input())
    await switchActiveVersion()
    now = new Date('2026-07-24T00:10:00.000Z')

    expect(await verifyRuntimeLease(environment(), lease)).toMatchObject({
      provider: 'meta',
      connectionId: 'conn_meta_a',
      versionId: 'ver_old',
    })
  })

  it('调用方无法为错误平台、停用连接或非 Active 版本签发', async () => {
    await expect(issueRuntimeLease(environment(), {
      ...input(),
      provider: 'tiktok',
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_INVALID')

    await db.prepare(`
      UPDATE attribution_runtime_policies
      SET enabled = 0
      WHERE connection_id = 'conn_meta_a'
    `).run()
    await expect(issueRuntimeLease(environment(), input()))
      .rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_INVALID')
  })

  it('管理员停用连接后立即撤销既有租约', async () => {
    const lease = await issueRuntimeLease(environment(), input())
    await db.prepare(`
      UPDATE attribution_runtime_policies
      SET enabled = 0
      WHERE connection_id = 'conn_meta_a'
    `).run()
    now = new Date('2026-07-24T00:10:00.000Z')

    await expect(verifyRuntimeLease(environment(), lease))
      .rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_INVALID')
  })

  it('租约超过 30 分钟后拒绝新事件', async () => {
    const lease = await issueRuntimeLease(environment(), input())
    now = new Date('2026-07-24T00:30:01.000Z')

    await expect(verifyRuntimeLease(environment(), lease))
      .rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_EXPIRED')
  })

  it('非 granted 隐私状态不能签发租约', async () => {
    await expect(issueRuntimeLease(environment(), {
      ...input(),
      privacyState: 'choice_required',
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_NOT_GRANTED')
  })

  it('不足 32 字节的签名密钥拒绝签发', async () => {
    await expect(issueRuntimeLease({
      ...environment(),
      signingKeys: { current: 'weak-key' },
    }, input())).rejects.toThrow('ATTRIBUTION_RUNTIME_LEASE_INVALID')
  })

  it('D1 故障必须标记运行时不可用以便上游重试', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('D1 unavailable')
      },
    } as unknown as D1Database

    await expect(issueRuntimeLease({
      ...environment(),
      db: brokenDb,
    }, input())).rejects.toThrow('ATTRIBUTION_RUNTIME_UNAVAILABLE')

    const lease = await issueRuntimeLease(environment(), input())
    await expect(verifyRuntimeLease({
      ...environment(),
      db: brokenDb,
    }, lease)).rejects.toThrow('ATTRIBUTION_RUNTIME_UNAVAILABLE')
  })

  it('密钥轮换后 previous 仍可验证租约', async () => {
    const lease = await issueRuntimeLease(environment(), input())
    now = new Date('2026-07-24T00:10:00.000Z')

    expect(await verifyRuntimeLease({
      db,
      signingKeys: {
        current: 'runtime-lease-signing-key-next-32-bytes',
        previous: signingKey,
      },
      now: () => now,
    }, lease)).toMatchObject({
      versionId: 'ver_old',
    })
  })

  it('退休版本的租约内事件仍允许在可信接收时间 24 小时内补交', async () => {
    const lease = await issueRuntimeLease(environment(), input())
    await switchActiveVersion()
    await db.prepare(`
      UPDATE attribution_connection_versions
      SET status = 'retired',
          retired_at = '2026-07-24T00:31:00.000Z'
      WHERE id = 'ver_old'
    `).run()
    now = new Date('2026-07-24T20:00:00.000Z')

    expect(await verifyDelayedRuntimeEvent(environment(), lease, {
      occurredAt: '2026-07-24T00:29:59.000Z',
    })).toMatchObject({
      accepted: true,
      versionId: 'ver_old',
    })
  })

  it('超过租约发生时间或 24 小时补交窗口时拒绝', async () => {
    const lease = await issueRuntimeLease(environment(), input())

    now = new Date('2026-07-24T01:00:00.000Z')
    await expect(verifyDelayedRuntimeEvent(environment(), lease, {
      occurredAt: '2026-07-24T00:30:01.000Z',
    })).rejects.toThrow('ATTRIBUTION_DELAYED_EVENT_INVALID')

    now = new Date('2026-07-25T00:30:00.001Z')
    await expect(verifyDelayedRuntimeEvent(environment(), lease, {
      occurredAt: '2026-07-24T00:29:59.000Z',
    })).rejects.toThrow('ATTRIBUTION_DELAYED_EVENT_INVALID')
  })
})

function environment() {
  return {
    db,
    signingKeys: { current: signingKey },
    now: () => now,
  }
}

function input() {
  return {
    connectionId: 'conn_meta_a',
    provider: 'meta',
    privacyState: 'granted',
  } as const
}

async function seedActiveRuntime() {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta_a', 'meta', 'meta-a', 'ver_old')
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_old', 'conn_meta_a', 'meta', 'active', '{}',
        'hash_old', 1, '2026-07-24T00:00:00.000Z'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_runtime_policies (
        connection_id, enabled, browser_enabled, server_enabled,
        server_target_percentage, server_effective_percentage,
        circuit_state, updated_by
      ) VALUES ('conn_meta_a', 1, 1, 1, 10, 10, 'closed', 1)
    `),
  ])
}

async function switchActiveVersion() {
  await db.batch([
    db.prepare(`
      UPDATE attribution_connection_versions
      SET status = 'draining',
          draining_at = '2026-07-24T00:01:00.000Z'
      WHERE id = 'ver_old'
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_new', 'conn_meta_a', 'meta', 'active', '{}',
        'hash_new', 1, '2026-07-24T00:01:00.000Z'
      )
    `),
    db.prepare(`
      UPDATE attribution_connections
      SET active_version_id = 'ver_new'
      WHERE id = 'conn_meta_a'
    `),
  ])
}
