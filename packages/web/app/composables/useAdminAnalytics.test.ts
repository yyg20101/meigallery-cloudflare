import { describe, expect, it } from 'vitest'
import { analyticsDuplicateRate, isAnalyticsDuplicateRisk } from './useAdminAnalytics'

describe('useAdminAnalytics duplicate health', () => {
  it('少量低比例去重不作为风险提示', () => {
    expect(analyticsDuplicateRate(1, 2463)).toBeCloseTo(1 / 2464)
    expect(isAnalyticsDuplicateRisk(1, 2463)).toBe(false)
  })

  it('去重数量或比例偏高时作为风险提示', () => {
    expect(isAnalyticsDuplicateRisk(3, 100)).toBe(true)
    expect(isAnalyticsDuplicateRisk(10, 5000)).toBe(true)
  })
})
