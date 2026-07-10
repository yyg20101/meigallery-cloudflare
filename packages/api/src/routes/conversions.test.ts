import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { createPixelReceiptToken } from '../utils/pixel-receipt'
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
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map(statement => statement.run()))
    },
  }
  return db
}

function createPixelReceiptDb(options: {
  channel?: 'meta_pixel' | 'meta_capi'
  eventId?: string
  status?: 'pending' | 'attempted' | 'sent' | 'failed' | 'skipped' | 'duplicate_suppressed'
  failAttemptedDaily?: boolean
} = {}) {
  const calls: Call[] = []
  const delivery = {
    id: 'cdlv_pixel_1',
    channel: options.channel ?? 'meta_pixel',
    eventId: options.eventId ?? 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
    status: options.status ?? 'pending',
    date: '2026-07-09',
    eventName: 'Contact',
  }
  let dailyAttemptedCount = 0
  let failAttemptedDaily = options.failAttemptedDaily ?? false
  type ReceiptState = { delivery: typeof delivery; dailyAttemptedCount: number; lastChanges: number }
  function execute(call: Call, state: ReceiptState) {
    if (call.sql.includes("status = 'attempted'")) {
      if (state.delivery.status !== 'pending') {
        state.lastChanges = 0
        return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      }
      state.delivery.status = 'attempted'
      state.lastChanges = 1
      return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
    }
    if (call.sql.includes('analytics_conversion_delivery_daily')) {
      if (failAttemptedDaily) throw new Error('模拟 attempted 日报写入失败')
      if (state.lastChanges === 1) state.dailyAttemptedCount += 1
      state.lastChanges = state.lastChanges === 1 ? 1 : 0
      return { meta: { changes: state.lastChanges, rows_written: state.lastChanges, rows_read: 0, duration: 1 } }
    }
    state.lastChanges = 1
    return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
  }
  const db = {
    calls,
    get delivery() {
      return delivery
    },
    get dailyAttemptedCount() {
      return dailyAttemptedCount
    },
    set failAttemptedDaily(value: boolean) {
      failAttemptedDaily = value
    },
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      const statement = {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          if (sql.includes('FROM analytics_conversion_deliveries')) {
            return {
              id: delivery.id,
              channel: delivery.channel,
              external_event_id: delivery.eventId,
              status: delivery.status,
              date: delivery.date,
              event_name: delivery.eventName,
            } as T
          }
          return null as T | null
        },
        async run() {
          calls.push(call)
          const state: ReceiptState = { delivery, dailyAttemptedCount, lastChanges: 1 }
          const result = execute(call, state)
          dailyAttemptedCount = state.dailyAttemptedCount
          return result
        },
      }
      Object.assign(statement, { __call: call })
      return statement
    },
    async batch(statements: Array<{ __call?: Call }>) {
      const staged: ReceiptState = { delivery: { ...delivery }, dailyAttemptedCount, lastChanges: 0 }
      const results = []
      for (const statement of statements) {
        if (!statement.__call) throw new Error('缺少 batch statement')
        calls.push(statement.__call)
        results.push(execute(statement.__call, staged))
      }
      Object.assign(delivery, staged.delivery)
      dailyAttemptedCount = staged.dailyAttemptedCount
      return results
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
  it('合法 Pixel pending 回执只首次标记 attempted 并聚合一次', async () => {
    const db = createPixelReceiptDb()
    const receiptToken = await createPixelReceiptToken('test-session-secret', {
      deliveryId: db.delivery.id,
      eventId: db.delivery.eventId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })

    const app = createApp()
    const request = () => app.request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: db.delivery.id, attempted: true, receiptToken }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)

    const first = await request()
    const replay = await request()

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect((await first.json()).data).toEqual({ deliveryId: db.delivery.id, attempted: true })
    expect((await replay.json()).data).toEqual({ deliveryId: db.delivery.id, attempted: false })
    expect(db.delivery.status).toBe('attempted')
    expect(db.dailyAttemptedCount).toBe(1)
  })

  it('请求 deliveryId 与 token claims 不一致时返回 PIXEL_RECEIPT_INVALID', async () => {
    const db = createPixelReceiptDb()
    const receiptToken = await createPixelReceiptToken('test-session-secret', {
      deliveryId: db.delivery.id,
      eventId: db.delivery.eventId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })
    const res = await createApp().request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'cdlv_other', attempted: true, receiptToken }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('PIXEL_RECEIPT_INVALID')
    expect(db.delivery.status).toBe('pending')
  })

  it('attempted 日报写入失败时回滚 delivery，重放同 token 可成功且只聚合一次', async () => {
    const db = createPixelReceiptDb({ failAttemptedDaily: true })
    const receiptToken = await createPixelReceiptToken('test-session-secret', {
      deliveryId: db.delivery.id,
      eventId: db.delivery.eventId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })
    const app = createApp()
    const request = () => app.request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: db.delivery.id, attempted: true, receiptToken }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)

    const failed = await request()
    expect(failed.status).toBe(400)
    expect((await failed.json()).code).toBe('PIXEL_RECEIPT_INVALID')
    expect(db.delivery.status).toBe('pending')
    expect(db.dailyAttemptedCount).toBe(0)

    db.failAttemptedDaily = false
    const retried = await request()
    const replay = await request()

    expect(db.delivery.status).toBe('attempted')
    expect(retried.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(db.dailyAttemptedCount).toBe(1)
  })

  it.each(['sent', 'failed', 'skipped', 'duplicate_suppressed'] as const)(
    '%s 状态返回 PIXEL_RECEIPT_INVALID',
    async status => {
      const db = createPixelReceiptDb({ status })
      const receiptToken = await createPixelReceiptToken('test-session-secret', {
        deliveryId: db.delivery.id,
        eventId: db.delivery.eventId,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      })
      const res = await createApp().request('/api/conversions/pixel-receipts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deliveryId: db.delivery.id, attempted: true, receiptToken }),
      }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)

      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('PIXEL_RECEIPT_INVALID')
    },
  )

  it('attempted=false 返回 PIXEL_RECEIPT_INVALID', async () => {
    const db = createPixelReceiptDb()
    const receiptToken = await createPixelReceiptToken('test-session-secret', {
      deliveryId: db.delivery.id,
      eventId: db.delivery.eventId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })
    const res = await createApp().request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attempted: false, deliveryId: db.delivery.id, receiptToken }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('PIXEL_RECEIPT_INVALID')
  })

  it('缺 receiptToken 或 deliveryId 返回 PIXEL_RECEIPT_INVALID', async () => {
    const db = createPixelReceiptDb()
    const receiptToken = await createPixelReceiptToken('test-session-secret', {
      deliveryId: db.delivery.id,
      eventId: db.delivery.eventId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })
    const app = createApp()
    const missingToken = await app.request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attempted: true, deliveryId: db.delivery.id }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const missingDelivery = await app.request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attempted: true, receiptToken }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)

    expect(missingToken.status).toBe(400)
    expect((await missingToken.json()).code).toBe('PIXEL_RECEIPT_INVALID')
    expect(missingDelivery.status).toBe(400)
    expect((await missingDelivery.json()).code).toBe('PIXEL_RECEIPT_INVALID')
  })

  it.each([
    ['CAPI delivery', createPixelReceiptDb({ channel: 'meta_capi' }), undefined],
    ['delivery 与 event ID 不匹配', createPixelReceiptDb({ eventId: 'meta:Contact:other' }), undefined],
    ['伪造 token', createPixelReceiptDb(), 'forged.token'],
    ['过期 token', createPixelReceiptDb(), 'expired'],
  ])('%s 返回 PIXEL_RECEIPT_INVALID', async (_label, db, tokenOverride) => {
    const receiptToken = tokenOverride === 'expired'
      ? await createPixelReceiptToken('test-session-secret', {
          deliveryId: db.delivery.id,
          eventId: db.delivery.eventId,
          expiresAt: Math.floor(Date.now() / 1000) - 1,
        })
      : tokenOverride ?? await createPixelReceiptToken('test-session-secret', {
          deliveryId: db.delivery.id,
          eventId: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        })
    const res = await createApp().request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: db.delivery.id, attempted: true, receiptToken }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('PIXEL_RECEIPT_INVALID')
    expect(db.delivery.status).toBe('pending')
    expect(db.dailyAttemptedCount).toBe(0)
  })

  it('Pixel 回执 malformed JSON 返回 PIXEL_RECEIPT_INVALID', async () => {
    const db = createPixelReceiptDb()
    const res = await createApp().request('/api/conversions/pixel-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('PIXEL_RECEIPT_INVALID')
  })

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

  it('公开接口接受注册完成', async () => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'complete_registration',
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
      }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data.actionType).toBe('complete_registration')
  })

  it('公开接口拒绝开始试用', async () => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: 'start_trial' }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('CONVERSION_ACTION_INVALID')
    expect(db.calls).toHaveLength(0)
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
