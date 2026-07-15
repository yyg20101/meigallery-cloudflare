import { describe, expect, it } from 'vitest'
import { canTrackMarketing, normalizeMarketingConsent } from './marketingConsent'

describe('marketingConsent', () => {
  it('只接受明确的营销授权状态', () => {
    expect(normalizeMarketingConsent('granted')).toBe('granted')
    expect(normalizeMarketingConsent('denied')).toBe('denied')
    expect(normalizeMarketingConsent('limited')).toBe('limited')
    expect(normalizeMarketingConsent('unexpected')).toBe('limited')
  })

  it('营销授权只表达用户同意，连接可用性由 bootstrap 决定', () => {
    expect(canTrackMarketing('granted')).toBe(true)
    expect(canTrackMarketing('limited')).toBe(false)
    expect(canTrackMarketing('denied')).toBe(false)
  })
})
