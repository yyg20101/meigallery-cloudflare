import { describe, expect, it } from 'vitest'
import { recordContact } from './conversions'

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('统一转换事实', () => {
  it('拒绝同意时只批量写入不可变 Fact 和归因审计，不创建 Delivery', async () => {
    const db = createDb()
    const result = await recordContact({ DB: db as unknown as D1Database, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }, {
      visitorId: 'visitor_123', sessionId: 'session_123', occurredAt: '2026-07-15T00:00:00.000Z',
      consentState: 'denied', attributionSource: 'none', contactMethodId: 'contact_123', contactPlatform: 'telegram',
      actionType: 'open_link', metadata: { source: 'unit' },
    })

    expect(result).toMatchObject({ created: true, actionType: 'contact', trackingInstructions: [] })
    expect(db.batches).toHaveLength(1)
    const sql = db.batches[0]!.join('\n')
    expect(sql).toContain('attribution_conversion_facts')
    expect(sql).toContain('attribution_fact_audit_logs')
    expect(sql).not.toContain('analytics_conversion_actions')
    expect(sql).not.toContain('analytics_conversion_deliveries')
  })

  it('相同业务行为复用既有 Fact，不创建第二次投递', async () => {
    const db = createDb('fact_existing')
    const result = await recordContact({ DB: db as unknown as D1Database, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }, {
      visitorId: 'visitor_123', sessionId: 'session_123', occurredAt: '2026-07-15T00:00:00.000Z',
      contactMethodId: 'contact_123', contactPlatform: 'telegram', actionType: 'open_link',
    })
    expect(result).toEqual({ id: 'fact_existing', actionType: 'contact', created: false, duplicateOf: 'fact_existing', trackingInstructions: [] })
    expect(db.batches).toHaveLength(0)
  })
})

function createDb(existingId?: string) {
  const batches: string[][] = []
  return {
    batches,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async <T>() => sql.includes('attribution_conversion_facts') && existingId ? ({ id: existingId } as T) : null,
            all: async <T>() => ({ results: [] as T[] }),
            run: async () => ({ meta: { changes: 1 } }),
            __sql: sql,
            __params: params,
          }
        },
        first: async <T>() => sql.includes('attribution_conversion_facts') && existingId ? ({ id: existingId } as T) : null,
        all: async <T>() => ({ results: [] as T[] }),
      }
    },
    async batch(statements: Array<{ __sql?: string }>) {
      batches.push(statements.map(statement => statement.__sql ?? ''))
      return statements.map(() => ({ meta: { changes: 1 } }))
    },
  }
}
