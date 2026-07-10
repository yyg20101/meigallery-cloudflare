import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { computeMetaRetryDelay, handleMetaCapiBatch } from './meta-capi-queue'

type DeliveryStatus = 'pending' | 'sent' | 'failed'

function createQueueDb(initialStatus: DeliveryStatus = 'pending', options: {
  beforeFirstCasStatus?: DeliveryStatus
  casFailures?: number
} = {}) {
  const delivery = {
    id: 'cdlv_1',
    conversion_action_id: 'conv_1',
    channel: 'meta_capi',
    external_event_id: 'event_1',
    event_name: 'Contact',
    status: initialStatus,
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: initialStatus === 'pending' ? 0 : 1,
    occurred_at: '2026-07-09T10:00:00.000Z',
    date: '2026-07-09',
    path: '/',
    metadata: '{}',
  }
  const daily = new Map<string, number>([[initialStatus, 1]])
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let lastChanges = 1
  let casCount = 0
  let remainingCasFailures = options.casFailures ?? 0

  const db = {
    delivery,
    daily,
    calls,
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
          if (sql.includes('FROM analytics_conversion_deliveries')) return { ...delivery } as T
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) return { value: JSON.stringify('1234567890') } as T
          return null
        },
        async run() {
          calls.push(call)
          return applyStatement(call)
        },
      }
      return statement
    },
    async batch(statements: Array<{ __call: { sql: string; params: unknown[] } }>) {
      const results = []
      for (const statement of statements) {
        calls.push(statement.__call)
        results.push(applyStatement(statement.__call))
      }
      return results
    },
  }

  function applyStatement(call: { sql: string; params: unknown[] }) {
    if (call.sql.includes('UPDATE analytics_conversion_deliveries')) {
      const changesStatus = /SET\s+status\s*=\s*\?/m.test(call.sql)
      if (casCount === 0 && options.beforeFirstCasStatus) forceStatus(options.beforeFirstCasStatus)
      casCount += 1
      if (remainingCasFailures > 0) {
        remainingCasFailures -= 1
        return result(0)
      }
      const expectedStatus = String(call.params[changesStatus ? 6 : 4])
      if (delivery.status !== expectedStatus || delivery.status === 'sent') return result(0)
      if (changesStatus) delivery.status = String(call.params[0]) as DeliveryStatus
      const offset = changesStatus ? 1 : 0
      delivery.skip_reason = String(call.params[offset] ?? '')
      delivery.error_code = String(call.params[offset + 1] ?? '')
      delivery.error_message = String(call.params[offset + 2] ?? '')
      delivery.attempt_count += 1
      return result(1)
    }
    if (!call.sql.includes('analytics_conversion_delivery_daily')) return result(1)
    const values = call.params.map(String)
    if (call.sql.includes('delivery_count + 1')) {
      if (lastChanges !== 1) return result(0)
      const status = call.sql.includes("'duplicate_suppressed'")
        ? 'duplicate_suppressed'
        : values.find(value => ['pending', 'sent', 'failed', 'duplicate_suppressed'].includes(value))
      if (status) daily.set(status, (daily.get(status) ?? 0) + 1)
      return result(1)
    }
    if (call.sql.includes('delivery_count - 1')) {
      if (lastChanges !== 1) return result(0)
      const status = values.find(value => ['pending', 'sent', 'failed'].includes(value))
      if (status) daily.set(status, Math.max(0, (daily.get(status) ?? 0) - 1))
      return result(1)
    }
    return result(1)
  }

  function forceStatus(status: DeliveryStatus) {
    for (const key of ['pending', 'failed', 'sent']) daily.set(key, 0)
    daily.set(status, 1)
    delivery.status = status
    delivery.skip_reason = ''
    delivery.error_code = status === 'failed' ? 'meta_http_500' : ''
    delivery.error_message = status === 'failed' ? 'Meta CAPI 请求失败' : ''
    delivery.attempt_count += 1
  }

  function result(changes: number) {
    lastChanges = changes
    return { meta: { changes, rows_written: changes, rows_read: 0, duration: 1 } }
  }

  return db
}

function message(attempts = 1) {
  const body: MetaCapiQueueMessage = {
    schemaVersion: 1,
    deliveryId: 'cdlv_1',
    userData: {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
    },
  }
  return { body, attempts, ack: vi.fn(), retry: vi.fn() }
}

function batch(queue: string, queueMessage: ReturnType<typeof message>) {
  return { queue, messages: [queueMessage] } as unknown as MessageBatch<MetaCapiQueueMessage>
}

function env(db: ReturnType<typeof createQueueDb>) {
  return {
    APP_ENV: 'test',
    SITE_URL: 'https://616618.xyz',
    META_CAPI_ACCESS_TOKEN: 'token_private',
    DB: db,
  } as unknown as Bindings
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Meta CAPI Queue', () => {
  it('主 Queue 对 retryable 错误按上限退避重试，DLQ 回写 retry_exhausted', async () => {
    expect([1, 2, 3, 4, 5, 6].map(computeMetaRetryDelay)).toEqual([60, 300, 900, 1800, 1800, 1800])

    const retryDb = createQueueDb()
    const retryMessage = message(1)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }))
    await handleMetaCapiBatch(batch('meigallery-meta-capi', retryMessage), env(retryDb))

    expect(retryMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(retryMessage.ack).not.toHaveBeenCalled()
    expect(retryDb.delivery).toMatchObject({ status: 'failed', attempt_count: 1 })
    expect(retryDb.daily.get('pending')).toBe(0)
    expect(retryDb.daily.get('failed')).toBe(1)

    const dlqDb = createQueueDb('failed')
    const dlqMessage = message(6)
    await handleMetaCapiBatch(batch('meigallery-meta-capi-dlq', dlqMessage), env(dlqDb))

    expect(dlqDb.delivery).toMatchObject({ status: 'failed', error_code: 'retry_exhausted' })
    expect(dlqDb.delivery.attempt_count).toBe(2)
    expect(dlqDb.daily.get('failed')).toBe(1)
    expect(dlqMessage.ack).toHaveBeenCalledOnce()
    expect(dlqMessage.retry).not.toHaveBeenCalled()
  })

  it('failed 重试成功时只把日报桶从 failed 移到 sent', async () => {
    const db = createQueueDb('failed')
    const queueMessage = message(3)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(queueMessage.ack).toHaveBeenCalledOnce()
    expect(db.delivery).toMatchObject({ status: 'sent', attempt_count: 2 })
    expect(db.daily.get('failed')).toBe(0)
    expect(db.daily.get('sent')).toBe(1)
  })

  it('Meta success 遇到 pending 到 failed 的 CAS 竞争时重读并确认 sent', async () => {
    const db = createQueueDb('pending', { beforeFirstCasStatus: 'failed' })
    const queueMessage = message(2)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(queueMessage.ack).toHaveBeenCalledOnce()
    expect(queueMessage.retry).not.toHaveBeenCalled()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('pending')).toBe(0)
    expect(db.daily.get('failed')).toBe(0)
    expect(db.daily.get('sent')).toBe(1)

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('sent')).toBe(1)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
  })

  it('Meta success 多次 CAS 竞争仍无法确认 sent 时 retry 而不 ack', async () => {
    const db = createQueueDb('pending', { casFailures: 3 })
    const queueMessage = message(2)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(queueMessage.ack).not.toHaveBeenCalled()
    expect(queueMessage.retry).toHaveBeenCalledWith({ delaySeconds: 300 })
    expect(db.delivery.status).toBe('pending')
  })

  it('永久失败与并发 sent 竞争时保持 sent 且不增加 failed 桶', async () => {
    const db = createQueueDb('pending', { beforeFirstCasStatus: 'sent' })
    const queueMessage = message(1)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 400 }))

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(queueMessage.ack).toHaveBeenCalledOnce()
    expect(queueMessage.retry).not.toHaveBeenCalled()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('sent')).toBe(1)
    expect(db.daily.get('failed')).toBe(0)
  })

  it('逐条处理消息，永久失败 ack、retryable 错误仅重试对应消息', async () => {
    const db = createQueueDb()
    const permanent = message(1)
    const retryable = { ...message(2), body: { ...message(2).body, deliveryId: 'cdlv_2' } }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockRejectedValueOnce(new Error('token_private|fb.1.private'))

    await handleMetaCapiBatch({
      queue: 'meigallery-meta-capi',
      messages: [permanent, retryable],
    } as unknown as MessageBatch<MetaCapiQueueMessage>, env(db))

    expect(permanent.ack).toHaveBeenCalledOnce()
    expect(permanent.retry).not.toHaveBeenCalled()
    expect(retryable.ack).not.toHaveBeenCalled()
    expect(retryable.retry).toHaveBeenCalledWith({ delaySeconds: 300 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('已 sent delivery 不调用 fetch、不降级，只增加 duplicate_suppressed 诊断并 ack', async () => {
    const db = createQueueDb('sent')
    const sentBefore = db.daily.get('sent')
    const queueMessage = message(2)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(queueMessage.ack).toHaveBeenCalledOnce()
    expect(queueMessage.retry).not.toHaveBeenCalled()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('sent')).toBe(sentBefore)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
  })

  it('错误日志不包含 token 或 Queue 临时 userData', async () => {
    const db = createQueueDb()
    const queueMessage = message()
    const sensitive = `${queueMessage.body.userData.fbp}|${queueMessage.body.userData.fbc}|${queueMessage.body.userData.clientIpAddress}|${queueMessage.body.userData.clientUserAgent}|token_private`
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(sensitive))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('token_private')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(queueMessage.body.userData.fbp)
    expect(JSON.stringify(db.calls)).not.toContain('token_private')
    expect(JSON.stringify(db.calls)).not.toContain(queueMessage.body.userData.fbp)
  })
})
