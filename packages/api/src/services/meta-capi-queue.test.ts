import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversionDeliveryStatus, MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { computeMetaRetryDelay, handleMetaCapiBatch, recoverPendingMetaCapiDeliveries } from './meta-capi-queue'

type DeliveryStatus = ConversionDeliveryStatus

function createQueueDb(initialStatus: DeliveryStatus = 'pending', options: {
  beforeFirstCasStatus?: DeliveryStatus
  casFailures?: number
  eventName?: string
} = {}) {
  const delivery = {
    id: 'cdlv_1',
    conversion_action_id: 'conv_1',
    channel: 'meta_capi',
    external_event_id: 'event_1',
    event_name: options.eventName ?? 'Contact',
    status: initialStatus,
    skip_reason: initialStatus === 'skipped'
      ? 'missing_secret'
      : initialStatus === 'duplicate_suppressed' ? 'already_sent' : '',
    error_code: '',
    error_message: '',
    attempt_count: initialStatus === 'pending' ? 0 : 1,
    tracking_mode: 'production' as const,
    queue_enqueued_at: null as string | null,
    queue_attempt_count: 0,
    duplicate_suppressed_at: null as string | null,
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
      if (call.sql.includes('duplicate_suppressed_at')) {
        if (delivery.status !== 'sent' || delivery.duplicate_suppressed_at) return result(0)
        delivery.duplicate_suppressed_at = '2026-07-10 00:00:00'
        return result(1)
      }
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
      if (call.sql.includes('WHERE changes() = 1') && lastChanges !== 1) return result(0)
      const status = call.sql.includes("'duplicate_suppressed'")
        ? 'duplicate_suppressed'
        : values.find(value => ['pending', 'sent', 'failed', 'duplicate_suppressed'].includes(value))
      if (status) daily.set(status, (daily.get(status) ?? 0) + 1)
      return result(1)
    }
    if (call.sql.includes('delivery_count - 1')) {
      if (lastChanges !== 1) return result(0)
      const status = values.find(value => ['pending', 'attempted', 'sent', 'failed', 'skipped', 'duplicate_suppressed'].includes(value))
      if (status) daily.set(status, Math.max(0, (daily.get(status) ?? 0) - 1))
      return result(1)
    }
    return result(1)
  }

  function forceStatus(status: DeliveryStatus) {
    for (const key of ['pending', 'attempted', 'failed', 'skipped', 'duplicate_suppressed', 'sent']) daily.set(key, 0)
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

function createRecoveryDb(options: {
  failFirstEnqueuedMark?: boolean
  rejectClaim?: boolean
  rejectClaimWithRowsWritten?: boolean
  failQueueDiagnostic?: boolean
  eventName?: string
} = {}) {
  const delivery = {
    id: 'cdlv_recovery',
    event_name: options.eventName ?? 'Contact',
    status: 'pending',
    queue_enqueued_at: null as string | null,
    queue_attempt_count: 0,
    updated_at: '2026-07-09 00:00:00',
    error_code: '',
  }
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let enqueuedMarkFailures = options.failFirstEnqueuedMark ? 1 : 0
  const db = {
    delivery,
    calls,
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          const hasActiveFilter = sql.includes("event_name IN ('Contact', 'CompleteRegistration')")
          const eventAllowed = !hasActiveFilter || ['Contact', 'CompleteRegistration'].includes(delivery.event_name)
          const rows = delivery.status === 'pending' && !delivery.queue_enqueued_at && eventAllowed
            ? [{ id: delivery.id }]
            : []
          return { results: rows as T[] }
        },
        async run() {
          calls.push(call)
          if (sql.includes('queue_attempt_count = queue_attempt_count + 1')) {
            if (options.rejectClaimWithRowsWritten) return { meta: { rows_written: 0 } }
            if (options.rejectClaim) return { meta: { changes: 0 } }
            if (delivery.status !== 'pending' || delivery.queue_enqueued_at) return { meta: { changes: 0 } }
            delivery.queue_attempt_count += 1
            delivery.updated_at = '2026-07-10 00:00:00'
            return { meta: { changes: 1 } }
          }
          if (sql.includes('queue_enqueued_at = datetime')) {
            if (enqueuedMarkFailures > 0) {
              enqueuedMarkFailures -= 1
              throw new Error('模拟 Queue 成功后 D1 标记失败')
            }
            delivery.queue_enqueued_at = '2026-07-10 00:00:01'
            delivery.error_code = ''
            return { meta: { changes: 1 } }
          }
          if (sql.includes("error_code = 'queue_send_failed'")) {
            if (options.failQueueDiagnostic) throw new Error('模拟 Queue 诊断补记失败')
            delivery.error_code = 'queue_send_failed'
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
      }
    },
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
  it.each(['Lead', 'StartTrial'])('直接历史 %s Queue message 被安全终止且不请求 Meta', async eventName => {
    const db = createQueueDb('pending', { eventName })
    const queueMessage = message()
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(queueMessage.ack).toHaveBeenCalledOnce()
    expect(queueMessage.retry).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'unsupported_event' })
  })

  it.each(['Lead', 'StartTrial'])('scheduled recovery 不扫描历史 %s delivery', async eventName => {
    const db = createRecoveryDb({ eventName })
    const send = vi.fn()

    const result = await recoverPendingMetaCapiDeliveries({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send } as unknown as Queue<MetaCapiQueueMessage>,
    })

    expect(result).toEqual({ scanned: 0, enqueued: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
    const scan = db.calls.find(call => call.sql.includes('SELECT id'))
    expect(scan?.sql).toContain("event_name IN ('Contact', 'CompleteRegistration')")
  })

  it('scheduled 恢复提交后 send 前终止的 pending delivery，且不持久化或重放匹配数据', async () => {
    const db = createRecoveryDb()
    const sent: MetaCapiQueueMessage[] = []
    const result = await recoverPendingMetaCapiDeliveries({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send: async message => { sent.push(message) } } as Queue<MetaCapiQueueMessage>,
    })

    expect(result).toMatchObject({ scanned: 1, enqueued: 1, failed: 0 })
    expect(sent).toEqual([{ schemaVersion: 1, deliveryId: db.delivery.id, userData: {} }])
    expect(db.delivery).toMatchObject({ queue_attempt_count: 1, error_code: '' })
    expect(db.delivery.queue_enqueued_at).not.toBeNull()
    const scan = db.calls.find(call => call.sql.includes('SELECT id') && call.sql.includes('analytics_conversion_deliveries'))
    expect(scan?.sql).toContain("datetime('now', '-5 minutes')")
    expect(Number(scan?.params.at(-1))).toBeLessThanOrEqual(50)
  })

  it('Queue send 失败后保持 pending，下一次 scheduled 可恢复', async () => {
    const db = createRecoveryDb()
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('敏感异常不应落库'))
      .mockResolvedValueOnce(undefined)
    const recoveryEnv = {
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send } as unknown as Queue<MetaCapiQueueMessage>,
    }

    const failed = await recoverPendingMetaCapiDeliveries(recoveryEnv)
    expect(failed).toMatchObject({ scanned: 1, enqueued: 0, failed: 1 })
    expect(db.delivery).toMatchObject({ status: 'pending', queue_attempt_count: 1, error_code: 'queue_send_failed' })

    db.delivery.updated_at = '2026-07-09 00:00:00'
    const recovered = await recoverPendingMetaCapiDeliveries(recoveryEnv)
    expect(recovered).toMatchObject({ scanned: 1, enqueued: 1, failed: 0 })
    expect(db.delivery.queue_attempt_count).toBe(2)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('Queue send 成功但 D1 标记失败时允许使用相同 deliveryId 幂等重投', async () => {
    const db = createRecoveryDb({ failFirstEnqueuedMark: true })
    const sent: MetaCapiQueueMessage[] = []
    const recoveryEnv = {
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send: async message => { sent.push(message) } } as Queue<MetaCapiQueueMessage>,
    }

    const first = await recoverPendingMetaCapiDeliveries(recoveryEnv)
    expect(first).toMatchObject({ scanned: 1, enqueued: 0, failed: 1 })
    expect(db.delivery.queue_enqueued_at).toBeNull()

    db.delivery.updated_at = '2026-07-09 00:00:00'
    const second = await recoverPendingMetaCapiDeliveries(recoveryEnv)
    expect(second).toMatchObject({ scanned: 1, enqueued: 1, failed: 0 })
    expect(sent).toHaveLength(2)
    expect(sent[0]?.deliveryId).toBe(sent[1]?.deliveryId)
    expect(sent.every(item => Object.keys(item.userData).length === 0)).toBe(true)
  })

  it('缺少 Queue binding 时保守失败且不认领 pending delivery', async () => {
    const db = createRecoveryDb()

    const result = await recoverPendingMetaCapiDeliveries({ DB: db as unknown as D1Database })

    expect(result).toEqual({ scanned: 0, enqueued: 0, failed: 0, reason: 'missing_queue' })
    expect(db.calls).toEqual([])
    expect(db.delivery.queue_attempt_count).toBe(0)
  })

  it('scheduled 扫描后 CAS 未认领时不发送也不计失败', async () => {
    const db = createRecoveryDb({ rejectClaim: true })
    const send = vi.fn()

    const result = await recoverPendingMetaCapiDeliveries({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send } as unknown as Queue<MetaCapiQueueMessage>,
    })

    expect(result).toEqual({ scanned: 1, enqueued: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('D1 未返回 changes 时使用 rows_written 判断 CAS 未认领', async () => {
    const db = createRecoveryDb({ rejectClaimWithRowsWritten: true })
    const send = vi.fn()

    const result = await recoverPendingMetaCapiDeliveries({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send } as unknown as Queue<MetaCapiQueueMessage>,
    })

    expect(result).toEqual({ scanned: 1, enqueued: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('Queue send 与诊断补记同时失败时仍保留恢复入口且不泄露异常', async () => {
    const db = createRecoveryDb({ failQueueDiagnostic: true })

    const result = await recoverPendingMetaCapiDeliveries({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send: async () => { throw new Error('private queue error') } } as unknown as Queue<MetaCapiQueueMessage>,
    })

    expect(result).toEqual({ scanned: 1, enqueued: 0, failed: 1 })
    expect(db.delivery).toMatchObject({ status: 'pending', queue_enqueued_at: null })
    expect(JSON.stringify(db.calls)).not.toContain('private queue error')
  })

  it('主 Queue 对 retryable 错误按上限退避重试，DLQ 回写 retry_exhausted', async () => {
    expect([1, 2, 3, 4, 5, 6].map(computeMetaRetryDelay)).toEqual([60, 300, 900, 1800, 1800, 1800])
    expect(computeMetaRetryDelay(Number.NaN)).toBe(60)

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

  it.each(['skipped', 'attempted'] as const)('DLQ 将历史 %s 状态原子转为 failed/retry_exhausted 后 ack', async initialStatus => {
    const db = createQueueDb(initialStatus)
    const dlqMessage = message(6)

    await handleMetaCapiBatch(batch('meigallery-meta-capi-dlq', dlqMessage), env(db))

    expect(db.delivery).toMatchObject({ status: 'failed', error_code: 'retry_exhausted' })
    expect(db.daily.get(initialStatus)).toBe(0)
    expect(db.daily.get('failed')).toBe(1)
    expect(dlqMessage.ack).toHaveBeenCalledOnce()
    expect(dlqMessage.retry).not.toHaveBeenCalled()
  })

  it('DLQ CAS 失败后发现 sent 时不降级，只记重投诊断并 ack', async () => {
    const db = createQueueDb('skipped', { beforeFirstCasStatus: 'sent' })
    const dlqMessage = message(6)

    await handleMetaCapiBatch(batch('meigallery-meta-capi-dlq', dlqMessage), env(db))

    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('sent')).toBe(1)
    expect(db.daily.get('failed')).toBe(0)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
    expect(dlqMessage.ack).toHaveBeenCalledOnce()
    expect(dlqMessage.retry).not.toHaveBeenCalled()
  })

  it('DLQ 直接收到已 sent delivery 时重复消费也只记一次 duplicate_suppressed', async () => {
    const db = createQueueDb('sent')
    const dlqMessage = message(6)

    await handleMetaCapiBatch(batch('meigallery-meta-capi-dlq', dlqMessage), env(db))
    await handleMetaCapiBatch(batch('meigallery-meta-capi-dlq', dlqMessage), env(db))

    expect(dlqMessage.ack).toHaveBeenCalledTimes(2)
    expect(dlqMessage.retry).not.toHaveBeenCalled()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
  })

  it('DLQ 对任意非 sent 状态连续 CAS 冲突耗尽时 retry，不 ack 假成功', async () => {
    const db = createQueueDb('skipped', { casFailures: 3 })
    const dlqMessage = message(6)

    await handleMetaCapiBatch(batch('meigallery-meta-capi-dlq', dlqMessage), env(db))

    expect(db.delivery.status).toBe('skipped')
    expect(dlqMessage.ack).not.toHaveBeenCalled()
    expect(dlqMessage.retry).toHaveBeenCalledWith({ delaySeconds: 1800 })
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

  it('已 sent delivery 多次消费不调用 fetch、不降级，duplicate_suppressed 日报只增加一次', async () => {
    const db = createQueueDb('sent')
    const sentBefore = db.daily.get('sent')
    const queueMessage = message(2)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))
    await handleMetaCapiBatch(batch('meigallery-meta-capi', queueMessage), env(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(queueMessage.ack).toHaveBeenCalledTimes(2)
    expect(queueMessage.retry).not.toHaveBeenCalled()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('sent')).toBe(sentBefore)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
    expect(db.delivery.duplicate_suppressed_at).not.toBeNull()
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
