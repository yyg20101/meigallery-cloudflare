import { describe, expect, it } from 'vitest'
import type { Bindings } from '../index'
import { recordConversionAction } from './conversions'

type Call = { sql: string; params: unknown[] }
type InsertedConversion = { id: string; actionType: string; dedupeKey: string; sessionId: string }

function createConversionDb(options: {
  existingDedupeKeys?: string[]
  existingLeadSessions?: string[]
  skipLeadLookup?: boolean
  metaCapiEnabled?: boolean
  facebookPixelEnabled?: boolean
  facebookPixelId?: string
  metaTrackingMode?: 'disabled' | 'test' | 'production'
} = {}) {
  const calls: Call[] = []
  const insertedConversions: InsertedConversion[] = []
  const dedupe = new Map((options.existingDedupeKeys ?? []).map((key) => [key, `existing_${key}`]))
  const leadSessions = new Set(options.existingLeadSessions ?? [])
  const db = {
    calls,
    insertedConversions,
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      return {
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
          if (sql.includes("action_type = 'lead'")) {
            if (options.skipLeadLookup) return null
            const sessionId = String(call.params[0])
            return leadSessions.has(sessionId) ? ({ id: `lead_${sessionId}` } as T) : null
          }
          return null
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          if (sql.includes('analytics_conversion_actions')) {
            const id = String(call.params[0])
            const actionType = String(call.params[1])
            const dedupeKey = String(call.params[2])
            const sessionId = String(call.params[6])
            if (dedupe.has(dedupeKey)) {
              return { meta: { changes: 0, rows_written: 0, rows_read: 0, duration: 1 } }
            }
            dedupe.set(dedupeKey, id)
            insertedConversions.push({ id, actionType, dedupeKey, sessionId })
            if (actionType === 'lead') leadSessions.add(sessionId)
          }
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

function envFor(db: ReturnType<typeof createConversionDb>) {
  return {
    APP_ENV: 'test',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>
}

function envWithQueueFor(db: ReturnType<typeof createConversionDb>, sent: Array<{ schemaVersion: 1; deliveryId: string; userData: Record<string, never> }>) {
  return {
    APP_ENV: 'test',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
    META_CAPI_QUEUE: {
      async send(message: { schemaVersion: 1; deliveryId: string; userData: Record<string, never> }) {
        sent.push(message)
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
      },
    },
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB' | 'SESSION_SECRET' | 'META_CAPI_QUEUE'>
}

function grantedContactInput() {
  return {
    actionType: 'contact' as const,
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
  it('首次授权联系返回 Contact 和 Lead 两条同源 Pixel 指令', async () => {
    const result = await recordConversionAction(envFor(createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'test',
    })), grantedContactInput())

    expect(result.pixelEvents.map(item => item.eventName)).toEqual(['Contact', 'Lead'])
    expect(result.pixelEvents[0]?.eventId).toBe('meta:Contact:contact:session_1:telegram:floating_contact_panel')
    expect(result.pixelEvents[1]?.eventId).toBe('meta:Lead:lead:session_1')
    expect(result.pixelEvents.every(item => item.receiptToken)).toBe(true)
  })

  it.each(['limited', 'denied'] as const)('%s 不创建 Meta delivery 或 Pixel 指令', async consentState => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'production',
      metaCapiEnabled: true,
    })
    const result = await recordConversionAction(envFor(db), { ...grantedContactInput(), consentState })

    expect(result.pixelEvents).toEqual([])
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('disabled 模式不创建 Meta delivery 或 Pixel 指令', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'disabled',
      metaCapiEnabled: true,
    })
    const result = await recordConversionAction(envFor(db), grantedContactInput())

    expect(result.pixelEvents).toEqual([])
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('首次有效联系写入 contact 和 lead，并创建 Meta delivery', async () => {
    const db = createConversionDb({
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaTrackingMode: 'test',
    })
    const result = await recordConversionAction(envFor(db), {
      actionType: 'contact',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:00:00.000Z',
      routeName: 'home',
      path: '/',
      sourceChannel: 'ad',
      sourceName: 'ad-july',
      utmCampaign: 'july',
      utmContent: 'chat-a',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { method_type: 'telegram', location: 'floating_contact_panel' },
    })
    expect(result.created).toBe(true)
    expect(result.derivedActions.map(item => item.actionType)).toContain('lead')
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_actions'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(true)
  })

  it('重复有效联系不重复派生 Lead', async () => {
    const db = createConversionDb({ existingDedupeKeys: ['contact:session_1:telegram:floating_contact_panel'] })
    const result = await recordConversionAction(envFor(db), {
      actionType: 'contact',
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
    expect(result.derivedActions).toHaveLength(0)
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
    await recordConversionAction(envFor(db), {
      actionType: 'complete_registration',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:10:00.000Z',
      consentState: 'denied',
      metadata: {},
    })
    expect(db.calls.some(call => call.sql.includes('analytics_conversion_deliveries'))).toBe(false)
  })

  it('同 session 已有 lead 时不重复派生', async () => {
    const db = createConversionDb({ existingLeadSessions: ['session_1'] })
    const result = await recordConversionAction(envFor(db), {
      actionType: 'contact',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:15:00.000Z',
      consentState: 'limited',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    expect(result.created).toBe(true)
    expect(result.derivedActions).toHaveLength(0)
  })

  it('可映射事件生成 Pixel 和 CAPI delivery，且 external_event_id 稳定', async () => {
    const input = {
      actionType: 'complete_registration' as const,
      visitorId: 'visitor_1',
      sessionId: 'session_1',
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

    await recordConversionAction(envFor(firstDb), input)
    await recordConversionAction(envFor(secondDb), input)

    const firstDeliveries = firstDb.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    const secondDeliveries = secondDb.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO analytics_conversion_deliveries'))
    expect(firstDeliveries.map(call => call.params[2]).sort()).toEqual(['meta_capi', 'meta_pixel'])
    expect(firstDeliveries.map(call => call.params[3])).toEqual([
      secondDeliveries[0]?.params[3],
      secondDeliveries[1]?.params[3],
    ])
  })

  it('CAPI 开启且 Queue 存在时发送完整版本化消息', async () => {
    const sent: Array<{ schemaVersion: 1; deliveryId: string; userData: Record<string, never> }> = []
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })

    await recordConversionAction(envWithQueueFor(db, sent), {
      actionType: 'complete_registration',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
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
  })

  it('CAPI 开启但缺少 Queue binding 时标记 missing_queue', async () => {
    const db = createConversionDb({ metaCapiEnabled: true, metaTrackingMode: 'test', facebookPixelId: '1234567890' })

    await recordConversionAction(envFor(db), {
      actionType: 'complete_registration',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:23:00.000Z',
      consentState: 'granted',
      metadata: {},
    })

    expect(db.calls.some(call => (
      call.sql.includes('UPDATE analytics_conversion_deliveries') &&
      call.params[0] === 'skipped' &&
      call.params[1] === 'missing_queue'
    ))).toBe(true)
    expect(db.calls.some(call => (
      call.sql.includes('analytics_conversion_delivery_daily') &&
      call.params[3] === 'skipped' &&
      call.params[4] === 'missing_queue'
    ))).toBe(true)
  })

  it('lead 派生命中并发 dedupe 时返回 null，不抛唯一约束错误', async () => {
    const db = createConversionDb({ existingDedupeKeys: ['lead:session_1'] })
    const result = await recordConversionAction(envFor(db), {
      actionType: 'contact',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:25:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })

    expect(result.created).toBe(true)
    expect(result.derivedActions).toHaveLength(0)
  })

  it('同 session 不同 contact target 并发派生 lead 时使用 session 级 dedupe', async () => {
    const db = createConversionDb({
      skipLeadLookup: true,
      facebookPixelEnabled: true,
      facebookPixelId: '1234567890',
      metaCapiEnabled: true,
      metaTrackingMode: 'test',
    })

    const first = await recordConversionAction(envFor(db), {
      actionType: 'contact',
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      occurredAt: '2026-07-09T10:30:00.000Z',
      consentState: 'granted',
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: {},
    })
    const second = await recordConversionAction(envFor(db), {
      actionType: 'contact',
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
    expect(first.derivedActions).toHaveLength(1)
    expect(second.derivedActions).toHaveLength(0)
    expect(db.insertedConversions.filter(item => item.actionType === 'contact').map(item => item.dedupeKey).sort()).toEqual([
      'contact:session_1:telegram:floating_contact_panel',
      'contact:session_1:telegram:gallery_detail_cta',
    ])
    expect(db.insertedConversions.filter(item => item.actionType === 'lead')).toEqual([
      expect.objectContaining({ dedupeKey: 'lead:session_1' }),
    ])

    const leadDeliveries = db.calls.filter(
      call =>
        call.sql.includes('analytics_conversion_deliveries') &&
        db.insertedConversions.some(item => item.actionType === 'lead' && item.id === call.params[1]),
    )
    expect(leadDeliveries.map(call => call.params[3])).toEqual([
      'meta:Lead:lead:session_1',
      'meta:Lead:lead:session_1',
    ])
  })
})
