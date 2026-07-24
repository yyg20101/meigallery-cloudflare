import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type {
  AttributionBindings,
  AttributionEnvironment,
} from '../env'
import { createAttributionMigrationRoutes } from './migration'

const SECRET = 'migration-route-secret'
const RUN_ID = 'migration-production-v1'

describe('归因迁移内部路由', () => {
  it.each([
    [null, 404],
    [{ actorId: 2, role: 'admin' as const }, 403],
  ])('非 Owner 身份 %j 被拒绝', async (actor, status) => {
    const importSnapshot = vi.fn()
    const response = await app(actor, importSnapshot).request(
      '/internal/migration/v1/import',
      migrationRequest(),
      bindings(),
    )

    expect(response.status).toBe(status)
    expect(importSnapshot).not.toHaveBeenCalled()
  })

  it('只信任内部 Owner 身份并返回不含凭证的结果', async () => {
    const importSnapshot = vi.fn(async (_environment, request) => {
      expect(request.actorId).toBe(7)
      expect(request.snapshot.connections[0].credential.plaintext)
        .toBe(SECRET)
      return {
        runId: RUN_ID,
        phase: 'initial',
        snapshotHash: 'a'.repeat(64),
        sourceConfigurationHash: 'b'.repeat(64),
        credentialSetHash: 'c'.repeat(64),
        capturedAt: '2026-07-24T12:00:00.000Z',
        replayed: false,
        counts: {},
      }
    })
    const response = await app({
      actorId: 7,
      role: 'owner',
    }, importSnapshot).request(
      '/internal/migration/v1/import',
      migrationRequest(),
      bindings(),
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(SECRET)
    expect(importSnapshot).toHaveBeenCalledOnce()
  })

  it('要求幂等键与 runId 一致并拒绝请求体伪造身份', async () => {
    const importSnapshot = vi.fn()
    const mismatch = await app({
      actorId: 7,
      role: 'owner',
    }, importSnapshot).request(
      '/internal/migration/v1/import',
      migrationRequest({ idempotencyKey: 'different-run' }),
      bindings(),
    )
    const forged = await app({
      actorId: 7,
      role: 'owner',
    }, importSnapshot).request(
      '/internal/migration/v1/import',
      migrationRequest({ actorId: 999 }),
      bindings(),
    )

    expect(mismatch.status).toBe(400)
    expect(forged.status).toBe(400)
    expect(importSnapshot).not.toHaveBeenCalled()
  })

  it('Owner 可查询既有迁移回执，未知 runId 返回稳定 404', async () => {
    const readResult = vi.fn(async (_db, runId) =>
      runId === RUN_ID
        ? {
            runId,
            phase: 'initial',
            snapshotHash: 'a'.repeat(64),
            sourceConfigurationHash: 'b'.repeat(64),
            credentialSetHash: 'c'.repeat(64),
            capturedAt: '2026-07-24T12:00:00.000Z',
            replayed: true,
            counts: {},
          }
        : null)
    const routes = app({
      actorId: 7,
      role: 'owner',
    }, vi.fn(), readResult)

    const existing = await routes.request(
      `/internal/migration/v1/imports/${RUN_ID}`,
      {},
      bindings(),
    )
    const missing = await routes.request(
      '/internal/migration/v1/imports/migration-unknown',
      {},
      bindings(),
    )

    expect(existing.status).toBe(200)
    expect(await existing.json()).toMatchObject({
      data: { runId: RUN_ID, replayed: true },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: { code: 'ATTRIBUTION_MIGRATION_NOT_FOUND' },
    })
  })
})

function app(
  actor: { actorId: number; role: 'admin' | 'owner' } | null,
  importSnapshot: (...args: any[]) => Promise<unknown>,
  readResult: (...args: any[]) => Promise<any> = async () => null,
) {
  const routes = new Hono<{
    Bindings: AttributionBindings
    Variables: {
      attributionEnvironment: AttributionEnvironment
    }
  }>()
  routes.use('*', async (c, next) => {
    c.set('attributionEnvironment', {
      credentialMasterKeys: {
        current: 'new-credential-key-at-least-32-bytes',
      },
    } as AttributionEnvironment)
    await next()
  })
  routes.route(
    '/internal/migration/v1',
    createAttributionMigrationRoutes({
      authorize: async () => actor,
      importSnapshot,
      readResult,
    }),
  )
  return routes
}

function migrationRequest(overrides: {
  idempotencyKey?: string
  actorId?: number
} = {}) {
  const body: Record<string, unknown> = {
    runId: RUN_ID,
    snapshot: {
      phase: 'initial',
      connections: [{
        credential: { plaintext: SECRET },
      }],
    },
  }
  if (overrides.actorId !== undefined) {
    body.actorId = overrides.actorId
  }
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': overrides.idempotencyKey ?? RUN_ID,
    },
    body: JSON.stringify(body),
  }
}

function bindings(): AttributionBindings {
  return {
    DB: {} as D1Database,
  } as AttributionBindings
}
