import { describe, expect, it } from 'vitest'
import { canTrackMarketing, normalizeMarketingConsent } from './marketingConsent'

describe('marketingConsent', () => {
  it('只接受明确的营销授权状态', () => {
    expect(normalizeMarketingConsent('granted')).toBe('granted')
    expect(normalizeMarketingConsent('denied')).toBe('denied')
    expect(normalizeMarketingConsent('limited')).toBe('limited')
    expect(normalizeMarketingConsent('unexpected')).toBe('limited')
  })

  it('只有 granted 且 Meta 模式可运行时允许营销追踪', () => {
    expect(canTrackMarketing('granted', 'production')).toBe(true)
    expect(canTrackMarketing('granted', 'test')).toBe(true)
    expect(canTrackMarketing('limited', 'production')).toBe(false)
    expect(canTrackMarketing('denied', 'production')).toBe(false)
    expect(canTrackMarketing('granted', 'disabled')).toBe(false)
  })
})
