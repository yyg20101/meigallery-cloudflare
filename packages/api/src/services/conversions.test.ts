import { describe, expect, it } from 'vitest'
import type { Bindings } from '../index'
import { recordConversionAction } from './conversions'

type Call = { sql: string; params: unknown[] }
type InsertedConversion = { id: string; actionType: string; dedupeKey: string; sessionId: string }

function createConversionDb(options: {
  existingDedupeKeys?: string[]
  existingLeadSessions?: string[]
  skipLeadLookup?: boolean
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
  } as unknown as Pick<Bindings, 'APP_ENV' | 'DB'>
}

describe('conversion ledger service', () => {
  it('首次有效联系写入 contact 和 lead，并创建 Meta delivery', async () => {
    const db = createConversionDb()
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
    const firstDb = createConversionDb()
    const secondDb = createConversionDb()

    await recordConversionAction(envFor(firstDb), input)
    await recordConversionAction(envFor(secondDb), input)

    const firstDeliveries = firstDb.calls.filter(call => call.sql.includes('analytics_conversion_deliveries'))
    const secondDeliveries = secondDb.calls.filter(call => call.sql.includes('analytics_conversion_deliveries'))
    expect(firstDeliveries.map(call => call.params[2]).sort()).toEqual(['meta_capi', 'meta_pixel'])
    expect(firstDeliveries.map(call => call.params[3])).toEqual([
      secondDeliveries[0]?.params[3],
      secondDeliveries[1]?.params[3],
    ])
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
    const db = createConversionDb({ skipLeadLookup: true })

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
