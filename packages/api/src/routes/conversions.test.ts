import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { conversionRoutes } from './conversions'

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('公开转换路由', () => {
  it('只接受已启用联系方式的 open_link', async () => {
    const app = application(createDb())
    const response = await app.request('/api/conversions/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: 'open_link', contactMethodId: 'contact_123', visitorId: 'visitor_123', sessionId: 'session_123' }),
    }, bindings())
    expect(response.status).toBe(201)
  })

  it('copy 和失效联系方式返回 PUBLIC_CONVERSION_ACTION_INVALID', async () => {
    const app = application(createDb())
    const response = await app.request('/api/conversions/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: 'copy', contactMethodId: 'contact_123', visitorId: 'visitor_123', sessionId: 'session_123' }),
    }, bindings())
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('PUBLIC_CONVERSION_ACTION_INVALID')
  })

  it.each(['disabled', 'unsafe'])('%s 联系方式不会创建 Contact Fact', async mode => {
    const response = await application(createDb(mode)).request('/api/conversions/events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: 'open_link', contactMethodId: 'contact_123', visitorId: 'visitor_123', sessionId: 'session_123' }),
    }, bindings(createDb(mode)))
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('PUBLIC_CONVERSION_ACTION_INVALID')
  })

  it('draining 后只转发新 Worker，不再写入旧事实表', async () => {
    const db = createDb(undefined, 'draining')
    const fetch = vi.fn(async (request: Request) => {
      if (request.url.endsWith('/contact-events')) {
        const body = await request.json<{
          event: { eventId: string }
        }>()
        return Response.json({
          accepted: true,
          eventId: body.event.eventId,
        }, { status: 202 })
      }
      throw new Error(`unexpected attribution request: ${request.url}`)
    })
    const response = await application(db).request(
      '/api/conversions/events',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionType: 'open_link',
          contactMethodId: 'contact_123',
          visitorId: 'visitor_123',
          sessionId: 'session_123',
          path: '/gallery',
        }),
      },
      bindings(db, fetch),
    )

    expect(response.status).toBe(201)
    expect(db.batches).toHaveLength(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0].url).toBe(
      'https://attribution.internal/internal/v1/contact-events',
    )
  })

  it('old 请求在落库瞬间切为 draining 时只回退转发一次', async () => {
    const db = createDb(undefined, 'old', true)
    const fetch = vi.fn(async (request: Request) => {
      const body = await request.json<{
        event: { eventId: string }
      }>()
      return Response.json({
        accepted: true,
        eventId: body.event.eventId,
      }, { status: 202 })
    })
    const response = await application(db).request(
      '/api/conversions/events',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionType: 'open_link',
          contactMethodId: 'contact_123',
          visitorId: 'visitor_123',
          sessionId: 'session_123',
          path: '/gallery',
        }),
      },
      bindings(db, fetch),
    )

    expect(response.status).toBe(201)
    expect(db.batches).toHaveLength(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0].url).toBe(
      'https://attribution.internal/internal/v1/contact-events',
    )
  })
})

function application(_db: D1Database) {
  const app = new Hono<{ Bindings: Bindings, Variables: Variables }>()
  app.use('*', async (c, next) => { c.set('userId', null); c.set('userRole', null); await next() })
  app.route('/api/conversions', conversionRoutes)
  return app
}

function bindings(
  db = createDb(),
  fetch: (request: Request) => Promise<Response> = async () => {
    throw new Error('unexpected attribution request')
  },
) {
  return {
    DB: db,
    SESSION_SECRET: 'session',
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
    ATTRIBUTION: { fetch },
  } as unknown as Bindings
}

function createDb(
  mode: 'disabled' | 'unsafe' | undefined = undefined,
  owner: 'old' | 'draining' | 'new' = 'old',
  transitionOnBatch = false,
) {
  const batches: unknown[][] = []
  let currentOwner = owner
  return {
    batches,
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            first: async <T>() =>
              sql.includes('FROM attribution_runtime_cutover')
                ? (runtimeOwner(currentOwner) as T)
                : sql.includes('contact_methods')
                  ? (mode === 'disabled' ? null : ({ id: 'contact_123', platform: 'telegram', value: 'meigallery', link_url: mode === 'unsafe' ? 'javascript:alert(1)' : 'https://t.me/meigallery' } as T))
                  : null,
            all: async <T>() => ({ results: [] as T[] }),
            run: async () => ({ meta: { changes: 1 } }),
            __sql: sql,
          }
        },
        first: async <T>() => sql.includes(
          'FROM attribution_runtime_cutover',
        ) ? (runtimeOwner(currentOwner) as T) : null,
      }
    },
    async batch(statements: unknown[]) {
      batches.push(statements)
      if (transitionOnBatch) {
        currentOwner = 'draining'
        return statements.map(() => ({ meta: { changes: 0 } }))
      }
      return statements.map(() => ({ meta: { changes: 1 } }))
    },
  } as unknown as D1Database & { batches: unknown[][] }
}

function runtimeOwner(owner: 'old' | 'draining' | 'new') {
  return {
    owner,
    owner_epoch: owner === 'old' ? 1 : owner === 'draining' ? 2 : 3,
    changed_by: null,
    changed_at: '2026-07-24T00:00:00.000Z',
  }
}
