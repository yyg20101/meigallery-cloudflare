import { describe, expect, it } from 'vitest'
import {
  buildAnalyticsConversionIndex,
  readAnalyticsConversionMetrics,
  sourceMetricKey,
} from './analytics-conversion-metrics'

describe('分析转化事实读模型', () => {
  it('按北京时间读取不可变事实并建立唯一指标索引', async () => {
    const calls: unknown[][] = []
    const db = {
      prepare(sql: string) {
        expect(sql).toContain('FROM attribution_conversion_facts')
        return {
          bind(...params: unknown[]) {
            calls.push(params)
            return this
          },
          async all() {
            return {
              results: [
                {
                  date: '2026-07-28',
                  source_channel: 'ad',
                  source_name: 'ad-ms3z4pw000z5j6',
                  route_name: 'register',
                  path: '/register',
                  session_id: 'session_1',
                  invite_code_id: '',
                  contact_click_count: 0,
                  register_count: 1,
                },
                {
                  date: '2026-07-28',
                  source_channel: 'ad',
                  source_name: 'ad-ms3z4pw000z5j6',
                  route_name: 'home',
                  path: '/',
                  session_id: 'session_1',
                  invite_code_id: '',
                  contact_click_count: 1,
                  register_count: 0,
                },
              ],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          },
        }
      },
    }

    const result = await readAnalyticsConversionMetrics(
      db as unknown as D1Database,
      { from: '2026-07-28', to: '2026-07-28' },
    )
    const index = buildAnalyticsConversionIndex(result.rows)

    expect(calls[0]).toEqual([
      '2026-07-27T16:00:00.000Z',
      '2026-07-28T16:00:00.000Z',
    ])
    expect(index.total).toEqual({ contact_click_count: 1, register_count: 1 })
    expect(index.bySource.get(sourceMetricKey('ad', 'ad-ms3z4pw000z5j6', ''))).toEqual({
      contact_click_count: 1,
      register_count: 1,
    })
    expect(index.bySession.get('session_1')).toEqual({
      contact_click_count: 1,
      register_count: 1,
    })
  })
})
