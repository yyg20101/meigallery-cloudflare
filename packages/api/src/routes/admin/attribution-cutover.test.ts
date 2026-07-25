import { Hono } from 'hono'
import { Miniflare } from 'miniflare'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Bindings, Variables } from '../../index'
import {
  createAdminAttributionCutoverRoutes,
} from './attribution-cutover'

let miniflare: Miniflare
let db: D1Database
const attributionFetch = vi.fn()
let remoteRuntimeState: {
  mode: 'shadow' | 'bridge' | 'active' | 'fenced'
  activatedAt: string | null
  bridgeOwnerEpoch: number | null
  activeOwnerEpoch: number | null
  fencedOwnerEpoch: number | null
  updatedAt: string
  migrationReconciled: boolean
  inFlightServerDeliveries: number
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'admin-attribution-cutover' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(cleanSql(`
    CREATE TABLE attribution_runtime_cutover (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      changed_by INTEGER,
      changed_at TEXT NOT NULL
    );
    CREATE TABLE attribution_runtime_cutover_commands (
      idempotency_key TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE attribution_conversion_facts (
      id TEXT PRIMARY KEY,
      canonical_event TEXT NOT NULL,
      analytics_dimensions_json TEXT NOT NULL
    );
    CREATE TABLE attribution_business_outbox (
      id TEXT PRIMARY KEY,
      routing_owner TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE attribution_deliveries (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE attribution_outbox (
      delivery_id TEXT PRIMARY KEY
    );
  `))
})

beforeEach(async () => {
  remoteRuntimeState = {
    mode: 'shadow',
    activatedAt: null,
    bridgeOwnerEpoch: null,
    activeOwnerEpoch: null,
    fencedOwnerEpoch: null,
    updatedAt: '2026-07-24T00:00:00.000Z',
    migrationReconciled: true,
    inFlightServerDeliveries: 0,
  }
  attributionFetch.mockReset().mockImplementation(
    async (request: Request) => {
      if (request.method === 'GET') {
        return Response.json(remoteRuntimeState)
      }
      const input = await request.json<{
        targetMode: 'bridge' | 'active' | 'fenced'
        sourceOwnerEpoch: number
      }>()
      remoteRuntimeState = {
        mode: input.targetMode,
        activatedAt: input.targetMode === 'active'
          ? '2026-07-24T00:02:00.000Z'
          : null,
        bridgeOwnerEpoch: input.targetMode === 'bridge'
          ? input.sourceOwnerEpoch
          : input.targetMode === 'active'
            ? remoteRuntimeState.bridgeOwnerEpoch
            : null,
        activeOwnerEpoch: input.targetMode === 'active'
          ? input.sourceOwnerEpoch
          : null,
        fencedOwnerEpoch: input.targetMode === 'fenced'
          ? input.sourceOwnerEpoch
          : null,
        updatedAt: '2026-07-24T00:02:00.000Z',
        migrationReconciled: true,
        inFlightServerDeliveries: 0,
      }
      const {
        migrationReconciled: _,
        inFlightServerDeliveries: __,
        ...state
      } = remoteRuntimeState
      return Response.json({ data: state })
    },
  )
  await db.exec(cleanSql(`
    DELETE FROM attribution_outbox;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_business_outbox;
    DELETE FROM attribution_conversion_facts;
    DELETE FROM users;
    DELETE FROM admin_audit_logs;
    DELETE FROM attribution_runtime_cutover_commands;
    DELETE FROM attribution_runtime_cutover;
    INSERT INTO attribution_runtime_cutover (
      id, owner, owner_epoch, changed_by, changed_at
    ) VALUES (
      'global', 'old', 1, NULL, '2026-07-24T00:00:00.000Z'
    );
    INSERT INTO users (id, created_at)
    VALUES (1, '2026-07-24T00:00:00.000Z');
    INSERT INTO attribution_conversion_facts (
      id, canonical_event, analytics_dimensions_json
    ) VALUES (
      'fact_registration_1',
      'CompleteRegistration',
      '{"userId":1}'
    );
  `))
})

afterAll(async () => miniflare.dispose())

describe('归因切换 Owner 控制面', () => {
  it('GET 返回本地就绪、远端待推进的只读预检且禁止缓存', async () => {
    const response = await app('owner').request(
      '/api/admin/attribution-cutover?targetOwner=draining',
      {},
      bindings(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      data: {
        current: { owner: 'old', epoch: 1 },
        targetOwner: 'draining',
        targetEpoch: 2,
        localReady: true,
        ready: false,
      },
    })
  })

  it('非 Owner 无法读取或执行切换', async () => {
    const response = await app('admin').request(
      '/api/admin/attribution-cutover?targetOwner=draining',
      {},
      bindings(),
    )
    expect(response.status).toBe(403)
  })

  it('预检存在缺失注册事实时返回 409 且不改变 owner', async () => {
    await db.prepare(`
      DELETE FROM attribution_conversion_facts
    `).run()
    const response = await transitionRequest('cutover_blocked')

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'ATTRIBUTION_CUTOVER_PREFLIGHT_BLOCKED' },
      data: {
        counts: { missingRegistrationFacts: 1 },
        ready: false,
      },
    })
    expect(await currentOwner()).toEqual({ owner: 'old', epoch: 1 })
    expect(await count('admin_audit_logs')).toBe(0)
    expect(remoteRuntimeState.mode).toBe('shadow')
  })

  it('成功切换与同键重放只写一份 owner、审计和回执', async () => {
    const first = await transitionRequest('cutover_to_draining')
    const replay = await transitionRequest('cutover_to_draining')

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const firstBody = await first.json()
    const replayBody = await replay.json()
    expect(replayBody.data.state).toEqual(firstBody.data.state)
    expect(firstBody).toMatchObject({
      data: {
        state: {
          owner: 'draining',
          epoch: 2,
          changedBy: 7,
        },
      },
    })
    expect(await currentOwner()).toEqual({
      owner: 'draining',
      epoch: 2,
    })
    expect(await count('admin_audit_logs')).toBe(1)
    expect(await count('attribution_runtime_cutover_commands')).toBe(1)
    expect(remoteRuntimeState).toMatchObject({
      mode: 'bridge',
      bridgeOwnerEpoch: 2,
    })
  })

  it('仅在新侧仍接受当前 epoch 且转发 Outbox 已清空时回滚并可安全重放', async () => {
    expect((await transitionRequest('cutover_before_restore')).status)
      .toBe(200)
    const restored = await restoreRequest()
    const replay = await restoreRequest()

    expect(restored.status).toBe(200)
    expect(replay.status).toBe(200)
    const restoredBody = await restored.json()
    const replayBody = await replay.json()
    expect(replayBody.data.state).toEqual(restoredBody.data.state)
    expect(restoredBody).toMatchObject({
      data: {
        state: {
          owner: 'old',
          epoch: 3,
        },
      },
    })
    expect(await count('admin_audit_logs')).toBe(2)
    expect(await count('attribution_runtime_cutover_commands')).toBe(2)
    expect(remoteRuntimeState).toMatchObject({
      mode: 'fenced',
      fencedOwnerEpoch: 3,
    })
  })
})

function app(role: 'admin' | 'owner') {
  const app = new Hono<{
    Bindings: Bindings
    Variables: Variables
  }>()
  app.use('*', async (c, next) => {
    c.set('userId', 7)
    c.set('userRole', role)
    await next()
  })
  app.route(
    '/api/admin/attribution-cutover',
    createAdminAttributionCutoverRoutes({
      now: () => new Date('2026-07-24T00:02:00.000Z'),
    }),
  )
  return app
}

function bindings() {
  return {
    DB: db,
    ATTRIBUTION: { fetch: attributionFetch },
  } as unknown as Bindings
}

function transitionRequest(idempotencyKey: string) {
  return app('owner').request(
    '/api/admin/attribution-cutover/transition',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        targetOwner: 'draining',
        expectedEpoch: 1,
        reason: '完成最终对账并开始生产排空',
      }),
    },
    bindings(),
  )
}

function restoreRequest() {
  return app('owner').request(
    '/api/admin/attribution-cutover/restore',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'cutover_restore_old',
      },
      body: JSON.stringify({
        expectedEpoch: 2,
        reason: '生产 smoke 失败，恢复旧运行时',
      }),
    },
    bindings(),
  )
}

async function currentOwner() {
  const row = await db.prepare(`
    SELECT owner, owner_epoch
    FROM attribution_runtime_cutover
    WHERE id = 'global'
  `).first<{ owner: string; owner_epoch: number }>()
  return {
    owner: row?.owner,
    epoch: row?.owner_epoch,
  }
}

async function count(table: string) {
  const allowed = new Set([
    'admin_audit_logs',
    'attribution_runtime_cutover_commands',
  ])
  if (!allowed.has(table)) throw new Error('TEST_TABLE_INVALID')
  const row = await db.prepare(`
    SELECT COUNT(*) AS value FROM ${table}
  `).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

function cleanSql(value: string) {
  return value.replace(/\s*\r?\n\s*/gu, ' ').trim()
}
