import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
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
})

function application(db: D1Database) {
  const app = new Hono<{ Bindings: Bindings, Variables: Variables }>()
  app.use('*', async (c, next) => { c.set('userId', null); c.set('userRole', null); await next() })
  app.route('/api/conversions', conversionRoutes)
  return app
}

function bindings() { return { DB: createDb(), SESSION_SECRET: 'session', AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY } as unknown as Bindings }

function createDb() {
  return {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            first: async <T>() => sql.includes('contact_methods') ? ({ id: 'contact_123', platform: 'telegram', value: 'meigallery', link_url: 'https://t.me/meigallery' } as T) : null,
            all: async <T>() => ({ results: [] as T[] }),
            run: async () => ({ meta: { changes: 1 } }),
            __sql: sql,
          }
        },
      }
    },
    async batch(_statements: unknown[]) { return [] },
  } as unknown as D1Database
}
