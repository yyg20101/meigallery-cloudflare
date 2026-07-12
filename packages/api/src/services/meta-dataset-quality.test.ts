import { describe, expect, it, vi } from 'vitest'
import { collectMetaDatasetQuality, parseQualityResponse } from './meta-dataset-quality'

const DATASET_ID = '1277657707436781'

function createDb() {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this },
        async first<T>() { return { value: JSON.stringify(DATASET_ID) } as T },
        async run() { statements.push({ sql, values: this.values }); return { meta: { changes: 1 } } },
      }
      return statement
    },
    async batch(items: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(items.map(item => item.run()))
    },
  } as unknown as D1Database
  return { db, statements }
}

const response = {
  web: [
    {
      event_name: 'Contact',
      event_match_quality: {
        composite_score: 6.1,
        match_key_feedback: [
          { identifier: 'fbp', coverage: { percentage: 100 } },
          { identifier: 'fbc', coverage: { percentage: 94.1 } },
        ],
      },
    },
    {
      event_name: 'CompleteRegistration',
      event_match_quality: { composite_score: 6.1, match_key_feedback: [] },
    },
    { event_name: 'Lead', event_match_quality: { composite_score: 9.9 } },
  ],
}

describe('Meta Dataset Quality collector', () => {
  it('只解析活动事件和批准指标', () => {
    expect(parseQualityResponse(response)).toEqual([
      { eventName: 'Contact', metricKey: 'emq_score', value: 6.1 },
      { eventName: 'Contact', metricKey: 'fbp_coverage', value: 100 },
      { eventName: 'Contact', metricKey: 'fbc_coverage', value: 94.1 },
      { eventName: 'CompleteRegistration', metricKey: 'emq_score', value: 6.1 },
    ])
  })

  it('production 使用 Bearer token 查询并写入契约 digest', async () => {
    const { db, statements } = createDb()
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token')
      return new Response(JSON.stringify(response), { status: 200 })
    }) as unknown as typeof fetch

    const result = await collectMetaDatasetQuality({
      APP_ENV: 'production', DB: db, META_CAPI_ACCESS_TOKEN: 'private-token',
    }, new Date('2026-07-12T00:00:00.000Z'), fetcher)

    expect(result).toEqual({ status: 'success', metricCount: 4, errorCategory: '' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v25.0/dataset_quality?')
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('private-token')
    expect(statements.filter(item => item.sql.includes('INSERT INTO meta_dataset_quality_snapshots'))).toHaveLength(4)
    expect(statements.some(item => item.values.includes('sha256:28ec95b732afb273bd67c96d3e2780ce4ac1ebf40f206db5be2843fa72a685b4'))).toBe(true)
  })

  it('dev 保守跳过且不调用 Meta', async () => {
    const { db, statements } = createDb()
    const fetcher = vi.fn() as unknown as typeof fetch
    const result = await collectMetaDatasetQuality({ APP_ENV: 'dev', DB: db, META_CAPI_ACCESS_TOKEN: undefined }, new Date(), fetcher)
    expect(result.status).toBe('skipped')
    expect(fetcher).not.toHaveBeenCalled()
    expect(statements).toEqual([])
  })

  it('权限失败写入稳定错误快照且不抛出 token', async () => {
    const { db, statements } = createDb()
    const result = await collectMetaDatasetQuality({
      APP_ENV: 'production', DB: db, META_CAPI_ACCESS_TOKEN: 'private-token',
    }, new Date('2026-07-12T00:00:00.000Z'), async () => new Response('{}', { status: 403 }))
    expect(result).toEqual({ status: 'error', metricCount: 0, errorCategory: 'permission_denied' })
    expect(statements.filter(item => item.sql.includes('INSERT INTO meta_dataset_quality_snapshots'))).toHaveLength(2)
    expect(JSON.stringify(statements)).not.toContain('private-token')
  })
})
