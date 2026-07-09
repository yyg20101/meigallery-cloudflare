import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { conversionRoutes } from './conversions'

type Call = { sql: string; params: unknown[] }

function createConversionDb() {
  const calls: Call[] = []
  const db = {
    calls,
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          return null as T | null
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

function createApp(userId: number | null = null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('userRole', null)
    await next()
  })
  app.route('/api/conversions', conversionRoutes)
  return app
}

describe('conversion routes', () => {
  it('记录有效联系并返回 conversion id', async () => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'contact',
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
        methodType: 'telegram',
        actionTarget: 'floating_contact_panel',
        metadata: { method_type: 'telegram', contactValue: '@secret' },
      }),
    }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.data.actionType).toBe('contact')
    expect(JSON.stringify(db.calls)).not.toContain('@secret')
  })

  it('登录态 userId 写入转化账本', async () => {
    const db = createConversionDb()
    const res = await createApp(42).request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'contact',
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
        methodType: 'telegram',
        actionTarget: 'floating_contact_panel',
      }),
    }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)

    const conversionInsert = db.calls.find(call => call.sql.includes('analytics_conversion_actions'))
    expect(res.status).toBe(201)
    expect(conversionInsert?.params[7]).toBe(42)
  })

  it('公开接口接受注册完成和开始试用', async () => {
    for (const actionType of ['complete_registration', 'start_trial']) {
      const db = createConversionDb()
      const res = await createApp().request('/api/conversions/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionType,
          visitorId: 'visitor_1',
          sessionId: 'session_1',
          occurredAt: '2026-07-09T10:00:00.000Z',
          actionTarget: actionType,
        }),
      }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.data.actionType).toBe(actionType)
      expect(db.calls.some(call => (
        call.sql.includes('analytics_conversion_actions') && call.params[1] === actionType
      ))).toBe(true)
    }
  })

  it('公开接口不允许 lead 或 membership_grant', async () => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'lead',
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
      }),
    }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})
