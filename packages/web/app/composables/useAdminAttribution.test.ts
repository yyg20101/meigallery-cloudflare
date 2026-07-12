import { describe, expect, it } from 'vitest'
import {
  attributionDuplicateRate,
  attributionRangeQuery,
  attributionRouteQuery,
  normalizeAttributionRangePreset,
} from './useAdminAttribution'

describe('useAdminAttribution', () => {
  it('单日查询转换为 from/to', () => {
    expect(attributionRangeQuery('day', '2026-07-09')).toEqual({ from: '2026-07-09', to: '2026-07-09' })
  })

  it('单日路由查询保留 range 和 date', () => {
    expect(attributionRouteQuery('day', '2026-07-09')).toEqual({ range: 'day', date: '2026-07-09' })
  })

  it('从路由查询识别归因范围', () => {
    expect(normalizeAttributionRangePreset('day')).toBe('day')
    expect(normalizeAttributionRangePreset('90d')).toBe('90d')
    expect(normalizeAttributionRangePreset('unknown')).toBe('7d')
  })

  it('重复率按 duplicate / total 计算', () => {
    expect(attributionDuplicateRate(1, 99)).toBeCloseTo(0.01)
  })
})
