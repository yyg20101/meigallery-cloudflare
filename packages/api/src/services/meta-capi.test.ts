import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../index'
import { buildMetaCapiPayload, classifyMetaCapiError, sendMetaCapiEvent } from './meta-capi'

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
      return {
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
            delivery.status = String(call.params[0]) as DeliveryStatus
            delivery.skip_reason = String(call.params[1] ?? '')
            delivery.error_code = String(call.params[2] ?? '')
            delivery.error_message = String(call.params[3] ?? '')
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
    },
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

  it('Meta 4xx 不重试，5xx 和 429 重试', () => {
    expect(classifyMetaCapiError(400)).toBe('permanent')
    expect(classifyMetaCapiError(500)).toBe('retryable')
    expect(classifyMetaCapiError(429)).toBe('retryable')
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

  it('Meta 2xx 返回时标记 sent 并不泄露 token', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { path: 'https://evil.example/private?token=secret' },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    const result = await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    expect(result.status).toBe('sent')
    expect(db.delivery.status).toBe('sent')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/1234567890/events')
    expect(String(url)).toContain('access_token=')
    const payload = JSON.parse(String(init?.body))
    expect(payload.data[0].event_source_url).toBe('https://616618.xyz/')
    expect(JSON.stringify(init)).not.toContain('token_1')
    expect(JSON.stringify(init)).not.toContain('evil.example')
    expect(JSON.stringify(init)).not.toContain('user@example.test')
  })

  it('不从 D1 metadata 恢复 fbp 或 fbc', async () => {
    const db = createMetaCapiDb({
      pixelId: '1234567890',
      delivery: { metadata: JSON.stringify({ method_type: 'telegram', fbp: 'fb.1.private', fbc: 'fb.1.private' }) },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await sendMetaCapiEvent(envFor(db), 'cdlv_1')

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({})
    expect(JSON.stringify(payload)).not.toContain('fb.1.private')
  })

  it('仅使用 Queue 临时 userData 构造 Meta CAPI 匹配字段', async () => {
    const db = createMetaCapiDb({ pixelId: '1234567890' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

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

    await expect(sendMetaCapiEvent(envFor(db), 'cdlv_1')).rejects.toThrow('Meta CAPI retryable')
    expect(db.delivery.status).toBe('failed')
    expect(db.delivery.error_code).toBe('meta_http_500')
    expect(db.delivery.error_message).toBe('Meta CAPI 请求失败')
    expect(JSON.stringify(db.calls)).not.toContain(sensitive)
  })
})
