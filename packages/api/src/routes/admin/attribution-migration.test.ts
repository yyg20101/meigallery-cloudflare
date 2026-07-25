import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import {
  AttributionMigrationExportError,
} from '../../services/attribution-migration-export'
import {
  createAdminAttributionMigrationRoutes,
} from './attribution-migration'

const RUN_ID = 'migration-production-v1'
const RESULT = {
  runId: RUN_ID,
  phase: 'initial' as const,
  snapshotHash: 'a'.repeat(64),
  sourceConfigurationHash: 'b'.repeat(64),
  credentialSetHash: 'c'.repeat(64),
  capturedAt: '2026-07-24T12:00:00.000Z',
  replayed: false,
  counts: {
    connections: 2,
    versions: 2,
    credentials: 2,
    bindings: 4,
    managedSources: 1,
    historyRows: 3,
    historyFacts: 10,
  },
}

describe('后台归因运行时迁移', () => {
  it('仅 Owner 可执行，且外部请求只包含 runId', async () => {
    const runMigration = vi.fn(async (_environment, options) => {
      expect(options).toEqual({
        runId: RUN_ID,
        actorId: 7,
        phase: 'initial',
        initialRunId: undefined,
      })
      return RESULT
    })
    const writeAudit = vi.fn(async () => undefined)
    const response = await app({
      userId: 7,
      role: 'owner',
      runMigration,
      writeAudit,
    }).request(
      '/api/admin/attribution-migration',
      request(),
      bindings(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: RESULT })
    expect(runMigration).toHaveBeenCalledOnce()
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminId: 7,
        action: 'attribution.runtime.migrate',
        targetId: RUN_ID,
        afterValue: {
          runId: RUN_ID,
          phase: 'initial',
          snapshotHash: 'a'.repeat(64),
          sourceConfigurationHash: 'b'.repeat(64),
          capturedAt: RESULT.capturedAt,
          replayed: false,
          counts: RESULT.counts,
        },
      }),
    )
  })

  it('最终对账必须显式绑定初始迁移 runId', async () => {
    const runMigration = vi.fn(async () => ({
      ...RESULT,
      runId: 'migration-production-reconcile-v1',
      phase: 'reconcile' as const,
    }))
    const response = await app({
      userId: 7,
      role: 'owner',
      runMigration,
      writeAudit: vi.fn(),
    }).request(
      '/api/admin/attribution-migration',
      request({
        idempotencyKey: 'migration-production-reconcile-v1',
        body: {
          runId: 'migration-production-reconcile-v1',
          phase: 'reconcile',
          initialRunId: RUN_ID,
        },
      }),
      bindings(),
    )

    expect(response.status).toBe(200)
    expect(runMigration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'migration-production-reconcile-v1',
        phase: 'reconcile',
        initialRunId: RUN_ID,
      }),
    )
  })

  it.each([
    [null, null, 403],
    [2, 'admin', 403],
  ])('拒绝非 Owner userId=%s role=%s', async (userId, role, status) => {
    const runMigration = vi.fn()
    const response = await app({
      userId,
      role,
      runMigration,
      writeAudit: vi.fn(),
    }).request(
      '/api/admin/attribution-migration',
      request(),
      bindings(),
    )

    expect(response.status).toBe(status)
    expect(runMigration).not.toHaveBeenCalled()
  })

  it('拒绝不一致幂等键和额外请求字段', async () => {
    const runMigration = vi.fn()
    const route = app({
      userId: 7,
      role: 'owner',
      runMigration,
      writeAudit: vi.fn(),
    })
    const mismatch = await route.request(
      '/api/admin/attribution-migration',
      request({ idempotencyKey: 'different-run' }),
      bindings(),
    )
    const extra = await route.request(
      '/api/admin/attribution-migration',
      request({ body: { runId: RUN_ID, token: 'forbidden' } }),
      bindings(),
    )

    expect(mismatch.status).toBe(400)
    expect(extra.status).toBe(400)
    expect(runMigration).not.toHaveBeenCalled()
  })

  it('内部失败只返回稳定错误码，不泄漏异常详情', async () => {
    const runMigration = vi.fn(async () => {
      throw new Error('plaintext credential and private binding detail')
    })
    const response = await app({
      userId: 7,
      role: 'owner',
      runMigration,
      writeAudit: vi.fn(),
    }).request(
      '/api/admin/attribution-migration',
      request(),
      bindings(),
    )
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(text).toContain('ATTRIBUTION_MIGRATION_UNAVAILABLE')
    expect(text).not.toContain('plaintext credential')
  })

  it('把目标运行时冲突作为可操作的 409 返回', async () => {
    const runMigration = vi.fn(async () => {
      throw new AttributionMigrationExportError(
        'ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY',
      )
    })
    const response = await app({
      userId: 7,
      role: 'owner',
      runMigration,
      writeAudit: vi.fn(),
    }).request(
      '/api/admin/attribution-migration',
      request(),
      bindings(),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'ATTRIBUTION_MIGRATION_TARGET_NOT_EMPTY',
    })
  })
})

function app(input: {
  userId: number | null
  role: string | null
  runMigration: (...args: any[]) => Promise<any>
  writeAudit: (...args: any[]) => Promise<void>
}) {
  const app = new Hono<{
    Bindings: Bindings
    Variables: Variables
  }>()
  app.use('*', async (c, next) => {
    c.set('userId', input.userId)
    c.set('userRole', input.role)
    await next()
  })
  app.route(
    '/api/admin/attribution-migration',
    createAdminAttributionMigrationRoutes({
      runMigration: input.runMigration,
      writeAudit: input.writeAudit,
    }),
  )
  return app
}

function request(overrides: {
  idempotencyKey?: string
  body?: Record<string, unknown>
} = {}) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': overrides.idempotencyKey ?? RUN_ID,
    },
    body: JSON.stringify(overrides.body ?? { runId: RUN_ID }),
  }
}

function bindings(): Bindings {
  return {
    DB: {} as D1Database,
    ATTRIBUTION: {
      fetch: async () => Response.json({}),
    } as Fetcher,
  } as Bindings
}
