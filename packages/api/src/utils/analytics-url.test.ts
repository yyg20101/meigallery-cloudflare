import { describe, expect, it } from 'vitest'
import {
  deriveSourceAttribution,
  hasSensitiveAnalyticsUrl,
  sanitizeAnalyticsPath,
  sanitizeReferrer,
  stripSensitiveParams,
} from './analytics-url'

describe('analytics-url', () => {
  it('清洗站内路径，只保留公开筛选参数', () => {
    expect(sanitizeAnalyticsPath('/discover?tag=outdoor&token=secret&sort=newest#top')).toBeNull()
    expect(sanitizeAnalyticsPath('/discover?tag=outdoor&sort=newest&utm_source=ad')).toBe('/discover?tag=outdoor&sort=newest')
    expect(sanitizeAnalyticsPath('/admin/users')).toBeNull()
    expect(sanitizeAnalyticsPath('/api/media/asset/access')).toBeNull()
  })

  it('识别 query、hash 和凭据中的敏感值', () => {
    expect(hasSensitiveAnalyticsUrl('https://example.com/?access_token=abc')).toBe(true)
    expect(hasSensitiveAnalyticsUrl('https://example.com/#/done?signature=abc')).toBe(true)
    expect(hasSensitiveAnalyticsUrl('https://user:pass@example.com/')).toBe(true)
    expect(hasSensitiveAnalyticsUrl('https://example.com/path?tag=ok')).toBe(false)
  })

  it('可以移除敏感 query 并丢弃 hash', () => {
    expect(stripSensitiveParams('/gallery/demo?tag=a&token=secret#frag')).toBe('/gallery/demo?tag=a')
    expect(stripSensitiveParams('https://example.com/path?signature=abc&page=2#token=bad')).toBe('https://example.com/path?page=2')
  })

  it('清洗 referrer 时只保留 host 和 path', () => {
    expect(sanitizeReferrer('https://google.com/search?q=test', '616618.xyz')).toEqual({
      host: 'google.com',
      path: '/search',
    })
    expect(sanitizeReferrer('https://616618.xyz/gallery/a', '616618.xyz')).toBeNull()
    expect(sanitizeReferrer('https://evil.com/?token=secret', '616618.xyz')).toBeNull()
  })

  it('按邀请、广告、UTM、搜索、社交和直接访问推导来源', () => {
    expect(deriveSourceAttribution({ inviteCodeId: 'inv_1', referrerHost: 'google.com' })).toEqual({ channel: 'invite', name: 'invite' })
    expect(deriveSourceAttribution({ adId: 'ad_1' })).toEqual({ channel: 'ad', name: 'ad' })
    expect(deriveSourceAttribution({ utmSource: 'Newsletter', utmMedium: 'paid' })).toEqual({ channel: 'ad', name: 'newsletter' })
    expect(deriveSourceAttribution({ utmSource: 'Meta-Contact-A', utmMedium: 'paid_social' })).toEqual({ channel: 'ad', name: 'meta-contact-a' })
    expect(deriveSourceAttribution({ trackingSourceSlug: 'telegram-june', utmSource: 'telegram-june', utmMedium: 'social' })).toEqual({ channel: 'social', name: 'telegram-june' })
    expect(deriveSourceAttribution({ referrerHost: 'www.google.com' })).toEqual({ channel: 'search', name: 'www.google.com' })
    expect(deriveSourceAttribution({ referrerHost: 't.me' })).toEqual({ channel: 'social', name: 't.me' })
    expect(deriveSourceAttribution({})).toEqual({ channel: 'direct', name: 'direct' })
  })
})
