import { describe, expect, it } from 'vitest'
import type { Bindings } from '../index'
import { recordConversionAction } from './conversions'

type Call = { sql: string; params: unknown[] }

function createConversionDb(options: {
  existingDedupeKeys?: string[]
  existingLeadSessions?: string[]
} = {}) {
  const calls: Call[] = []
  const dedupe = new Map((options.existingDedupeKeys ?? []).map((key) => [key, `existing_${key}`]))
  const leadSessions = new Set(options.existingLeadSessions ?? [])
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
          if (sql.includes('WHERE dedupe_key = ?')) {
            const existingId = dedupe.get(String(call.params[0]))
            return existingId ? ({ id: existingId } as T) : null
          }
          if (sql.includes("action_type = 'lead'")) {
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
          if (sql.includes('INSERT INTO analytics_conversion_actions')) {
            const id = String(call.params[0])
            const actionType = String(call.params[1])
            const dedupeKey = String(call.params[2])
            const sessionId = String(call.params[6])
            dedupe.set(dedupeKey, id)
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
    expect(result.derivedActions).toHaveLength(0)
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
})
