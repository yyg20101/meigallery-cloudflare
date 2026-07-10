import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings, Variables } from '../index'
import { createPixelReceiptToken } from '../utils/pixel-receipt'
import { conversionRoutes } from './conversions'

type Call = { sql: string; params: unknown[] }
const DATA_KEY = Buffer.alloc(32, 7).toString('base64')
const RELEASE_COMMIT = 'a'.repeat(40)
const TOKEN_FINGERPRINT = '0b7a8749b34fd009cf020b30ea6bde2defee9e24b5f1c191764d60b8c1de9f31'
const CONNECTION_REVISION = '1'.repeat(32)

function createConversionDb(options: {
  metaCapiEnabled?: boolean
  facebookPixelId?: string
  metaTrackingMode?: 'disabled' | 'test' | 'production'
} = {}) {
  const calls: Call[] = []
  let delivery: { id: string; status: string; queueEnqueuedAt: string | null; eventName: string } | null = null
  let outbox: { deliveryId: string; keyId: string; iv: string; ciphertext: string; tag: string; expiresAt: string } | null = null
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
          if (sql.includes("WHERE key = 'meta_capi_enabled'")) return { value: String(options.metaCapiEnabled === true) } as T
          if (sql.includes("WHERE key = 'facebook_pixel_enabled'")) return { value: 'false' } as T
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) return options.facebookPixelId ? ({ value: JSON.stringify(options.facebookPixelId) } as T) : null
          if (sql.includes("WHERE key = 'meta_tracking_mode'")) return { value: JSON.stringify(options.metaTrackingMode ?? 'disabled') } as T
          if (sql.includes('FROM meta_connection_verifications')) {
            return {
              environment: 'dev',
              pixel_id: options.facebookPixelId ?? '1234567890',
              token_fingerprint: TOKEN_FINGERPRINT,
              graph_api_version: 'v25.0',
              verified_event_name: 'Contact',
              verified_commit: RELEASE_COMMIT,
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: 1,
              invalidated_at: null,
              invalidation_reason: '',
              revision: CONNECTION_REVISION,
            } as T
          }
          if (sql.includes('FROM meta_capi_secure_outbox') && outbox && delivery) {
            return {
              delivery_id: outbox.deliveryId,
              schema_version: 2,
              key_id: outbox.keyId,
              iv: outbox.iv,
              ciphertext: outbox.ciphertext,
              tag: outbox.tag,
              expires_at: outbox.expiresAt,
              status: delivery.status,
              skip_reason: '',
              error_code: '',
              queue_enqueued_at: delivery.queueEnqueuedAt,
              queue_attempt_count: 0,
              updated_at: '2026-07-10 00:00:00',
              date: '2026-07-10',
              event_name: delivery.eventName,
            } as T
          }
          return null as T | null
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          if (sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries')) {
            delivery = {
              id: String(call.params[0]),
              status: String(call.params[5]),
              queueEnqueuedAt: null,
              eventName: String(call.params[4]),
            }
          } else if (sql.includes('INSERT INTO meta_capi_secure_outbox')) {
            outbox = {
              deliveryId: String(call.params[0]),
              keyId: String(call.params[2]),
              iv: String(call.params[3]),
              ciphertext: String(call.params[4]),
              tag: String(call.params[5]),
              expiresAt: String(call.params[6]),
            }
          } else if (sql.includes('queue_attempt_count = queue_attempt_count + 1')) {
            return { meta: { changes: delivery?.status === 'pending' && outbox ? 1 : 0 } }
          } else if (sql.includes('queue_enqueued_at = datetime') && delivery) {
            delivery.queueEnqueuedAt = '2026-07-11 00:00:00'
          } else if (sql.includes('DELETE FROM meta_capi_secure_outbox')) {
            outbox = null
          }
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
    if (call.sql.includes('UPDATE analytics_conversion_deliveries')) {
      if (state.delivery.status !== 'pending') {
        state.lastChanges = 0
        return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      }
      state.delivery.status = 'attempted'
      state.lastChanges = 1
      return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
    }
    if (call.sql.includes('INSERT INTO analytics_conversion_delivery_daily')) {
      if (failAttemptedDaily) throw new Error('模拟 attempted 日报写入失败')
      if (state.lastChanges === 1 && call.params[3] === 'attempted') state.dailyAttemptedCount += 1
      state.lastChanges = state.lastChanges === 1 ? 1 : 0
      return { meta: { changes: state.lastChanges, rows_written: state.lastChanges, rows_read: 0, duration: 1 } }
    }
    if (call.sql.includes('UPDATE analytics_conversion_delivery_daily')) {
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
        visitorId: 'conversion_visitor_test_user_1',
        sessionId: 'conversion_session_test_user_1',
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

  it.each([
    ['visitorId 为空', { visitorId: '', sessionId: 'session_123456' }],
    ['sessionId 为空', { visitorId: 'visitor_123456', sessionId: '' }],
    ['visitorId 格式非法', { visitorId: 'bad id!', sessionId: 'session_123456' }],
    ['sessionId 格式非法', { visitorId: 'visitor_123456', sessionId: 'x' }],
  ])('%s 时明确返回 400', async (_label, identity) => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'contact',
        occurredAt: '2026-07-09T10:00:00.000Z',
        ...identity,
      }),
    }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONVERSION_ID_INVALID')
    expect(db.calls).toHaveLength(0)
  })

  it('只接受顶层 browserIdentifiers，并将合法临时数据传入 Queue 而不持久化原值', async () => {
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })
    const sent: MetaCapiQueueMessage[] = []
    const raw = {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
    }
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': raw.clientIpAddress,
        'User-Agent': raw.clientUserAgent,
      },
      body: JSON.stringify({
        actionType: 'contact',
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
        consentState: 'granted',
        methodType: 'telegram',
        actionTarget: 'floating_contact_panel',
        browserIdentifiers: { fbp: raw.fbp, fbc: raw.fbc },
        metadata: { fbp: 'metadata-fbp', fbc: 'metadata-fbc' },
      }),
    }, {
      DB: db,
      APP_ENV: 'dev',
      SESSION_SECRET: 'test-session-secret',
      META_CAPI_ACCESS_TOKEN: 'token_1',
      META_CAPI_TEST_EVENT_CODE: 'test-code',
      RELEASE_COMMIT,
      META_CAPI_QUEUE: { send: async (message: MetaCapiQueueMessage) => { sent.push(message) } },
      META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    } as unknown as Bindings)

    expect(res.status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      schemaVersion: 2,
      envelope: {
        keyId: expect.stringMatching(/^[0-9a-f]{16}$/),
        ciphertext: expect.any(String),
      },
    })
    expect(JSON.stringify(sent)).not.toContain(raw.fbp)
    expect(JSON.stringify(sent)).not.toContain(raw.fbc)
    expect(JSON.stringify(sent)).not.toContain(raw.clientIpAddress)
    expect(JSON.stringify(sent)).not.toContain(raw.clientUserAgent)
    expect(JSON.stringify(db.calls)).not.toContain(raw.fbp)
    expect(JSON.stringify(db.calls)).not.toContain(raw.fbc)
    expect(JSON.stringify(db.calls)).not.toContain(raw.clientIpAddress)
    expect(JSON.stringify(db.calls)).not.toContain(raw.clientUserAgent)
    expect(JSON.stringify(db.calls)).not.toContain('metadata-fbp')
    expect(JSON.stringify(await res.clone().json())).not.toContain(raw.fbp)
    expect(JSON.stringify(await res.clone().json())).not.toContain(raw.fbc)
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

  it.each(['complete_registration', 'lead', 'start_trial'])(
    '公开接口拒绝 %s',
    async actionType => {
    const db = createConversionDb()
    const res = await createApp().request('/api/conversions/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType,
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        occurredAt: '2026-07-09T10:00:00.000Z',
        methodType: 'telegram',
        actionTarget: 'floating_contact_panel',
      }),
    }, { DB: db, APP_ENV: 'test', SESSION_SECRET: 'test-session-secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe('CONVERSION_ACTION_INVALID')
    expect(db.calls).toHaveLength(0)
    },
  )

  it.each([
    ['methodType', { actionTarget: 'floating_contact_panel' }],
    ['actionTarget', { methodType: 'telegram' }],
  ])('联系缺少 %s 时拒绝无口径事件', async (_field, context) => {
      const db = createConversionDb()
      const res = await createApp().request('/api/conversions/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionType: 'contact',
          visitorId: 'visitor_1',
          sessionId: 'session_1',
          occurredAt: '2026-07-09T10:00:00.000Z',
          ...context,
        }),
      }, { DB: db, APP_ENV: 'test' } as unknown as Bindings)

      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('CONVERSION_CONTACT_CONTEXT_INVALID')
      expect(db.calls).toHaveLength(0)
    })
})
