import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  assertAttributionRuntimeBridgeReadable,
  assertAttributionRuntimeWriteOwnership,
  readAttributionRuntimeWriteOwnership,
} from './runtime-activation'
import {
  readAttributionRuntimeState,
  transitionAttributionRuntimeMode,
} from './runtime-state'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0006_runtime_owner_epoch.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'runtime-activation' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const migration of MIGRATIONS) {
    await db.exec(cleanSql(migration))
  }
})

beforeEach(async () => {
  await db.prepare(`
    UPDATE attribution_runtime_state
    SET mode = 'shadow',
        activated_at = NULL,
        bridge_owner_epoch = NULL,
        active_owner_epoch = NULL,
        fenced_owner_epoch = NULL,
        updated_at = ?
    WHERE id = 'global'
  `).bind('2026-07-24T00:00:00.000Z').run()
})

afterAll(async () => miniflare.dispose())

describe('Attribution Worker owner epoch 门禁', () => {
  it('shadow 拒绝业务写，bridge 只接受 matching draining epoch', async () => {
    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'draining',
      epoch: 2,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')

    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
      now: () => new Date('2026-07-24T00:01:00.000Z'),
    })
    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'draining',
      epoch: 2,
    })).resolves.toMatchObject({
      mode: 'bridge',
      bridgeOwnerEpoch: 2,
    })
    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'new',
      epoch: 3,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')
  })

  it('active 同时接受排空 epoch 和 new epoch，覆盖无事务切换间隙', async () => {
    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
      now: () => new Date('2026-07-24T00:01:00.000Z'),
    })
    await transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 3,
      now: () => new Date('2026-07-24T00:02:00.000Z'),
    })

    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'draining',
      epoch: 2,
    })).resolves.toMatchObject({ mode: 'active' })
    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'new',
      epoch: 3,
    })).resolves.toMatchObject({ mode: 'active' })
    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'new',
      epoch: 4,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')
  })

  it('epoch 必须连续且 bridge/active 才允许桥接读取', async () => {
    await expect(transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 1,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')
    await expect(assertAttributionRuntimeBridgeReadable(db))
      .rejects.toThrow('ATTRIBUTION_RUNTIME_BRIDGE_NOT_READY')

    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
    })
    await expect(transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 6,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_OWNER_EPOCH_INVALID')
    await expect(assertAttributionRuntimeBridgeReadable(db))
      .resolves.toMatchObject({ mode: 'bridge' })
  })

  it('fenced 隔离公网桥接和所有内部写入', async () => {
    await transitionAttributionRuntimeMode(db, 'bridge', {
      sourceOwnerEpoch: 2,
    })
    await transitionAttributionRuntimeMode(db, 'active', {
      sourceOwnerEpoch: 3,
    })
    await transitionAttributionRuntimeMode(db, 'fenced', {
      sourceOwnerEpoch: 4,
    })

    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'draining',
      epoch: 2,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')
    await expect(assertAttributionRuntimeWriteOwnership(db, {
      owner: 'new',
      epoch: 3,
    })).rejects.toThrow('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_REJECTED')
    await expect(assertAttributionRuntimeBridgeReadable(db))
      .rejects.toThrow('ATTRIBUTION_RUNTIME_BRIDGE_NOT_READY')

    const fenced = await readAttributionRuntimeState(db)
    expect(fenced).toMatchObject({
      mode: 'fenced',
      bridgeOwnerEpoch: null,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: 4,
    })
  })

  it('Service Binding ownership headers 使用严格值', () => {
    expect(readAttributionRuntimeWriteOwnership(new Request(
      'https://attribution.internal/internal/v1/registration-events',
      {
        headers: {
          'X-Attribution-Runtime-Owner': 'draining',
          'X-Attribution-Runtime-Epoch': '2',
        },
      },
    ))).toEqual({ owner: 'draining', epoch: 2 })
    expect(() => readAttributionRuntimeWriteOwnership(new Request(
      'https://attribution.internal/internal/v1/registration-events',
      {
        headers: {
          'X-Attribution-Runtime-Owner': 'old',
          'X-Attribution-Runtime-Epoch': '1',
        },
      },
    ))).toThrow('ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_INVALID')
  })

  it('状态读取包含两个 owner epoch', async () => {
    const shadow = await readAttributionRuntimeState(db)
    expect(shadow).toMatchObject({
      mode: 'shadow',
      bridgeOwnerEpoch: null,
      activeOwnerEpoch: null,
      fencedOwnerEpoch: null,
    })
  })
})

function cleanSql(value: string) {
  return value
    .replace(/^--.*$/gmu, '')
    .replace(/\s*\r?\n\s*/gu, ' ')
    .trim()
}
