import { describe, expect, it, vi } from 'vitest'
import type { MetaCapiEncryptedEnvelope, MetaCapiQueueMessage } from '@meigallery/shared'
import {
  createSecureOutboxStatement,
  enqueueSecureMetaCapiDelivery,
  purgeExpiredMetaCapiOutbox,
} from './meta-capi-secure-outbox'

type Call = { sql: string; params: unknown[] }

type Delivery = {
  id: string
  status: string
  skipReason: string
  errorCode: string
  queueEnqueuedAt: string | null
  queueAttemptCount: number
  updatedAt: string
  date: string
  eventName: string
  deliveryLeaseToken: string
  deliveryLeaseExpiresAt: string | null
}

type Outbox = MetaCapiEncryptedEnvelope & {
  deliveryId: string
  schemaVersion: number
  expiresAt: string
}

const ENVELOPE: MetaCapiEncryptedEnvelope = {
  keyId: '0123456789abcdef',
  iv: 'AQIDBAUGBwgJCgsM',
  ciphertext: 'c2VjdXJlLWNpcGhlcnRleHQ',
  tag: 'AQIDBAUGBwgJCgsMDQ4PEA',
  expiresAt: '2099-01-02T00:00:00.000Z',
}

function createOutboxDb(options: {
  failBatchOn?: string
  failCleanupBatches?: number
  deliveries?: Delivery[]
  outboxes?: Outbox[]
  beforeExpireBatch?: (state: {
    deliveries: Map<string, Delivery>
    daily: Map<string, number>
  }) => void
} = {}) {
  const actions = new Set<string>()
  const deliveries = new Map((options.deliveries ?? []).map(item => [item.id, { ...item }]))
  const outboxes = new Map((options.outboxes ?? []).map(item => [item.deliveryId, { ...item }]))
  const daily = new Map<string, number>()
  for (const row of deliveries.values()) {
    const key = dailyKey(row.status, row.skipReason)
    daily.set(key, (daily.get(key) ?? 0) + 1)
  }
  const calls: Call[] = []
  let cleanupFailures = options.failCleanupBatches ?? 0
  let expireHookCalled = false

  const db = {
    actions,
    deliveries,
    outboxes,
    daily,
    calls,
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      return {
        __call: call,
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_conversion_deliveries')) {
            const delivery = deliveries.get(String(call.params[0]))
            return delivery ? { status: delivery.status, error_code: delivery.errorCode } as T : null
          }
          if (!sql.includes('FROM meta_capi_secure_outbox')) return null
          const deliveryId = String(call.params[0])
          const outbox = outboxes.get(deliveryId)
          const delivery = deliveries.get(deliveryId)
          if (!outbox || !delivery) return null
          return {
            delivery_id: deliveryId,
            schema_version: outbox.schemaVersion,
            key_id: outbox.keyId,
            iv: outbox.iv,
            ciphertext: outbox.ciphertext,
            tag: outbox.tag,
            expires_at: outbox.expiresAt,
            status: delivery.status,
            skip_reason: delivery.skipReason,
            error_code: delivery.errorCode,
            queue_enqueued_at: delivery.queueEnqueuedAt,
            queue_attempt_count: delivery.queueAttemptCount,
            updated_at: delivery.updatedAt,
            date: delivery.date,
            event_name: delivery.eventName,
          } as T
        },
        async all<T>() {
          calls.push(call)
          const limit = Number(call.params[0] ?? 100)
          const rows = Array.from(outboxes.values())
            .filter(row => Date.parse(row.expiresAt) <= Date.now())
            .slice(0, limit)
            .map(row => {
              const delivery = deliveries.get(row.deliveryId)
              return {
                delivery_id: row.deliveryId,
                status: delivery?.status ?? '',
                skip_reason: delivery?.skipReason ?? '',
                error_code: delivery?.errorCode ?? '',
                date: delivery?.date ?? '',
                event_name: delivery?.eventName ?? '',
              }
            })
          return { results: rows as T[] }
        },
        async run() {
          calls.push(call)
          return apply(call, { actions, deliveries, outboxes, daily }, 1)
        },
      }
    },
    async batch(statements: Array<{ __call: Call }>) {
      const isExpireBatch = statements.some(statement => /SET\s+status\s*=\s*\?/m.test(statement.__call.sql))
      if (isExpireBatch && !expireHookCalled) {
        expireHookCalled = true
        options.beforeExpireBatch?.({ deliveries, daily })
      }
      const staged = {
        actions: new Set(actions),
        deliveries: new Map(Array.from(deliveries, ([id, value]) => [id, { ...value }])),
        outboxes: new Map(Array.from(outboxes, ([id, value]) => [id, { ...value }])),
        daily: new Map(daily),
      }
      const isCleanup = statements.some(statement => statement.__call.sql.includes('queue_enqueued_at = datetime'))
      if (isCleanup && cleanupFailures > 0) {
        cleanupFailures -= 1
        throw new Error('模拟入队后 D1 batch 失败')
      }
      const results = []
      let lastChanges = 1
      for (const statement of statements) {
        calls.push(statement.__call)
        if (options.failBatchOn && statement.__call.sql.includes(options.failBatchOn)) {
          throw new Error('模拟 D1 batch statement 失败')
        }
        const applied = apply(statement.__call, staged, lastChanges)
        results.push(applied)
        lastChanges = applied.meta.changes
      }
      actions.clear()
      staged.actions.forEach(id => actions.add(id))
      deliveries.clear()
      staged.deliveries.forEach((value, id) => deliveries.set(id, value))
      outboxes.clear()
      staged.outboxes.forEach((value, id) => outboxes.set(id, value))
      daily.clear()
      staged.daily.forEach((value, key) => daily.set(key, value))
      return results
    },
  }

  function apply(
    call: Call,
    target: {
      actions: Set<string>
      deliveries: Map<string, Delivery>
      outboxes: Map<string, Outbox>
      daily: Map<string, number>
    },
    lastChanges: number,
  ) {
    if (call.sql.includes('INSERT INTO analytics_conversion_actions')) {
      target.actions.add(String(call.params[0]))
    } else if (call.sql.includes('INSERT INTO analytics_conversion_deliveries')) {
      const id = String(call.params[0])
      target.deliveries.set(id, delivery(id))
    } else if (call.sql.includes('INSERT INTO meta_capi_secure_outbox')) {
      const [deliveryId, schemaVersion, keyId, iv, ciphertext, tag, expiresAt] = call.params
      target.outboxes.set(String(deliveryId), {
        deliveryId: String(deliveryId),
        schemaVersion: Number(schemaVersion),
        keyId: String(keyId),
        iv: String(iv),
        ciphertext: String(ciphertext),
        tag: String(tag),
        expiresAt: String(expiresAt),
      })
    } else if (call.sql.includes('queue_attempt_count = queue_attempt_count + 1')) {
      const row = target.deliveries.get(String(call.params[0]))
      if (!row || row.status !== 'pending' || row.queueEnqueuedAt || !target.outboxes.has(row.id)) return result(0)
      if (row.queueAttemptCount !== Number(call.params[1])) return result(0)
      row.queueAttemptCount += 1
      row.updatedAt = new Date().toISOString()
    } else if (call.sql.includes('queue_enqueued_at = datetime')) {
      const row = target.deliveries.get(String(call.params[0]))
      if (row) row.queueEnqueuedAt = '2026-07-11 00:00:00'
    } else if (call.sql.includes("error_code = 'queue_send_failed'")) {
      const row = target.deliveries.get(String(call.params[0]))
      if (row) row.errorCode = 'queue_send_failed'
    } else if (call.sql.includes("error_code = 'missing_queue'")) {
      const row = target.deliveries.get(String(call.params[0]))
      if (row) row.errorCode = 'missing_queue'
    } else if (call.sql.includes('DELETE FROM meta_capi_secure_outbox')) {
      target.outboxes.delete(String(call.params[0]))
    } else if (call.sql.includes('UPDATE analytics_conversion_deliveries') && /SET\s+status\s*=\s*\?/m.test(call.sql)) {
      const row = target.deliveries.get(String(call.params[5]))
      const expectedStatus = String(call.params[6])
      const expectedSkipReason = String(call.params[7] ?? '')
      const expectedErrorCode = String(call.params[8] ?? '')
      if (!row || row.status === 'sent' || row.status !== expectedStatus) return result(0)
      if (call.sql.includes('AND skip_reason = ?') && row.skipReason !== expectedSkipReason) return result(0)
      if (call.sql.includes('AND error_code = ?') && row.errorCode !== expectedErrorCode) return result(0)
      if (call.sql.includes("delivery_lease_token = ''")
        && row.deliveryLeaseToken
        && Date.parse(row.deliveryLeaseExpiresAt || '') > Date.now()) return result(0)
      row.status = 'skipped'
      row.skipReason = 'secure_context_expired'
      row.errorCode = ''
      return result(1)
    } else if (call.sql.includes('INSERT INTO analytics_conversion_delivery_daily')) {
      if (call.sql.includes('WHERE changes() = 1') && lastChanges !== 1) return result(0)
      const key = dailyKey('skipped', 'secure_context_expired')
      target.daily.set(key, (target.daily.get(key) ?? 0) + 1)
      return result(1)
    } else if (call.sql.includes('UPDATE analytics_conversion_delivery_daily')) {
      if (call.sql.includes('AND changes() = 1') && lastChanges !== 1) return result(0)
      const key = dailyKey(String(call.params[2]), String(call.params[3] ?? ''))
      target.daily.set(key, Math.max(0, (target.daily.get(key) ?? 0) - 1))
      return result(1)
    }
    return result(1)
  }

  return db
}

function delivery(id = 'cdlv_1', overrides: Partial<Delivery> = {}): Delivery {
  return {
    id,
    status: 'pending',
    skipReason: '',
    errorCode: '',
    queueEnqueuedAt: null,
    queueAttemptCount: 0,
    updatedAt: '2026-07-10 00:00:00',
    date: '2026-07-10',
    eventName: 'Contact',
    deliveryLeaseToken: '',
    deliveryLeaseExpiresAt: null,
    ...overrides,
  }
}

function outbox(deliveryId = 'cdlv_1', overrides: Partial<Outbox> = {}): Outbox {
  return { deliveryId, schemaVersion: 2, ...ENVELOPE, ...overrides }
}

function result(changes: number) {
  return { meta: { changes, rows_written: changes, rows_read: 0, duration: 1 } }
}

function dailyKey(status: string, skipReason = '') {
  return `${status}:${skipReason}`
}

describe('Meta CAPI secure outbox', () => {
  it('业务事实、delivery 与密文 outbox 在同一 D1 batch 原子提交', async () => {
    const db = createOutboxDb({ failBatchOn: 'meta_capi_secure_outbox' })
    const action = db.prepare('INSERT INTO analytics_conversion_actions (id) VALUES (?)').bind('conv_1')
    const capiDelivery = db.prepare('INSERT INTO analytics_conversion_deliveries (id) VALUES (?)').bind('cdlv_1')
    const secureOutbox = createSecureOutboxStatement(db as unknown as D1Database, {
      deliveryId: 'cdlv_1',
      envelope: { schemaVersion: 2, ...ENVELOPE },
      expiresAt: ENVELOPE.expiresAt,
    })

    await expect(db.batch([action, capiDelivery, secureOutbox] as never)).rejects.toThrow()
    expect(db.actions.size).toBe(0)
    expect(db.deliveries.size).toBe(0)
    expect(db.outboxes.size).toBe(0)
  })

  it('只发送 V2 密文消息，成功后原子标记入队并删除 D1 密文', async () => {
    const db = createOutboxDb({ deliveries: [delivery()], outboxes: [outbox()] })
    const sent: MetaCapiQueueMessage[] = []
    const sensitive = [
      '203.0.113.24',
      'MeiGallery Test Browser/1.0',
      'fb.1.1700000000000.123456789',
      'fb.1.1700000000000.CLICK_abc-123',
      'a'.repeat(64),
      'b'.repeat(64),
    ]

    const outcome = await enqueueSecureMetaCapiDelivery({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send: async message => { sent.push(message) } } as Queue<MetaCapiQueueMessage>,
    }, 'cdlv_1')

    expect(outcome).toBe('enqueued')
    expect(sent).toEqual([{ schemaVersion: 2, deliveryId: 'cdlv_1', envelope: ENVELOPE }])
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(['deliveryId', 'envelope', 'schemaVersion'])
    expect(sensitive.every(value => !JSON.stringify(sent).includes(value))).toBe(true)
    expect(db.deliveries.get('cdlv_1')?.queueEnqueuedAt).not.toBeNull()
    expect(db.outboxes.has('cdlv_1')).toBe(false)
  })

  it('Queue 失败保留密文，成功但清理 batch 失败时允许恢复重发同一 envelope', async () => {
    const db = createOutboxDb({
      deliveries: [delivery()],
      outboxes: [outbox()],
      failCleanupBatches: 1,
    })
    const sent: MetaCapiQueueMessage[] = []
    const queue = {
      send: vi.fn(async (message: MetaCapiQueueMessage) => {
        sent.push(message)
      }),
    } as unknown as Queue<MetaCapiQueueMessage>

    await expect(enqueueSecureMetaCapiDelivery({ DB: db as unknown as D1Database, META_CAPI_QUEUE: {
      send: vi.fn().mockRejectedValueOnce(new Error('private queue failure')),
    } as unknown as Queue<MetaCapiQueueMessage> }, 'cdlv_1')).resolves.toBe('failed')
    expect(db.outboxes.has('cdlv_1')).toBe(true)

    db.deliveries.get('cdlv_1')!.updatedAt = '2026-07-10 00:00:00'
    await expect(enqueueSecureMetaCapiDelivery({ DB: db as unknown as D1Database, META_CAPI_QUEUE: queue }, 'cdlv_1')).resolves.toBe('failed')
    expect(db.outboxes.has('cdlv_1')).toBe(true)

    db.deliveries.get('cdlv_1')!.updatedAt = '2026-07-10 00:00:00'
    await expect(enqueueSecureMetaCapiDelivery({ DB: db as unknown as D1Database, META_CAPI_QUEUE: queue }, 'cdlv_1')).resolves.toBe('enqueued')
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual(sent[1])
    expect(db.outboxes.has('cdlv_1')).toBe(false)
  })

  it('并发 enqueue 只允许一个调用认领同一 outbox', async () => {
    const db = createOutboxDb({ deliveries: [delivery()], outboxes: [outbox()] })
    const send = vi.fn().mockResolvedValue(undefined)
    const secureEnv = {
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send } as unknown as Queue<MetaCapiQueueMessage>,
    }

    const outcomes = await Promise.all([
      enqueueSecureMetaCapiDelivery(secureEnv, 'cdlv_1'),
      enqueueSecureMetaCapiDelivery(secureEnv, 'cdlv_1'),
    ])

    expect(outcomes.sort()).toEqual(['enqueued', 'not_pending'])
    expect(send).toHaveBeenCalledOnce()
  })

  it('过期 outbox 不发送，并原子终止非终态 delivery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createOutboxDb({
      deliveries: [delivery()],
      outboxes: [outbox('cdlv_1', { expiresAt: '2026-07-11T11:59:59.000Z' })],
    })
    const send = vi.fn()

    const outcome = await enqueueSecureMetaCapiDelivery({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send } as unknown as Queue<MetaCapiQueueMessage>,
    }, 'cdlv_1')

    expect(outcome).toBe('expired')
    expect(send).not.toHaveBeenCalled()
    expect(db.deliveries.get('cdlv_1')).toMatchObject({ status: 'skipped', skipReason: 'secure_context_expired' })
    expect(db.outboxes.has('cdlv_1')).toBe(false)
    vi.useRealTimers()
  })

  it('purge 读取 retryable failed 后遇到并发永久失败时不覆盖状态或搬移日报', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createOutboxDb({
      deliveries: [delivery('cdlv_1', { status: 'failed', errorCode: 'meta_http_500' })],
      outboxes: [outbox('cdlv_1', { expiresAt: '2026-07-11T00:00:00.000Z' })],
      beforeExpireBatch: ({ deliveries }) => {
        deliveries.get('cdlv_1')!.errorCode = 'meta_http_400'
      },
    })

    const outcome = await purgeExpiredMetaCapiOutbox(db as unknown as D1Database)

    expect(outcome).toEqual({ purged: 1, skipped: 0 })
    expect(db.deliveries.get('cdlv_1')).toMatchObject({ status: 'failed', errorCode: 'meta_http_400' })
    expect(db.daily.get(dailyKey('failed'))).toBe(1)
    expect(db.daily.get(dailyKey('skipped', 'secure_context_expired')) ?? 0).toBe(0)
    expect(db.outboxes.has('cdlv_1')).toBe(false)
    const transition = db.calls.find(call => /SET\s+status\s*=\s*\?/m.test(call.sql))
    expect(transition?.sql).toContain('AND error_code = ?')
    vi.useRealTimers()
  })

  it('purge 读取 pending 后遇到并发 skipped 时保留新终态及其日报', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createOutboxDb({
      deliveries: [delivery()],
      outboxes: [outbox('cdlv_1', { expiresAt: '2026-07-11T00:00:00.000Z' })],
      beforeExpireBatch: ({ deliveries, daily }) => {
        const row = deliveries.get('cdlv_1')!
        row.status = 'skipped'
        row.skipReason = 'missing_secret'
        daily.set(dailyKey('pending'), 0)
        daily.set(dailyKey('skipped', 'missing_secret'), 1)
      },
    })

    const outcome = await purgeExpiredMetaCapiOutbox(db as unknown as D1Database)

    expect(outcome).toEqual({ purged: 1, skipped: 0 })
    expect(db.deliveries.get('cdlv_1')).toMatchObject({ status: 'skipped', skipReason: 'missing_secret' })
    expect(db.daily.get(dailyKey('pending'))).toBe(0)
    expect(db.daily.get(dailyKey('skipped', 'missing_secret'))).toBe(1)
    expect(db.daily.get(dailyKey('skipped', 'secure_context_expired')) ?? 0).toBe(0)
    expect(db.outboxes.has('cdlv_1')).toBe(false)
    vi.useRealTimers()
  })

  it('purge 遇到 active delivery lease 时不终止 delivery 且不删除 outbox', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createOutboxDb({
      deliveries: [delivery('cdlv_1', {
        deliveryLeaseToken: 'a'.repeat(32),
        deliveryLeaseExpiresAt: '2026-07-11T12:01:00.000Z',
      })],
      outboxes: [outbox('cdlv_1', { expiresAt: '2026-07-11T00:00:00.000Z' })],
    })

    const outcome = await purgeExpiredMetaCapiOutbox(db as unknown as D1Database)

    expect(outcome).toEqual({ purged: 0, skipped: 0 })
    expect(db.deliveries.get('cdlv_1')?.status).toBe('pending')
    expect(db.outboxes.has('cdlv_1')).toBe(true)
    vi.useRealTimers()
  })

  it('过期清理每次硬限制 100，终态只删密文而不覆盖状态', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const deliveries = Array.from({ length: 101 }, (_, index) => delivery(`cdlv_${index}`, {
      status: index === 0 ? 'sent' : 'pending',
    }))
    const outboxes = deliveries.map(item => outbox(item.id, { expiresAt: '2026-07-11T00:00:00.000Z' }))
    const db = createOutboxDb({ deliveries, outboxes })

    const outcome = await purgeExpiredMetaCapiOutbox(db as unknown as D1Database, 999)

    expect(outcome).toEqual({ purged: 100, skipped: 99 })
    expect(db.deliveries.get('cdlv_0')?.status).toBe('sent')
    expect(db.outboxes.size).toBe(1)
    const scan = db.calls.find(call => call.sql.includes('FROM meta_capi_secure_outbox'))
    expect(scan?.params).toEqual([100])
    expect(scan?.sql).toContain("datetime(o.expires_at) <= datetime('now')")
    vi.useRealTimers()
  })
})
