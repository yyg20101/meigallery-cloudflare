import { describe, expect, it } from 'vitest'
import {
  aggregateAnalyticsDaily,
  aggregateClickDaily,
  aggregatePathEdges,
  cleanupAnalyticsRetention,
} from './analytics-aggregate'

type DbCall = { sql: string; params: unknown[] }

function createDb() {
  const calls: DbCall[] = []
  const db = {
    calls,
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

describe('analytics-aggregate', () => {
  it('按固定日期幂等重建来源、页面、事件和邀请日报', async () => {
    const db = createDb()

    const result = await aggregateAnalyticsDaily(db as unknown as D1Database, '2026-06-07')

    expect(result).toEqual({ date: '2026-06-07', steps: ['sources', 'pages', 'source-pages', 'events', 'invites'] })
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_daily_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_daily_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('analytics_page_summaries'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_daily_pages'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_source_page_daily'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_daily_events'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_invite_daily'))).toBe(true)
    const inviteInsert = db.calls.find(call => call.sql.includes('INSERT INTO analytics_invite_daily'))
    expect(inviteInsert?.sql).toContain('attribution_conversion_facts')
    expect(inviteInsert?.sql).not.toContain("event_name = 'contact_method_click'")
    expect(db.calls
      .filter(call => call.sql.includes('analytics_events'))
      .every(call => call.sql.includes("date(datetime(") && call.sql.includes("'+8 hours'"))).toBe(true)
    expect(db.calls.every(call => call.params.includes('2026-06-07'))).toBe(true)
  })

  it('聚合路径边使用 session 内页面顺序并只从权威事实读取转化', async () => {
    const db = createDb()

    await aggregatePathEdges(db as unknown as D1Database, '2026-06-07')

    const insert = db.calls.find(call => call.sql.includes('INSERT INTO analytics_path_edges'))
    expect(insert?.sql).toContain('LEAD(aps.route_name)')
    expect(insert?.sql).toContain('attribution_conversion_facts')
    expect(insert?.sql).toContain("'Contact', 'CompleteRegistration'")
    expect(insert?.sql).not.toContain('register_success_count')
    expect(insert?.sql).toContain('membership_grant_count')
  })

  it('点击日报重算有效点击，避免重复点击污染指标', async () => {
    const db = createDb()

    await aggregateClickDaily(db as unknown as D1Database, '2026-06-07')

    const update = db.calls.find(call => call.sql.includes('UPDATE analytics_click_daily'))
    expect(update?.sql).toContain('raw_click_count - duplicate_click_count')
    expect(update?.params).toEqual(['2026-06-07'])
  })

  it('保留期清理覆盖采样明细、摘要、聚合、访客和导出任务', async () => {
    const db = createDb()

    const result = await cleanupAnalyticsRetention(db as unknown as D1Database, new Date('2026-06-07T00:00:00.000Z'))

    expect(result.sampledRawBefore).toBe('2026-05-08')
    expect(result.summaryBefore).toBe('2026-03-09')
    expect(result.aggregateBefore).toBe('2025-05-08')
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_events WHERE sampled = 1'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_page_summaries'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_session_summaries'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('id NOT IN (SELECT DISTINCT session_id FROM analytics_events)'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_daily_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_source_page_daily'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('DELETE FROM analytics_source_click_daily'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('UPDATE analytics_export_jobs'))).toBe(true)
  })

  it('拒绝非法日期，避免 Cron 写入异常分区', async () => {
    const db = createDb()

    await expect(aggregateAnalyticsDaily(db as unknown as D1Database, '2026/06/07')).rejects.toThrow('分析日期格式必须为 YYYY-MM-DD')
  })
})
