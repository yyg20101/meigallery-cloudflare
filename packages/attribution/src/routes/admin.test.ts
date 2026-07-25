import { readFileSync } from 'node:fs'
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
import { getProviderAdapter } from '../adapters/registry'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import { parseAttributionEnvironment } from '../env'
import {
  createAttributionConnectionCommands,
} from '../services/connection-commands'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import {
  createAdminAttributionRoutes,
  type AdminAttributionActor,
  type AdminAttributionVariables,
} from './admin'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
  '../../migrations/0003_queue_runtime.sql',
  '../../migrations/0004_runtime_state.sql',
  '../../migrations/0005_migration_history.sql',
  '../../migrations/0006_runtime_owner_epoch.sql',
  '../../migrations/0007_validation_idempotency.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const now = new Date('2026-07-24T08:00:00.000Z')
const owner: AdminAttributionActor = {
  actorId: 1,
  role: 'owner',
}
let miniflare: Miniflare
let db: D1Database
const workflowCreateBatch = vi.fn().mockResolvedValue([])
const workflowStatus = vi.fn().mockResolvedValue({ status: 'running' })
const workflowGet = vi.fn().mockResolvedValue({
  status: workflowStatus,
})

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'admin-routes' },
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
  workflowCreateBatch.mockReset().mockResolvedValue([])
  workflowStatus.mockClear()
  workflowGet.mockClear()
})

describe('独立 Attribution Worker 管理路由', () => {
  it('默认拒绝公共网络直接访问管理路由', async () => {
    const response = await testApp(null).request(
      '/admin/attribution/connections',
      {},
      bindings(),
    )

    expect(response.status).toBe(404)
  })

  it('非 Owner 不能读取或修改连接控制面', async () => {
    const response = await testApp({
      actorId: 2,
      role: 'admin',
    }).request(
      '/admin/attribution/connections',
      {},
      bindings(),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'ATTRIBUTION_OWNER_REQUIRED' },
    })
  })

  it('写请求缺少幂等键时拒绝', async () => {
    const response = await testApp(owner).request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validConnectionInput()),
      },
      bindings(),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'ATTRIBUTION_IDEMPOTENCY_KEY_REQUIRED',
      },
    })
  })

  it('重复创建连接返回同一脱敏结果且 D1 行数不变', async () => {
    const app = testApp(owner)
    const request = () => app.request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create_meta_team_a',
        },
        body: JSON.stringify(validConnectionInput()),
      },
      bindings(),
    )

    const first = await request()
    const second = await request()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(secondBody).toEqual(firstBody)
    expect(JSON.stringify(firstBody)).not.toMatch(
      /versionId|candidateId|credential|fingerprint|ciphertext|token|commit|revision/i,
    )
    expect(await tableCount('attribution_connections')).toBe(1)
    expect(await tableCount('attribution_audit_logs')).toBe(1)
    expect(await tableCount('attribution_command_receipts')).toBe(1)
  })

  it('相同幂等键不能用于不同请求', async () => {
    const app = testApp(owner)
    const send = (name: string) => app.request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create_meta_conflict',
        },
        body: JSON.stringify({
          ...validConnectionInput(),
          name,
        }),
      },
      bindings(),
    )

    expect((await send('团队 A')).status).toBe(200)
    const conflict = await send('团队 B')

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: {
        code: 'ATTRIBUTION_IDEMPOTENCY_CONFLICT',
      },
    })
    expect(await tableCount('attribution_connections')).toBe(1)
  })

  it('并发重复创建连接只产生一份领域结果、审计和回执', async () => {
    const app = testApp(owner)
    const request = () => app.request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create_meta_concurrent',
        },
        body: JSON.stringify(validConnectionInput()),
      },
      bindings(),
    )

    const responses = await Promise.all([request(), request()])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(await responses[0]!.json()).toEqual(
      await responses[1]!.json(),
    )
    expect(await tableCount('attribution_connections')).toBe(1)
    expect(await tableCount('attribution_audit_logs')).toBe(1)
    expect(await tableCount('attribution_command_receipts')).toBe(1)
  })

  it('保存候选后自动启动一次验证且响应不泄露内部身份', async () => {
    workflowCreateBatch
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('instance already exists'))
    const app = testApp(owner)
    const created = await app.request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create_meta_for_candidate',
        },
        body: JSON.stringify(validConnectionInput()),
      },
      bindings(),
    )
    const connectionId = (
      await created.json() as { data: { id: string } }
    ).data.id
    const request = (testEventCode = 'TEST12345') => app.request(
      `/admin/attribution/connections/${connectionId}/candidates`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'save_meta_candidate',
        },
        body: JSON.stringify({
          publicConfig: { pixelId: '1615446443914929' },
          credential: {
            type: 'access_token',
            plaintext: 'meta-access-token-for-admin-route-test',
          },
          eventBindings: [
            {
              canonicalEvent: 'Contact',
              enabled: true,
              browserDestination: 'meta_pixel',
              serverDestination: 'meta_capi',
            },
            {
              canonicalEvent: 'CompleteRegistration',
              enabled: true,
              browserDestination: 'meta_pixel',
              serverDestination: 'meta_capi',
            },
          ],
          testEventCode,
        }),
      },
      bindings(),
    )

    const first = await request()
    const replay = await request()
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    const serialized = JSON.stringify(await (
      await app.request(
        `/admin/attribution/connections/${connectionId}/candidate`,
        {},
        bindings(),
      )
    ).json())
    expect(serialized).toContain('"state":"validating"')
    expect(serialized).not.toMatch(
      /candidateId|versionId|validationId|credential|fingerprint|token|testEventCode/i,
    )
    expect(workflowCreateBatch).toHaveBeenCalledTimes(2)
    const firstWorkflowId = workflowCreateBatch.mock.calls[0]?.[0]?.[0]?.id
    const replayWorkflowId = workflowCreateBatch.mock.calls[1]?.[0]?.[0]?.id
    expect(replayWorkflowId).toBe(firstWorkflowId)
    expect(workflowGet).toHaveBeenCalledWith(firstWorkflowId)
    expect(workflowStatus).toHaveBeenCalledTimes(1)
    expect(await tableCount('attribution_connection_versions')).toBe(1)
    expect(await tableCount('attribution_validations')).toBe(1)

    const conflict = await request('TEST67890')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: { code: 'ATTRIBUTION_IDEMPOTENCY_CONFLICT' },
    })
  })

  it('初始迁移候选可通过独立幂等入口启动验证', async () => {
    workflowCreateBatch
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('instance already exists'))
    const app = testApp(owner)
    const environmentBindings = bindings()
    const runtime = parseAttributionEnvironment(environmentBindings)
    const created = await app.request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create_meta_for_migrated_candidate',
        },
        body: JSON.stringify(validConnectionInput()),
      },
      environmentBindings,
    )
    const connectionId = (
      await created.json() as { data: { id: string } }
    ).data.id
    await createAttributionConnectionCommands({
      db,
      credentialKeys: runtime.credentialMasterKeys,
      now: () => now,
      idFactory: prefix => `${prefix}_migrated_candidate`,
    }).createCandidate({
      connectionId,
      publicConfig: { pixelId: '1615446443914929' },
      credential: 'meta-migrated-candidate-token',
      bindings: [
        {
          canonicalEvent: 'Contact',
          enabled: true,
          browserDestination: 'meta_pixel',
          serverDestination: 'meta_capi',
        },
        {
          canonicalEvent: 'CompleteRegistration',
          enabled: true,
          browserDestination: 'meta_pixel',
          serverDestination: 'meta_capi',
        },
      ],
      actorId: owner.actorId,
      idempotencyKey: 'import_meta_candidate',
    })

    const request = (testEventCode = 'TEST12345') => app.request(
      `/admin/attribution/connections/${connectionId}`
      + '/candidate/validation',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'validate_migrated_meta_candidate',
        },
        body: JSON.stringify({ testEventCode }),
      },
      environmentBindings,
    )
    const first = await request()
    const replay = await request()

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const firstBody = await first.json()
    const replayBody = await replay.json()
    expect(replayBody).toEqual(firstBody)
    expect(JSON.stringify(firstBody)).not.toMatch(
      /validationId|versionId|credential|fingerprint|token|testEventCode/i,
    )
    expect(await tableCount('attribution_validations')).toBe(1)
    const conflict = await request('TEST67890')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: {
        code: 'ATTRIBUTION_VALIDATION_IDEMPOTENCY_CONFLICT',
      },
    })
  })

  it('拒绝超出边界的管理请求体', async () => {
    const response = await testApp(owner).request(
      '/admin/attribution/connections',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'oversized_admin_request',
        },
        body: JSON.stringify({ payload: 'x'.repeat(70 * 1024) }),
      },
      bindings(),
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: 'ATTRIBUTION_REQUEST_TOO_LARGE' },
    })
    expect(await tableCount('attribution_connections')).toBe(0)
  })

  it('运行模式切换要求最终对账并保持命令幂等', async () => {
    const app = testApp(owner)
    const blocked = await app.request(
      '/admin/attribution/runtime-state/transition',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'runtime_bridge_blocked',
        },
        body: JSON.stringify({
          targetMode: 'bridge',
          sourceOwnerEpoch: 2,
          reason: '完成最终对账并启动桥接',
        }),
      },
      bindings(),
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({
      error: { code: 'ATTRIBUTION_RUNTIME_MIGRATION_NOT_READY' },
    })

    await insertReconciledManifest()
    const request = () => app.request(
      '/admin/attribution/runtime-state/transition',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'runtime_bridge_ready',
        },
        body: JSON.stringify({
          targetMode: 'bridge',
          sourceOwnerEpoch: 2,
          reason: '完成最终对账并启动桥接',
        }),
      },
      bindings(),
    )
    const first = await request()
    const replay = await request()
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const firstBody = await first.json()
    const replayBody = await replay.json()
    expect(replayBody).toEqual(firstBody)
    expect(firstBody).toMatchObject({
      data: {
        mode: 'bridge',
        bridgeOwnerEpoch: 2,
      },
    })
    expect(await tableCount('attribution_audit_logs')).toBe(1)
    expect(await tableCount('attribution_command_receipts')).toBe(1)
  })

  it('运营读接口统一由独立 Worker 提供并严格校验日期', async () => {
    const app = testApp(owner)
    const operations = await app.request(
      '/admin/attribution/operations'
      + '?dateFrom=2026-07-24&dateTo=2026-07-24',
      {},
      bindings(),
    )
    const bindingsResponse = await app.request(
      '/admin/attribution/bindings',
      {},
      bindings(),
    )
    const verifications = await app.request(
      '/admin/attribution/verifications'
      + '?dateFrom=2026-07-24&dateTo=2026-07-24',
      {},
      bindings(),
    )
    const audit = await app.request(
      '/admin/attribution/audit'
      + '?dateFrom=2026-07-24&dateTo=2026-07-24',
      {},
      bindings(),
    )

    expect(operations.status).toBe(200)
    expect(await operations.json()).toEqual({ data: [] })
    expect(bindingsResponse.status).toBe(200)
    expect(await bindingsResponse.json()).toEqual({ data: [] })
    expect(verifications.status).toBe(200)
    expect(await verifications.json()).toEqual({ data: [] })
    expect(audit.status).toBe(200)
    expect(await audit.json()).toEqual({ data: [] })

    const invalidDate = await app.request(
      '/admin/attribution/operations'
      + '?dateFrom=2026-99-99&dateTo=2026-07-24',
      {},
      bindings(),
    )
    expect(invalidDate.status).toBe(400)
    expect(await invalidDate.json()).toMatchObject({
      error: { code: 'ATTRIBUTION_REQUEST_INVALID' },
    })
  })
})

type TestEnvironment = {
  Bindings: AttributionBindings
  Variables: AdminAttributionVariables
}

function testApp(actor: AdminAttributionActor | null) {
  const app = new Hono<TestEnvironment>()
  app.use('*', async (c, next) => {
    c.set(
      'attributionEnvironment',
      parseAttributionEnvironment(c.env),
    )
    await next()
  })
  app.route(
    '/admin/attribution',
    createAdminAttributionRoutes({
      authorize: async () => actor,
      now: () => now,
      runtimeHealth: {
        check: async () => ({
          activeSnapshotReadable: true,
          credentialDecryptable: true,
          queueBound: true,
          adapterConstructable: true,
        }),
      },
      adapterFor: getProviderAdapter,
    }),
  )
  return app
}

function validConnectionInput() {
  return {
    provider: 'meta',
    name: '团队 A',
    isDefault: true,
  }
}

function bindings(): AttributionBindings {
  const queue = {
    send: async () => undefined,
  } as unknown as AttributionBindings['META_QUEUE']
  return {
    DB: db,
    APP_ENV: 'local',
    ATTRIBUTION_PUBLIC_ORIGINS: 'http://localhost:3000',
    ATTRIBUTION_COOKIE_DOMAIN: '',
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT:
      'admin-credential-key-current-with-32-bytes',
    ATTRIBUTION_SIGNING_KEY_CURRENT:
      'admin-signing-key-current-with-32-bytes',
    ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT:
      'admin-data-key-current-with-32-bytes',
    META_QUEUE: queue,
    TIKTOK_QUEUE: queue,
    GOOGLE_QUEUE: queue,
    ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW: {
      createBatch: workflowCreateBatch,
      get: workflowGet,
    } as unknown as AttributionEnvironment['validationWorkflow'],
  }
}

async function tableCount(table: string): Promise<number> {
  const allowed = new Set([
    'attribution_connections',
    'attribution_audit_logs',
    'attribution_command_receipts',
    'attribution_connection_versions',
    'attribution_validations',
  ])
  if (!allowed.has(table)) throw new Error('TEST_TABLE_INVALID')
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

async function insertReconciledManifest() {
  await db.prepare(`
    INSERT INTO attribution_migration_manifests (
      initial_run_id,
      initial_snapshot_hash,
      source_configuration_hash,
      credential_set_hash,
      initial_captured_at,
      desired_runtime_policies_json,
      status,
      reconcile_run_id,
      reconcile_snapshot_hash,
      reconciled_captured_at,
      created_at,
      reconciled_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 'reconciled', ?, ?, ?, ?, ?)
  `).bind(
    'initial_admin_runtime',
    'a'.repeat(64),
    'b'.repeat(64),
    'c'.repeat(64),
    '2026-07-24T00:00:00.000Z',
    'reconcile_admin_runtime',
    'd'.repeat(64),
    '2026-07-24T00:01:00.000Z',
    '2026-07-24T00:00:00.000Z',
    '2026-07-24T00:01:00.000Z',
  ).run()
}
