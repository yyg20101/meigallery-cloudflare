import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import type { Bindings } from './index'
import type { MetaCapiQueueMessage } from '@meigallery/shared'
import { encryptMetaCapiContext, loadMetaCapiCryptoKeys } from './utils/meta-capi-crypto'

const DATA_KEY = Buffer.alloc(32, 7).toString('base64')
const META_TOKEN_FINGERPRINT = '0b7a8749b34fd009cf020b30ea6bde2defee9e24b5f1c191764d60b8c1de9f31'
const META_CONNECTION_REVISION = '1'.repeat(32)

function env(corsOrigin?: string) {
  return {
    APP_ENV: 'production',
    RELEASE_COMMIT: 'a'.repeat(40),
    CORS_ORIGIN: corsOrigin,
    DB: {
      prepare() {
        return { first: async () => ({ ok: 1 }) }
      },
    },
  } as unknown as Bindings
}

describe('API CORS 安全配置', () => {
  it('生产环境未配置 CORS_ORIGIN 时不反射任意 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', {
      headers: { Origin: 'https://evil.example' },
    }), env(), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('支持多个明确允许的生产 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', {
      headers: { Origin: 'https://www.616618.xyz' },
    }), env('https://616618.xyz,https://www.616618.xyz'), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.616618.xyz')
  })
})

describe('Meta CAPI Queue consumer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('解密 Queue V2 envelope 后构造 CAPI payload 并确认消息', async () => {
    const delivery = {
      id: 'cdlv_1',
      conversion_action_id: 'conv_1',
      channel: 'meta_capi',
      external_event_id: 'event_1',
      event_name: 'Contact',
      status: 'pending',
      skip_reason: '',
      error_code: '',
      error_message: '',
      attempt_count: 0,
      tracking_mode: 'production',
      meta_connection_revision: META_CONNECTION_REVISION,
      duplicate_suppressed_at: null,
      encryption_key_id: '',
      created_at: new Date().toISOString(),
      occurred_at: '2026-07-09T10:00:00.000Z',
      date: '2026-07-09',
      path: '/',
      metadata: '{}',
    }
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return this },
          async first<T>() {
            if (sql.includes('FROM analytics_conversion_deliveries')) return delivery as T
            if (sql.includes("WHERE key = 'facebook_pixel_id'")) return { value: JSON.stringify('1234567890') } as T
            if (sql.includes("WHERE key = 'meta_tracking_mode'")) return { value: JSON.stringify('production') } as T
            if (sql.includes('FROM meta_connection_verifications')) {
              return {
                environment: 'dev',
                pixel_id: '1234567890',
                token_fingerprint: META_TOKEN_FINGERPRINT,
                graph_api_version: 'v25.0',
                verified_event_name: 'Contact',
                verified_commit: 'a'.repeat(40),
                dataset_quality_status: 'not_checked',
                verified_at: '2026-07-11T00:00:00.000Z',
                verified_by_user_id: 1,
                invalidated_at: null,
                invalidation_reason: '',
                revision: META_CONNECTION_REVISION,
              } as T
            }
            return null as T | null
          },
          async run() { return { meta: { changes: 1 } } },
        }
        return statement
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(statements.map(statement => statement.run()))
      },
    }
    const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: DATA_KEY })
    const sealed = await encryptMetaCapiContext({
      keys,
      aad: {
        deliveryId: delivery.id,
        externalEventId: delivery.external_event_id,
        eventName: 'Contact',
      },
      value: {
        fbp: 'fb.1.1700000000000.123456789',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        clientIpAddress: '203.0.113.24',
        clientUserAgent: 'MeiGallery Test Browser/1.0',
      },
    })
    delivery.encryption_key_id = sealed.keyId
    const body: MetaCapiQueueMessage = {
      schemaVersion: 2,
      deliveryId: delivery.id,
      envelope: {
        keyId: sealed.keyId,
        iv: sealed.iv,
        ciphertext: sealed.ciphertext,
        tag: sealed.tag,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }
    const message = { body, ack: vi.fn(), retry: vi.fn() }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await app.queue({ queue: 'meigallery-meta-capi', messages: [message] } as unknown as MessageBatch<MetaCapiQueueMessage>, {
      APP_ENV: 'dev',
      SITE_URL: 'https://616618.xyz',
      META_CAPI_ACCESS_TOKEN: 'token_1',
      META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
      RELEASE_COMMIT: 'a'.repeat(40),
      DB: db,
    } as unknown as Bindings)

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user_data).toEqual({
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      client_ip_address: '203.0.113.24',
      client_user_agent: 'MeiGallery Test Browser/1.0',
    })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()

    const sensitive = 'fb.1.1700000000000.123456789|fb.1.1700000000000.CLICK_abc-123|203.0.113.24|MeiGallery Test Browser/1.0|token_private'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fetchMock.mockRejectedValueOnce(new Error(sensitive))
    await app.queue({ queue: 'meigallery-meta-capi', messages: [message] } as unknown as MessageBatch<MetaCapiQueueMessage>, {
      APP_ENV: 'dev',
      SITE_URL: 'https://616618.xyz',
      META_CAPI_ACCESS_TOKEN: 'token_1',
      META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
      RELEASE_COMMIT: 'a'.repeat(40),
      DB: db,
    } as unknown as Bindings)

    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sensitive)
    expect(message.retry).toHaveBeenCalledOnce()
  })
})

describe('Meta CAPI scheduled recovery', () => {
  function createScheduledHarness() {
    const sent: MetaCapiQueueMessage[] = []
    const sqlCalls: string[] = []
    const envelope = {
      keyId: '0123456789abcdef',
      iv: 'AQIDBAUGBwgJCgsM',
      ciphertext: 'c2VjdXJlLWNpcGhlcnRleHQ',
      tag: 'AQIDBAUGBwgJCgsMDQ4PEA',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }
    const db = {
      prepare(sql: string) {
        sqlCalls.push(sql)
        return {
          bind() { return this },
          async first() {
            if (sql.includes('FROM meta_capi_secure_outbox')) {
              return {
                delivery_id: 'cdlv_stale',
                schema_version: 2,
                key_id: envelope.keyId,
                iv: envelope.iv,
                ciphertext: envelope.ciphertext,
                tag: envelope.tag,
                expires_at: envelope.expiresAt,
                status: 'pending',
                skip_reason: '',
                error_code: '',
                queue_enqueued_at: null,
                queue_attempt_count: 0,
                updated_at: '2026-07-10 00:00:00',
                date: '2026-07-10',
                event_name: 'Contact',
              }
            }
            return null
          },
          async all<T>() {
            return {
              results: (sql.includes('queue_enqueued_at IS NULL') ? [{ id: 'cdlv_stale' }] : []) as T[],
            }
          },
          async run() { return { meta: { changes: 1 } } },
        }
      },
    }
    let scheduledWork: Promise<unknown> | undefined
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        scheduledWork = promise
      },
    } as unknown as ExecutionContext
    const scheduledEnv = {
      APP_ENV: 'production',
      DB: db,
      META_CAPI_QUEUE: {
        async send(message: MetaCapiQueueMessage) {
          sent.push(message)
        },
      },
    } as unknown as Bindings

    return {
      sent,
      sqlCalls,
      expectedMessage: { schemaVersion: 2, deliveryId: 'cdlv_stale', envelope } as MetaCapiQueueMessage,
      async run(cron: string, scheduledTime = Date.parse('2026-07-10T09:00:00.000Z')) {
        await app.scheduled({ cron, scheduledTime } as ScheduledEvent, scheduledEnv, ctx)
        await scheduledWork
      },
    }
  }

  it('每 5 分钟 Cron 只恢复 outbox，不运行每日聚合或清理', async () => {
    const harness = createScheduledHarness()

    await harness.run('*/5 * * * *')

    expect(harness.sent).toEqual([harness.expectedMessage])
    expect(harness.sqlCalls.some(sql => sql.includes('email_verification_codes'))).toBe(false)
    expect(harness.sqlCalls.some(sql => sql.includes('analytics_daily_sources'))).toBe(false)
    expect(harness.sqlCalls.some(sql => sql.includes('analytics_events WHERE sampled'))).toBe(false)
  })

  it('每日 Cron 同时恢复 outbox 并运行完整聚合与保留期清理', async () => {
    const harness = createScheduledHarness()

    await harness.run('0 0 * * *')

    expect(harness.sent).toEqual([harness.expectedMessage])
    expect(harness.sqlCalls.some(sql => sql.includes('email_verification_codes'))).toBe(true)
    expect(harness.sqlCalls.some(sql => sql.includes('analytics_daily_sources'))).toBe(true)
    expect(harness.sqlCalls.some(sql => sql.includes('analytics_events WHERE sampled'))).toBe(true)
  })

  it('未知 Cron 保守只恢复 outbox', async () => {
    const harness = createScheduledHarness()

    await harness.run('13 * * * *')

    expect(harness.sent).toEqual([harness.expectedMessage])
    expect(harness.sqlCalls.some(sql => sql.includes('email_verification_codes'))).toBe(false)
    expect(harness.sqlCalls.some(sql => sql.includes('analytics_daily_sources'))).toBe(false)
  })

  it('注册事实修复只在 5 分钟 Cron 的整点运行，每小时最多一次', async () => {
    const wholeHour = createScheduledHarness()
    const otherMinute = createScheduledHarness()

    await wholeHour.run('*/5 * * * *', Date.parse('2026-07-10T09:00:00.000Z'))
    await otherMinute.run('*/5 * * * *', Date.parse('2026-07-10T09:05:00.000Z'))

    expect(wholeHour.sqlCalls.some(sql => sql.includes('FROM users u'))).toBe(true)
    expect(otherMinute.sqlCalls.some(sql => sql.includes('FROM users u'))).toBe(false)
    expect(wholeHour.sent).toEqual([wholeHour.expectedMessage])
  })
})
