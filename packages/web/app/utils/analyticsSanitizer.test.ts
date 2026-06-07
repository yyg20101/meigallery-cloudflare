import { describe, expect, it } from 'vitest'
import {
  detectAnalyticsDeviceType,
  getViewportBucket,
  sanitizeAnalyticsPath,
  sanitizeAnalyticsProps,
  sanitizeReferrer,
} from './analyticsSanitizer'

describe('analyticsSanitizer', () => {
  it('拒绝敏感 URL、后台/API/资源路径', () => {
    expect(sanitizeAnalyticsPath('/search?token=abc')).toBeNull()
    expect(sanitizeAnalyticsPath('/admin/galleries')).toBeNull()
    expect(sanitizeAnalyticsPath('/api/me')).toBeNull()
    expect(sanitizeAnalyticsPath('/_nuxt/app.js')).toBeNull()
    expect(sanitizeAnalyticsPath('/covers/a.jpg')).toBeNull()
  })

  it('只保留公开筛选参数并移除搜索词明文', () => {
    expect(sanitizeAnalyticsPath('/search?q=secret&tags=city&sort=hot&page=2')).toBe('/search?tags=city&sort=hot&page=2')
    expect(sanitizeAnalyticsPath('/discover?region=guangdong&access_token=bad')).toBeNull()
  })

  it('referrer 只保留 host 和路径，不保留 query/hash', () => {
    expect(sanitizeReferrer('https://example.com/from/page?token=bad')).toEqual({ referrer: '', referrerHost: '' })
    expect(sanitizeReferrer('https://example.com/from/page?utm_source=x#top')).toEqual({
      referrer: 'https://example.com/from/page',
      referrerHost: 'example.com',
    })
    expect(sanitizeReferrer('https://meigallery.local/a', 'meigallery.local')).toEqual({ referrer: '', referrerHost: '' })
  })

  it('清洗 props 中的邮箱、电话、URL 和非法值', () => {
    const props = sanitizeAnalyticsProps({
      method_type: 'wechat 13800138000',
      target_host: 'https://example.com/a?x=1',
      tag_slugs: ['a', 'b'],
      nested: { bad: true },
      unsafeKey: 'ignored',
      count: Number.NaN,
    })

    expect(props.method_type).toContain('[redacted_phone]')
    expect(props.target_host).toBe('[redacted_url]')
    expect(props.tag_slugs).toEqual(['a', 'b'])
    expect(props.nested).toBeUndefined()
    expect(props.unsafeKey).toBeUndefined()
    expect(props.count).toBeUndefined()
  })

  it('设备类型和视口分桶稳定', () => {
    expect(detectAnalyticsDeviceType(360)).toBe('mobile')
    expect(detectAnalyticsDeviceType(800)).toBe('tablet')
    expect(detectAnalyticsDeviceType(1200)).toBe('desktop')
    expect(getViewportBucket(375)).toBe(360)
    expect(getViewportBucket(1440)).toBe(1440)
  })
})
