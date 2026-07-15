import { describe, expect, it } from 'vitest'
import { recordContact } from './conversions'
import { createAdConsentSnapshot } from '../utils/marketing-consent-receipt'

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('统一转换事实', () => {
  it('拒绝同意时只批量写入不可变 Fact，不创建 Delivery', async () => {
    const db = createDb()
    const result = await recordContact({ DB: db as unknown as D1Database, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }, {
      visitorId: 'visitor_123', sessionId: 'session_123', occurredAt: '2026-07-15T00:00:00.000Z',
      consentSnapshot: createAdConsentSnapshot('denied'), attributionSource: 'none', contactMethodId: 'contact_123', contactPlatform: 'telegram',
      actionType: 'open_link', metadata: { source: 'unit' },
    })

    expect(result).toMatchObject({ created: true, actionType: 'contact', trackingInstructions: [] })
    expect(db.batches).toHaveLength(1)
    const sql = db.batches[0]!.join('\n')
    expect(sql).toContain('attribution_conversion_facts')
    expect(sql).not.toContain('analytics_conversion_actions')
    expect(sql).not.toContain('analytics_conversion_deliveries')
  })

  it('相同业务行为复用既有 Fact，并返回原 Browser 指令', async () => {
    const db = createDb('fact_existing')
    const result = await recordContact({ DB: db as unknown as D1Database, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }, {
      visitorId: 'visitor_123', sessionId: 'session_123', occurredAt: '2026-07-15T00:00:00.000Z',
      consentSnapshot: createAdConsentSnapshot('denied'), contactMethodId: 'contact_123', contactPlatform: 'telegram', actionType: 'open_link',
    })
    expect(result).toMatchObject({ id: 'fact_existing', actionType: 'contact', created: false, duplicateOf: 'fact_existing' })
    expect(result.trackingInstructions).toMatchObject([{ externalEventId: 'mg3_existing', canonicalEvent: 'Contact' }])
    expect(db.batches).toHaveLength(0)
  })

  it('重复 Google Fact 从最终 binding 重建合法 Browser destination', async () => {
    const db = createDb('fact_google', 'google')
    const result = await recordContact({ DB: db as unknown as D1Database, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }, {
      visitorId: 'visitor_123', sessionId: 'session_123', occurredAt: '2026-07-15T00:00:00.000Z',
      consentSnapshot: createAdConsentSnapshot('denied'), contactMethodId: 'contact_123', contactPlatform: 'telegram', actionType: 'open_link',
    })

    expect(result.trackingInstructions[0]).toMatchObject({
      provider: 'google',
      externalEventId: 'mg3_existing',
      descriptor: {
        browserEventName: 'conversion',
        browserDestination: 'AW-123456789/Contact_Label',
        serverDestination: 'customers/123/conversionActions/456',
      },
      payload: {},
    })
  })
})

function createDb(existingId?: string, provider: 'meta' | 'google' = 'meta') {
  const batches: string[][] = []
  const delivery = provider === 'google'
    ? { provider, destination: 'AW-123456789/Contact_Label', server_destination: 'customers/123/conversionActions/456' }
    : { provider, destination: 'meta_pixel', server_destination: 'meta_capi' }
  return {
    batches,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async <T>() => sql.includes('attribution_conversion_facts') && existingId ? ({ id: existingId, canonical_event: 'Contact', external_event_id: 'mg3_existing' } as T) : null,
            all: async <T>() => ({ results: sql.includes('attribution_deliveries') && existingId ? ([delivery] as T[]) : [] as T[] }),
            run: async () => ({ meta: { changes: 1 } }),
            __sql: sql,
            __params: params,
          }
        },
        first: async <T>() => sql.includes('attribution_conversion_facts') && existingId ? ({ id: existingId, canonical_event: 'Contact', external_event_id: 'mg3_existing' } as T) : null,
        all: async <T>() => ({ results: sql.includes('attribution_deliveries') && existingId ? ([delivery] as T[]) : [] as T[] }),
      }
    },
    async batch(statements: Array<{ __sql?: string }>) {
      batches.push(statements.map(statement => statement.__sql ?? ''))
      return statements.map(() => ({ meta: { changes: 1 } }))
    },
  }
}
