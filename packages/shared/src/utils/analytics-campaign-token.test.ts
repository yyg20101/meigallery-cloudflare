import { describe, expect, it } from 'vitest'
import { normalizeAnalyticsCampaignToken } from './analytics-campaign-token'

describe('normalizeAnalyticsCampaignToken', () => {
  it('保留小写化后的广告素材标识', () => {
    expect(normalizeAnalyticsCampaignToken(' Chat-A.2026 ')).toBe('chat-a.2026')
  })

  it.each([
    'user@example.com',
    '+86 138 0000 0000',
    '13800000000',
    'https://example.com/private',
    'creative=a',
  ])('拒绝可能包含敏感数据的 utm_content：%s', (value) => {
    expect(normalizeAnalyticsCampaignToken(value)).toBe('')
  })

  it('在校验前保留既有长度截断行为', () => {
    expect(normalizeAnalyticsCampaignToken(`creative-${'a'.repeat(200)}`)).toHaveLength(120)
  })
})
