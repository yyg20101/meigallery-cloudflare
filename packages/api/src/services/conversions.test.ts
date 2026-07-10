import { describe, expect, it } from 'vitest'
import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { recordContact, recordRegistration } from './conversions'

type Call = { sql: string; params: unknown[] }
type InsertedConversion = { id: string; actionType: string; dedupeKey: string; sessionId: string }
type InsertedDelivery = { conversionActionId: string; eventName: string }

function createConversionDb(options: {
  existingDedupeKeys?: string[]
  metaCapiEnabled?: boolean
  facebookPixelEnabled?: boolean
  facebookPixelId?: string
  metaTrackingMode?: 'disabled' | 'test' | 'production'
  failAt?: number
} = {}) {
  const calls: Call[] = []
  const insertedConversions: InsertedConversion[] = []
  const insertedDeliveries: InsertedDelivery[] = []
  const dedupe = new Map((options.existingDedupeKeys ?? []).map((key) => [key, `existing_${key}`]))
  let statementCount = 0

  function applyCall(
    call: Call,
    target: {
      dedupe: Map<string, string>
      insertedConversions: InsertedConversion[]
      insertedDeliveries: InsertedDelivery[]
    },
  ) {
    if (call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_actions')) {
      const id = String(call.params[0])
      const actionType = String(call.params[1])
      const dedupeKey = String(call.params[2])
      const sessionId = String(call.params[6])
      if (target.dedupe.has(dedupeKey)) return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
      target.dedupe.set(dedupeKey, id)
      target.insertedConversions.push({ id, actionType, dedupeKey, sessionId })
    }
    if (call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries')) {
      target.insertedDeliveries.push({
        conversionActionId: String(call.params[1]),
        eventName: String(call.params[4]),
      })
    }
    return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
  }

  const db = {
    calls,
    insertedConversions,
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      const statement = {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          if (sql.includes('WHERE dedupe_key = ?')) {
            const existingId = dedupe.get(String(call.params[0]))
            return existingId ? ({ id: existingId } as T) : null
          }
          if (sql.includes("WHERE key = 'meta_capi_enabled'")) {
            return { value: String(options.metaCapiEnabled === true) } as T
          }
          if (sql.includes("WHERE key = 'facebook_pixel_enabled'")) {
            return { value: String(options.facebookPixelEnabled === true) } as T
          }
          if (sql.includes("WHERE key = 'facebook_pixel_id'")) {
            return options.facebookPixelId ? ({ value: JSON.stringify(options.facebookPixelId) } as T) : null
          }
          if (sql.includes("WHERE key = 'meta_tracking_mode'")) {
            return { value: JSON.stringify(options.metaTrackingMode ?? 'disabled') } as T
          }
          return null
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          statementCount += 1
          calls.push(call)
          const result = applyCall(call, { dedupe, insertedConversions, insertedDeliveries })
          if (options.failAt === statementCount) throw new Error('模拟 D1 写入失败')
          return result
        },
      }
      Object.assign(statement, { __call: call })
      return statement
    },
    async batch(statements: Array<{ __call?: Call }>) {
      const staged = {
        dedupe: new Map(dedupe),
        insertedConversions: [...insertedConversions],
        insertedDeliveries: [...insertedDeliveries],
      }
      const results = []
      for (const statement of statements) {
        const call = statement.__call
        if (!call) throw new Error('缺少 batch statement')
        statementCount += 1
        calls.push(call)
        if (options.failAt === statementCount) throw new Error('模拟 D1 写入失败')
        results.push(applyCall(call, staged))
      }
      dedupe.clear()
      for (const [key, value] of staged.dedupe) dedupe.set(key, value)
      insertedConversions.splice(0, insertedConversions.length, ...staged.insertedConversions)
      insertedDeliveries.splice(0, insertedDeliveries.length, ...staged.insertedDeliveries)
      return results
    },
    get failAt() {
      return options.failAt
    },
    set failAt(value: number | undefined) {
      options.failAt = value
    },
  }
  return Object.assign(db, { insertedDeliveries })
}

function envFor(db: ReturnType<typeof createConversionDb>) {
  return {
    APP_ENV: 'test',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>
}

function envWithQueueFor(db: ReturnType<typeof createConversionDb>, sent: MetaCapiQueueMessage[]) {
  return {
    APP_ENV: 'test',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
    META_CAPI_QUEUE: {
      async send(message: MetaCapiQueueMessage) {
        sent.push(message)
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
      },
    },
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>
}

function grantedContactInput() {
  return {
    visitorId: 'visitor_1',
    sessionId: 'session_1',
    occurredAt: '2026-07-09T10:00:00.000Z',
    consentState: 'granted',
    methodType: 'telegram',
    actionTarget: 'floating_contact_panel',
    metadata: { method_type: 'telegram', location: 'floating_contact_panel' },
  }
}

describe('conversion ledger service', () => {
  it('首次授权联系只返回 Contact Pixel 指令', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'test',
    })
    const result = await recordContact(envFor(db), grantedContactInput())

    expect(result.pixelEvents.map(item => item.eventName)).toEqual(['Contact'])
    expect(result.pixelEvents[0]?.eventId).toBe('meta:Contact:contact:session_1:telegram:floating_contact_panel')
    expect(result.pixelEvents.every(item => item.receiptToken)).toBe(true)
    expect(db.calls.filter(call => (
      call.sql.includes('INSERT INTO analytics_conversion_delivery_daily')
      && call.sql.includes("'pending'")
    ))).toHaveLength(1)
  })

  it('公开 metadata 中的 Meta 标识和网络标识不进入 SQL 参数', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'test',
    })
    await recordContact(envFor(db), {
      ...grantedContactInput(),
      metadata: {
        method_type: 'telegram',
        fbp: 'fb.1.private',
        fbc: 'fb.1.private',
        clientIpAddress: '203.0.113.8',
        client_user_agent: 'private-browser',
        user_agent: 'private-browser',
      },
    })

    const serializedCalls = JSON.stringify(db.calls)
    expect(serializedCalls).not.toContain('fb.1.private')
    expect(serializedCalls).not.toContain('203.0.113.8')
    expect(serializedCalls).not.toContain('private-browser')
  })

  it.each(['limited', 'denied'] as const)('%s 不创建 Meta delivery 或 Pixel 指令', async consentState => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'production',
      metaCapiEnabled: true,
    })
    const sent: MetaCapiQueueMessage[] = []
    let supplierCalls = 0
    const result = await recordContact(envWithQueueFor(db, sent), { ...grantedContactInput(), consentState }, {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789', clientIpAddress: '203.0.113.24' }
      },
    })

    expect(result.pixelEvents).toEqual([])
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
    expect(sent).toEqual([])
    expect(supplierCalls).toBe(0)
  })

  it('disabled 模式不创建 Meta delivery 或 Pixel 指令', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'disabled',
      metaCapiEnabled: true,
    })
    const sent: MetaCapiQueueMessage[] = []
    let supplierCalls = 0
    const result = await recordContact(envWithQueueFor(db, sent), grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789', clientIpAddress: '203.0.113.24' }
      },
    })

    expect(result.pixelEvents).toEqual([])
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
    expect(sent).toEqual([])
    expect(supplierCalls).toBe(0)
  })

  it('首次有效联系只写入一条 contact 与两条派生 delivery', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'test',
      metaCapiEnabled: true,
    })
    const result = await recordContact(envFor(db), grantedContactInput())

    expect(result.actionType).toBe('contact')
    expect(result).not.toHaveProperty('derivedActions')
    expect(db.insertedConversions.map(item => item.actionType)).toEqual(['contact'])
    expect(db.insertedDeliveries.map(item => item.eventName)).toEqual(['Contact', 'Contact'])
  })

  it('delivery 写入失败不残留 action，重试后可返回指令', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'test',
      failAt: 3,
    })

    await expect(recordContact(envFor(db), grantedContactInput())).rejects.toThrow()
    expect(db.insertedConversions).toEqual([])

    db.failAt = undefined
    const retried = await recordContact(envFor(db), grantedContactInput())
    expect(retried.created).toBe(true)
    expect(retried.pixelEvents.map(item => item.eventName)).toEqual(['Contact'])
  })

  it('重复有效联系只记录重复账本，不创建 delivery', async () => {
    const db = createConversionDb({ existingDedupeKeys: ['contact:session_1:telegram:floating_contact_panel'] })
    const result = await recordContact(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:05:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    expect(result.created).toBe(false)
    expect(result.duplicateOf).toBe('existing_contact:session_1:telegram:floating_contact_panel')
    expect(result).not.toHaveProperty('derivedActions')
    expect(result.pixelEvents).toEqual([])
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_actions'))).toBe(true)
    expect(db.calls.some(call => (
      call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_actions') &&
      String(call.params[2]).startsWith('duplicate:contact:session_1:telegram:floating_contact_panel:') &&
      call.params[20] === 'existing_contact:session_1:telegram:floating_contact_panel'
    ))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_daily'))).toBe(false)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('拒绝授权时不创建 Meta delivery', async () => {
    const db = createConversionDb()
    await recordRegistration(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:10:00.000Z',
      consentState: 'denied',
      metadata: {},
    })
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('可映射事件生成 Pixel 和 CAPI delivery，且 external_event_id 稳定', async () => {
    const input = {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:20:00.000Z',
      consentState: 'granted',
      actionTarget: 'register',
      metadata: {},
    }
    const firstDb = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaCapiEnabled: true,
      metaTrackingMode: 'test',
    })
    const secondDb = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaCapiEnabled: true,
      metaTrackingMode: 'test',
    })

    await recordRegistration(envFor(firstDb), input)
    await recordRegistration(envFor(secondDb), input)

    const firstDeliveries = firstDb.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    const secondDeliveries = secondDb.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    expect(firstDeliveries.map(call => call.params[2]).sort()).toEqual(['meta_capi', 'meta_pixel'])
    expect(firstDeliveries.map(call => call.params[3])).toEqual([
      secondDeliveries[0]?.params[3],
      secondDeliveries[1]?.params[3],
    ])
  })

  it('CAPI 开启且 Queue 存在时发送完整版本化消息', async () => {
    const sent: MetaCapiQueueMessage[] = []
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })

    await recordRegistration(envWithQueueFor(db, sent), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:22:00.000Z',
      consentState: 'granted',
      metadata: {},
    })

    const capiDelivery = db.calls.find(call => (
      call.sql.includes('analytics_conversion_deliveries') &&
      call.params[2] === 'meta_capi'
    ))
    expect(sent).toEqual([{
      schemaVersion: 1,
      deliveryId: capiDelivery?.params[0] as string,
      userData: {},
    }])
    expect(capiDelivery?.sql).toContain('tracking_mode')
    expect(capiDelivery?.params).toContain('test')
    expect(db.calls.some(call => (
      call.sql.includes('queue_enqueued_at = datetime')
      && call.params.includes(capiDelivery?.params[0])
    ))).toBe(true)
  })

  it('只将临时匹配数据通过 CAPI Queue 传递，并仅以 0|1 写入 delivery 覆盖率', async () => {
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })
    const sent: MetaCapiQueueMessage[] = []
    const userData = {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
      ignored: 'must-not-pass',
    }

    let supplierCalls = 0
    await recordContact(envWithQueueFor(db, sent), {
      ...grantedContactInput(),
      metadata: { fbp: 'metadata-fbp', fbc: 'metadata-fbc' },
    }, {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return userData
      },
    })

    expect(sent).toHaveLength(1)
    expect(supplierCalls).toBe(1)
    expect(sent.map(message => message.userData)).toEqual([{
      fbp: userData.fbp,
      fbc: userData.fbc,
      clientIpAddress: userData.clientIpAddress,
      clientUserAgent: userData.clientUserAgent,
    }])
    const deliveryCalls = db.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    expect(deliveryCalls).toHaveLength(1)
    expect(deliveryCalls.every(call => call.params.includes(1))).toBe(true)
    expect(deliveryCalls.every(call => call.sql.includes('tracking_mode') && call.params.includes('test'))).toBe(true)
    expect(JSON.stringify(db.calls)).not.toContain(userData.fbp)
    expect(JSON.stringify(db.calls)).not.toContain(userData.fbc)
    expect(JSON.stringify(db.calls)).not.toContain(userData.clientIpAddress)
    expect(JSON.stringify(db.calls)).not.toContain(userData.clientUserAgent)
    expect(JSON.stringify(db.calls)).not.toContain('metadata-fbp')
    expect(JSON.stringify(db.calls)).not.toContain('metadata-fbc')
  })

  it('CAPI 未启用时不调用临时数据 supplier', async () => {
    const db = createConversionDb({ metaTrackingMode: 'test', facebookPixelId: '1234567890' })
    let supplierCalls = 0

    await recordContact(envFor(db), grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789' }
      },
    })

    expect(supplierCalls).toBe(0)
  })

  it('缺少合法 Pixel ID 时不调用临时数据 supplier', async () => {
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test' })
    let supplierCalls = 0

    await recordContact(envFor(db), grantedContactInput(), {
      getMetaCapiUserData: () => {
        supplierCalls += 1
        return { fbp: 'fb.1.1700000000000.123456789' }
      },
    })

    expect(supplierCalls).toBe(0)
  })

  it('Queue 发送异常只记录固定诊断信息，不持久化异常原文', async () => {
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })
    const sensitive = 'fb.1.1700000000000.123456789|fb.1.1700000000000.CLICK_abc-123|203.0.113.24|MeiGallery Test Browser/1.0|token_private'
    const env = {
      ...envFor(db),
      META_CAPI_QUEUE: { send: async () => { throw new Error(sensitive) } },
    } as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>

    const result = await recordContact(env, grantedContactInput())

    const serializedCalls = JSON.stringify(db.calls)
    expect(serializedCalls).not.toContain(sensitive)
    expect(JSON.stringify(result)).not.toContain(sensitive)
    expect(serializedCalls).toContain('queue_send_failed')
    expect(db.calls.some(call => (
      call.sql.includes('queue_attempt_count = queue_attempt_count + 1')
      && call.params.includes(db.calls.find(item => item.sql.includes('analytics_conversion_deliveries') && item.params[2] === 'meta_capi')?.params[0])
    ))).toBe(true)
    expect(db.calls.some(call => (
      call.sql.includes("error_code = 'queue_send_failed'")
      && !/SET\s+status\s*=/.test(call.sql)
    ))).toBe(true)
  })

  it('CAPI 开启但缺少 Queue binding 时保持 pending 并记录可恢复诊断', async () => {
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })

    await recordRegistration(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      userId: 42,
      occurredAt: '2026-07-09T10:23:00.000Z',
      consentState: 'granted',
      metadata: {},
    })

    expect(db.calls.some(call => (
      call.sql.includes('UPDATE analytics_conversion_deliveries') &&
      call.sql.includes("error_code = 'missing_queue'")
    ))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('SET\n        status = ?') && call.params[0] === 'skipped')).toBe(false)
  })

  it('同 session 不同 contact target 分别记录且不生成 Lead', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaCapiEnabled: true,
      metaTrackingMode: 'test',
    })

    const first = await recordContact(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:30:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    const second = await recordContact(envFor(db), {
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:30:01.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'gallery_detail_cta',
      metadata: {},
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
    expect(first).not.toHaveProperty('derivedActions')
    expect(second).not.toHaveProperty('derivedActions')
    expect(db.insertedConversions.filter(item => item.actionType === 'contact').map(item => item.dedupeKey).sort()).toEqual([
      'contact:session_1:telegram:floating_contact_panel',
      'contact:session_1:telegram:gallery_detail_cta',
    ])
    expect(db.insertedConversions.some(item => item.actionType === 'lead')).toBe(false)
    expect(db.insertedDeliveries.map(item => item.eventName)).toEqual(['Contact', 'Contact', 'Contact', 'Contact'])
  })
})
