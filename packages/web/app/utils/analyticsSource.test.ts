import { describe, expect, it } from 'vitest'
import { sourceChannelFromUtmMedium } from './analyticsSource'

describe('analyticsSource', () => {
  it.each(['ad', 'ads', 'paid', 'cpc', 'paid_social', 'paid-social', 'paidsocial'])(
    '将付费媒介 %s 统一识别为广告',
    (medium) => {
      expect(sourceChannelFromUtmMedium(medium)).toBe('ad')
    },
  )

  it.each([
    ['social', 'social'],
    ['organic_search', 'search'],
    ['internal', 'internal'],
    ['unknown-medium', 'referral'],
  ] as const)('保持 %s 的渠道口径为 %s', (medium, channel) => {
    expect(sourceChannelFromUtmMedium(medium)).toBe(channel)
  })
})
