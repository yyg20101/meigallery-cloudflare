import { describe, expect, it } from 'vitest'
import { clampActiveSeconds, parseAnalyticsRange, rangeToDays, toOperationDateShanghai } from './analytics-time'

describe('analytics-time', () => {
  it('使用 Asia/Shanghai 自然日', () => {
    expect(toOperationDateShanghai('2026-06-06T17:00:00.000Z')).toBe('2026-06-07')
  })

  it('限制有效浏览秒数', () => {
    expect(clampActiveSeconds(-5)).toBe(0)
    expect(clampActiveSeconds(12.9)).toBe(12)
    expect(clampActiveSeconds(3600)).toBe(1800)
  })

  it('解析快捷范围', () => {
    const now = new Date('2026-06-07T04:00:00.000Z')
    expect(parseAnalyticsRange({ range: '7d' }, now)).toEqual({ from: '2026-06-01', to: '2026-06-07', days: 7 })
    expect(parseAnalyticsRange({ range: '30d' }, now)).toEqual({ from: '2026-05-09', to: '2026-06-07', days: 30 })
    expect(parseAnalyticsRange({ range: '90d' }, now)).toEqual({ from: '2026-03-10', to: '2026-06-07', days: 90 })
  })

  it('校验自定义日期范围', () => {
    expect(parseAnalyticsRange({ from: '2026-06-01', to: '2026-06-07' })).toEqual({ from: '2026-06-01', to: '2026-06-07', days: 7 })
    expect(() => parseAnalyticsRange({ from: '2026/06/01', to: '2026-06-07' })).toThrow('YYYY-MM-DD')
    expect(() => parseAnalyticsRange({ from: '2026-02-31', to: '2026-03-02' })).toThrow('日期无效')
    expect(() => parseAnalyticsRange({ from: '2026-01-01', to: '2026-06-07' })).toThrow('不能超过 90 天')
    expect(() => parseAnalyticsRange({ from: '2026-06-07', to: '2026-06-01' })).toThrow('范围无效')
  })

  it('未知快捷范围回退 30 天', () => {
    expect(rangeToDays('bad')).toBe(30)
  })
})
