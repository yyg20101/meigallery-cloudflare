import { describe, expect, it } from 'vitest'
import { analyticsSourceLabel, enrichAnalyticsDisplayRow } from './analytics-display'

describe('analytics-display', () => {
  it('将常见 FB 和 Meta 来源显示为站内归因来源', () => {
    expect(analyticsSourceLabel({ source_name: 'fb', source_channel: 'social' })).toBe('Facebook UTM 来源')
    expect(analyticsSourceLabel({ source_name: 'facebook', source_channel: 'social' })).toBe('Facebook UTM 来源')
    expect(analyticsSourceLabel({ source_name: 'meta', source_channel: 'ad' })).toBe('Meta UTM 来源')
    expect(analyticsSourceLabel({ source_name: 'l.facebook.com', source_channel: 'social' })).toBe('Facebook referrer 来源')
  })

  it('已创建推广来源的自定义文案优先展示', () => {
    const row = enrichAnalyticsDisplayRow({
      source_name: 'fb',
      source_channel: 'ad',
      tracking_source_label: 'FB 六月投放',
    })

    expect(row.source_label).toBe('FB 六月投放')
    expect(row.sourceCode).toBe('fb')
  })
})
