import { describe, expect, it } from 'vitest'
import {
  parseRecommendationRuleRegions,
  recommendationFallbackCoversTargetRegions,
  recommendationRuleMatchesRegion,
} from './app-recommendation-region'

describe('App 推荐地区作用域', () => {
  it('把空数组解释为全局规则，并安全拒绝非法配置', () => {
    expect(parseRecommendationRuleRegions('[]')).toEqual([])
    expect(parseRecommendationRuleRegions('["cn-bj","cn-sh","cn-bj"]')).toEqual(['cn-bj', 'cn-sh'])
    expect(parseRecommendationRuleRegions('["CN-BJ"]')).toBeNull()
    expect(parseRecommendationRuleRegions('{"region":"cn-bj"}')).toBeNull()
    expect(parseRecommendationRuleRegions('not-json')).toBeNull()
  })

  it('区分 capability 探测、未选地区和明确地区', () => {
    expect(recommendationRuleMatchesRegion('["cn-bj"]', undefined)).toBe(true)
    expect(recommendationRuleMatchesRegion('["cn-bj"]', null)).toBe(false)
    expect(recommendationRuleMatchesRegion('["cn-bj"]', 'cn-bj')).toBe(true)
    expect(recommendationRuleMatchesRegion('["cn-bj"]', 'cn-sh')).toBe(false)
    expect(recommendationRuleMatchesRegion('[]', null)).toBe(true)
    expect(recommendationRuleMatchesRegion('[]', 'cn-sh')).toBe(true)
  })

  it('要求回退作用域完整覆盖目标作用域', () => {
    expect(recommendationFallbackCoversTargetRegions('[]', '[]')).toBe(true)
    expect(recommendationFallbackCoversTargetRegions('[]', '["cn-bj"]')).toBe(false)
    expect(recommendationFallbackCoversTargetRegions('["cn-bj"]', '[]')).toBe(true)
    expect(recommendationFallbackCoversTargetRegions('["cn-bj"]', '["cn-bj","cn-sh"]')).toBe(true)
    expect(recommendationFallbackCoversTargetRegions('["cn-bj","cn-sh"]', '["cn-bj"]')).toBe(false)
  })
})
