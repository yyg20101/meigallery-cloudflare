import { describe, expect, it } from 'vitest'
import { assertD1Budget, mergeD1Usage, readD1UsageMeta } from './analytics-cost'

describe('analytics-cost', () => {
  it('读取 D1 meta 中的 rows read/write 和 duration', () => {
    expect(readD1UsageMeta({
      meta: {
        rows_read: 120,
        rows_written: 8,
        duration: 14.5,
      },
    })).toEqual({ rowsRead: 120, rowsWritten: 8, durationMs: 14.5 })
  })

  it('兼容驼峰和 changes 字段', () => {
    expect(readD1UsageMeta({
      meta: {
        rowsRead: 12,
        changes: 3,
        durationMs: 9,
      },
    })).toEqual({ rowsRead: 12, rowsWritten: 3, durationMs: 9 })
  })

  it('合并多次查询用量', () => {
    expect(mergeD1Usage(
      { rowsRead: 10, rowsWritten: 1, durationMs: 5 },
      { rowsRead: 20, rowsWritten: 2, durationMs: 3 },
    )).toEqual({ rowsRead: 30, rowsWritten: 3, durationMs: 5 })
  })

  it('返回预算违规详情', () => {
    const check = assertD1Budget(
      { rowsRead: 12_000, rowsWritten: 100, durationMs: 1200 },
      { rowsRead: 10_000, rowsWritten: 200, durationMs: 1000 },
    )
    expect(check.ok).toBe(false)
    expect(check.violations).toEqual([
      'D1 rows read 超预算: 12000/10000',
      'D1 查询耗时超预算: 1200/1000ms',
    ])
  })
})
