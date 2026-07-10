import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { ActiveMetaEventName, ConversionSkipReason } from '@meigallery/shared'
import type { Bindings } from '../index'
import {
  MetaCapiDeliveryError,
  buildMetaCapiPayload,
  classifyMetaCapiError,
  createMetaCapiTestDelivery,
  sendMetaCapiEvent,
  type MetaCapiPayloadInput,
} from './meta-capi'

type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'duplicate_suppressed'
type DeliveryRow = {
  id: string
  conversion_action_id: string
  channel: string
  external_event_id: string
  event_name: string
  status: DeliveryStatus
  skip_reason: string
  error_code: string
  error_message: string
  attempt_count: number
  tracking_mode: 'disabled' | 'test' | 'production'
  duplicate_suppressed_at: string | null
  last_attempt_at: string | null
  sent_at: string | null
  date: string
  occurred_at: string
  path: string
  metadata: string
}

function createMetaCapiDb(options: {
  pixelId?: string
  delivery?: Partial<DeliveryRow>
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const delivery: DeliveryRow = {
    id: 'cdlv_1',
    conversion_action_id: 'conv_1',
    channel: 'meta_capi',
    external_event_id: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
    event_name: 'Contact',
    status: 'pending',
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 0,
    tracking_mode: 'production',
    duplicate_suppressed_at: null,
    last_attempt_at: null,
    sent_at: null,
    date: '2026-07-09',
    occurred_at: '2026-07-09T10:00:00.000Z',
    path: '/gallery/demo',
    metadata: JSON.stringify({ method_type: 'telegram', email: 'user@example.test' }),
    ...options.delivery,
  }
  const daily: Array<Record<string, unknown>> = []
  const db = {
    calls,
    delivery,
    daily,
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] }
      const statement = {
        __call: call,
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('JOIN analytics_conversion_actions')) {
            return call.params[0] === delivery.id ? ({ ...delivery } as T) : null
          }
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) {
            return options.pixelId ? ({ value: options.pixelId } as T) : null
          }
          return null
        },
        async all<T>() {
          calls.push(call)
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          if (sql.includes('UPDATE analytics_conversion_deliveries')) {
            const changesStatus = /SET\s+status\s*=\s*\?/m.test(sql)
            if (changesStatus) delivery.status = String(call.params[0]) as DeliveryStatus
            const offset = changesStatus ? 1 : 0
            delivery.skip_reason = String(call.params[offset] ?? '')
            delivery.error_code = String(call.params[offset + 1] ?? '')
            delivery.error_message = String(call.params[offset + 2] ?? '')
            delivery.attempt_count += 1
            if (delivery.status === 'sent') delivery.sent_at = 'now'
          }
          if (sql.includes('INSERT INTO analytics_conversion_delivery_daily')) {
            daily.push({
              date: call.params[0],
              channel: call.params[1],
              event_name: call.params[2],
              status: call.params[3],
              skip_reason: call.params[4],
            })
          }
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<D1Result<unknown>> }>) {
      return Promise.all(statements.map(statement => statement.run()))
    },
  }
  return db
}

function createConcurrentSuccessDb() {
  const delivery = {
    id: 'cdlv_concurrent',
    conversion_action_id: 'conv_concurrent',
    channel: 'meta_capi',
    external_event_id: 'event_concurrent',
    event_name: 'Contact',
    status: 'pending' as DeliveryStatus,
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 0,
    tracking_mode: 'production' as const,
    duplicate_suppressed_at: null as string | null,
    last_attempt_at: null,
    sent_at: null as string | null,
    date: '2026-07-10',
    occurred_at: '2026-07-10T00:00:00.000Z',
    path: '/',
    metadata: '{}',
  }
  const daily = new Map<string, number>([['pending', 1]])
  const db = {
    delivery,
    daily,
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params
          return this
        },
        async first<T>() {
          if (sql.includes('FROM analytics_conversion_deliveries')) return { ...delivery } as T
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) return { value: JSON.stringify('1234567890') } as T
          return null
        },
        async run() {
          return applyStatement(statement, 1).result
        },
      }
      return statement
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      let lastChanges = 1
      return statements.map(statement => {
        const applied = applyStatement(statement, lastChanges)
        lastChanges = applied.changes
        return applied.result
      })
    },
  }

  function applyStatement(statement: { sql: string; params: unknown[] }, lastChanges: number) {
    const { sql, params } = statement
    let changes = 1
    if (sql.includes('UPDATE analytics_conversion_deliveries')) {
      if (sql.includes('duplicate_suppressed_at')) {
        changes = delivery.status === 'sent' && !delivery.duplicate_suppressed_at ? 1 : 0
        if (changes) delivery.duplicate_suppressed_at = '2026-07-10 00:00:02'
      } else {
        const expectedStatus = String(params[6])
        changes = delivery.status === expectedStatus && delivery.status !== 'sent' ? 1 : 0
        if (changes) {
          delivery.status = String(params[0]) as DeliveryStatus
          delivery.skip_reason = String(params[1] ?? '')
          delivery.error_code = String(params[2] ?? '')
          delivery.error_message = String(params[3] ?? '')
          delivery.attempt_count += 1
          if (delivery.status === 'sent') delivery.sent_at = '2026-07-10 00:00:01'
        }
      }
    } else if (sql.includes('analytics_conversion_delivery_daily')) {
      changes = sql.includes('WHERE changes() = 1') && lastChanges !== 1 ? 0 : 1
      if (changes && sql.includes('delivery_count + 1')) {
        const status = sql.includes("'duplicate_suppressed'") ? 'duplicate_suppressed' : String(params[3])
        daily.set(status, (daily.get(status) ?? 0) + 1)
      } else if (changes && sql.includes('delivery_count - 1')) {
        const status = String(params[3])
        daily.set(status, Math.max(0, (daily.get(status) ?? 0) - 1))
      }
    }
    return {
      changes,
      result: { meta: { changes, rows_written: changes, rows_read: 0, duration: 1 } },
    }
  }

  return db
}

function envFor(db: ReturnType<typeof createMetaCapiDb>, overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'test',
    SITE_URL: 'https://616618.xyz',
    META_CAPI_ACCESS_TOKEN: 'token_1',
    DB: db,
    ...overrides,
  } as unknown as Pick<Bindings, 'APP_ENV' | 'SITE_URL' | 'META_CAPI_ACCESS_TOKEN' | 'DB'>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('meta-capi', () => {
  it('共享跳过原因包含历史事件安全终态', () => {
    const reason: ConversionSkipReason = 'unsupported_event'

    expect(reason).toBe('unsupported_event')
  })

  it('CAPI payload 事件名使用活动 Meta 事件类型', () => {
    expectTypeOf<MetaCapiPayloadInput['eventName']>().toEqualTypeOf<ActiveMetaEventName>()
  })

  it('payload 只包含白名单字段', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'Contact',
      eventId: 'event_1',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      userData: { fbp: 'fb.1.1', fbc: 'fb.1.2' },
      customData: { method_type: 'telegram', email: 'user@example.test' },
    })
    expect(JSON.stringify(payload)).toContain('telegram')
    expect(JSON.stringify(payload)).not.toContain('user@example.test')
  })

  it('custom_data 只保留白名单内的有效字符串、有限数字和布尔值', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'CompleteRegistration',
      eventId: 'event_typed_custom_data',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      customData: {
        method_type: 42,
        action_type: true,
        content_category: '  portrait  ',
        location: Number.POSITIVE_INFINITY,
        content_name: '   ',
        unknown_field: 'secret',
      },
    })

    expect(payload.data[0]?.custom_data).toEqual({
      method_type: 42,
      action_type: true,
      content_category: 'portrait',
    })
  })

  it('Meta 4xx 不重试，5xx 和 429 重试', () => {
    expect(classifyMetaCapiError(400)).toBe('permanent')
    expect(classifyMetaCapiError(500)).toBe('retryable')
    expect(classifyMetaCapiError(429)).toBe('retryable')
  })

  it.each(['Contact', 'CompleteRegistration'] as const)('test 模式 %s 强制附带环境 Test Event Code', async eventName => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { event_name: eventName, tracking_mode: 'test' },
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db, { META_CAPI_TEST_EVENT_CODE: 'test-code-from-env' } as Partial<Bindings>), 'cdlv_1', {
      fetchFn,
      testEventCode: 'caller-must-not-override-mode',
    })

    const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].event_name).toBe(eventName)
    expect(payload.test_event_code).toBe('test-code-from-env')
  })

  it.each(['Lead', 'StartTrial'])('历史 %s delivery 在 fetch 前进入 unsupported_event 安全终态', async eventName => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { event_name: eventName },
    })
    const fetchFn = vi.fn()

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', { fetchFn })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'skipped', reason: 'unsupported_event' })
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'unsupported_event' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('test 模式缺少 Test Event Code 时 fail closed 且绝不请求 Graph', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { tracking_mode: 'test' },
    })
    const fetchFn = vi.fn()

    const result = await sendMetaCapiEvent(envFor(db, { META_CAPI_TEST_EVENT_CODE: '  ' } as Partial<Bindings>), 'cdlv_1', {
      fetchFn,
      testEventCode: 'caller-code-is-not-trusted',
    })

    expect(result).toEqual({ deliveryId: 'cdlv_1', status: 'skipped', reason: 'missing_test_event_code' })
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'missing_test_event_code' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('production 模式即使环境和调用参数有 Test Event Code 也绝不附带', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { tracking_mode: 'production' },
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db, { META_CAPI_TEST_EVENT_CODE: 'environment-test-code' } as Partial<Bindings>), 'cdlv_1', {
      fetchFn,
      testEventCode: 'caller-test-code',
    })

    const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    expect(payload).not.toHaveProperty('test_event_code')
  })

  it('Owner direct Test Event delivery 在入账时固化 test tracking mode', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const call = { sql, params: [] as unknown[] }
        return {
          bind(...params: unknown[]) {
            call.params = params
            return this
          },
          async run() {
            calls.push(call)
            return { meta: { changes: 1 } }
          },
        }
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(statements.map(statement => statement.run()))
      },
    } as unknown as D1Database

    await createMetaCapiTestDelivery(db, {
      conversionId: 'conv_test',
      deliveryId: 'cdlv_test',
      externalEventId: 'event_test',
      occurredAt: '2026-07-10T00:00:00.000Z',
      date: '2026-07-10',
      adminId: 1,
    })

    const deliveryInsert = calls.find(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))
    expect(deliveryInsert?.sql).toContain('tracking_mode')
    expect(deliveryInsert?.sql).toContain("'test'")
  })

  it('缺少 access token 时标记 skipped/missing_secret', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { path: 'https://evil.example/private?token=secret' },
    })
    await sendMetaCapiEvent(envFor(db, { META_CAPI_ACCESS_TOKEN: '' } as Partial<Bindings>), 'cdlv_1')

    expect(db.delivery.status).toBe('skipped')
    expect(db.delivery.skip_reason).toBe('missing_secret')
    expect(db.daily[0]).toMatchObject({ status: 'skipped', skip_reason: 'missing_secret' })
  })

  it('缺少 Pixel ID 时标记 skipped/missing_pixel_id', async () => {
    const db = createMetaCapiDb()
    await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    expect(db.delivery.status).toBe('skipped')
    expect(db.delivery.skip_reason).toBe('missing_pixel_id')
  })

  it('Meta 仅在 v25.0 返回 events_received=1 时标记 sent 且不泄露 token', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { path: 'https://evil.example/private?token=secret' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    expect(result.status).toBe('sent')
    expect(result.eventsReceived).toBe(1)
    expect(db.delivery.status).toBe('sent')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/v25.0/1234567890/events')
    expect(String(url)).toContain('access_token=')
    const payload = JSON.parse(String(init?.body))
    expect(payload.data[0].event_source_url).toBe('https://616618.xyz/')
    expect(JSON.stringify(init)).not.toContain('token_1')
    expect(JSON.stringify(init)).not.toContain('evil.example')
    expect(JSON.stringify(init)).not.toContain('user@example.test')
  })

  it('两个 pending 消息并发成功时后完成者只记一次 duplicate_suppressed，第三次重投不再增加', async () => {
    const db = createConcurrentSuccessDb()
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const fetchFn = vi.fn(async () => {
      arrived += 1
      if (arrived === 2) release()
      await barrier
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    })
    const concurrentEnv = envFor(db as unknown as ReturnType<typeof createMetaCapiDb>)

    const results = await Promise.all([
      sendMetaCapiEvent(concurrentEnv, db.delivery.id, { fetchFn }),
      sendMetaCapiEvent(concurrentEnv, db.delivery.id, { fetchFn }),
    ])
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
    expect(db.delivery.duplicate_suppressed_at).not.toBeNull()

    const third = await sendMetaCapiEvent(concurrentEnv, db.delivery.id, { fetchFn })

    expect(results.map(result => result.status)).toEqual(['sent', 'sent'])
    expect(third).toMatchObject({ status: 'duplicate_suppressed', reason: 'already_sent' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(db.delivery).toMatchObject({ status: 'sent', attempt_count: 1 })
    expect(db.daily.get('pending')).toBe(0)
    expect(db.daily.get('sent')).toBe(1)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
    expect(db.delivery.duplicate_suppressed_at).not.toBeNull()
  })

  it('不从 D1 metadata 恢复 fbp 或 fbc', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { metadata: JSON.stringify({ method_type: 'telegram', fbp: 'fb.1.private', fbc: 'fb.1.private' }) },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({})
    expect(JSON.stringify(payload)).not.toContain('fb.1.private')
  })

  it('仅使用 Queue 临时 userData 构造 Meta CAPI 匹配字段', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      userData: {
        fbp: 'fb.1.1700000000000.123456789',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        clientIpAddress: '203.0.113.24',
        clientUserAgent: 'MeiGallery Test Browser/1.0',
      },
    })

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      client_ip_address: '203.0.113.24',
      client_user_agent: 'MeiGallery Test Browser/1.0',
    })
  })

  it('消费异常 Queue userData 时丢弃无效字段', () => {
    const payload = buildMetaCapiPayload({
      eventName: 'Contact',
      eventId: 'event_1',
      eventTime: 1783600800,
      eventSourceUrl: 'https://616618.xyz/',
      actionSource: 'website',
      userData: {
        fbp: 'bad\nvalue',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        clientIpAddress: `${'1'.repeat(65)}\n`,
        clientUserAgent: 'browser\nagent',
      },
    })

    expect(payload.data[0].user_data).toEqual({ fbc: 'fb.1.1700000000000.CLICK_abc-123' })
  })

  it('Meta 5xx 标记 failed 后抛错交给 Queue 重试', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const sensitive = 'fb.1.1700000000000.123456789|fb.1.1700000000000.CLICK_abc-123|203.0.113.24|MeiGallery Test Browser/1.0|token_private'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sensitive, { status: 500 }))

    await expect(sendMetaCapiEvent(envFor(db), 'cdlv_1')).rejects.toMatchObject({
      message: 'Meta CAPI 请求失败',
      retryable: true,
      code: 'meta_http_500',
    })
    expect(db.delivery.status).toBe('failed')
    expect(db.delivery.error_code).toBe('meta_http_500')
    expect(db.delivery.error_message).toBe('Meta CAPI 请求失败')
    expect(JSON.stringify(db.calls)).not.toContain(sensitive)
  })

  it('Meta 2xx 但 events_received=0 时记录永久失败', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events_received: 0,
      fbtrace_id: 'trace_1',
    }), { status: 200 }))

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1', { fetchFn })

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'events_not_received',
      eventsReceived: 0,
      traceId: 'trace_1',
    })
    expect(db.delivery).toMatchObject({
      status: 'failed',
      error_code: 'meta_events_not_received',
      error_message: 'Meta CAPI 请求失败',
    })
  })

  it('确定性 4xx 与 2xx/0 不抛可重试错误', async () => {
    const badRequestDb = createMetaCapiDb({ pixelId: '1234567890' })
    const badRequest = await sendMetaCapiEvent(envFor(badRequestDb), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status: 400 })),
    })
    expect(badRequest).toMatchObject({ status: 'failed', reason: '400' })

    const emptySuccessDb = createMetaCapiDb({ pixelId: '1234567890' })
    await expect(sendMetaCapiEvent(envFor(emptySuccessDb), 'cdlv_1', {
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 0 }), { status: 200 })),
    })).resolves.toMatchObject({ status: 'failed', eventsReceived: 0 })
  })

  it('网络错误与 8 秒可注入超时都转为固定脱敏 retryable 错误', async () => {
    const sensitive = 'token_1|fb.1.private|203.0.113.24|private-browser'
    const networkDb = createMetaCapiDb({ pixelId: '1234567890' })
    const networkPromise = sendMetaCapiEvent(envFor(networkDb), 'cdlv_1', {
      fetchFn: vi.fn().mockRejectedValue(new Error(sensitive)),
      userData: {
        fbp: 'fb.1.private',
        clientIpAddress: '203.0.113.24',
        clientUserAgent: 'private-browser',
      },
    })

    const networkError = await networkPromise.catch(error => error as MetaCapiDeliveryError)
    expect(networkError).toMatchObject({
      message: 'Meta CAPI 请求失败',
      code: 'meta_network_error',
      retryable: true,
    })
    expect(JSON.stringify(networkError)).not.toContain(sensitive)
    expect(JSON.stringify(networkError)).not.toContain('token_1')
    expect(JSON.stringify(networkError)).not.toContain('fb.1.private')

    const timeoutDb = createMetaCapiDb({ pixelId: '1234567890' })
    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const timeoutError = await sendMetaCapiEvent(envFor(timeoutDb), 'cdlv_1', {
      fetchFn: timeoutFetch,
      timeoutMs: 5,
    }).catch(error => error as MetaCapiDeliveryError)

    expect(timeoutError).toMatchObject({
      message: 'Meta CAPI 请求超时',
      code: 'meta_timeout',
      retryable: true,
    })
    expect(timeoutFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('组合超时保留调用方 abort signal', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const caller = new AbortController()
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const sending = sendMetaCapiEvent(envFor(db), 'cdlv_1', {
      fetchFn,
      signal: caller.signal,
      timeoutMs: 8_000,
    })

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
    caller.abort()

    await expect(sending).rejects.toMatchObject({ retryable: true, code: 'meta_network_error' })
    expect(fetchFn.mock.calls[0]?.[1]?.signal).not.toBe(caller.signal)
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
