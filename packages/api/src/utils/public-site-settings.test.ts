import { describe, expect, it } from 'vitest'
import { sanitizePublicSiteSetting } from './public-site-settings'

describe('公开站点设置安全读取', () => {
  it('清空历史危险 URL 设置', () => {
    expect(sanitizePublicSiteSetting('site_icon', 'javascript:alert(1)')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', 'http://example.com/og.jpg')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://example.com/%0Ajavascript:alert(1)')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/admin/settings')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/api/media/public/site/icon.png')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_url', 'https://example.com/rules')).toBe('')
    expect(sanitizePublicSiteSetting('site_icon', 'https://example.com\\icon.png')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', 'https://example.com/%5Cog.jpg')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https:\\\\example.com\\campaign')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_url', '/rules%5Cnext')).toBe('')
  })

  it('归一化允许的 URL 设置', () => {
    expect(sanitizePublicSiteSetting('site_icon', ' /api/media/public/site/icon.png ')).toBe('/api/media/public/site/icon.png')
    expect(sanitizePublicSiteSetting('og_image', 'HTTPS://example.com/og.jpg?next="x"')).toBe('https://example.com/og.jpg?next=%22x%22')
    expect(sanitizePublicSiteSetting('home_ad_url', ' /discover?sort=hot#top ')).toBe('/discover?sort=hot#top')
    expect(sanitizePublicSiteSetting('home_ad_url', '/gallery/summer-portrait')).toBe('/gallery/summer-portrait')
    expect(sanitizePublicSiteSetting('rules_page_url', ' /rules?from=entry ')).toBe('/rules?from=entry')
  })

  it('归一化公开布尔和 Pixel 设置', () => {
    expect(sanitizePublicSiteSetting('home_ad_enabled', 'true')).toBe(true)
    expect(sanitizePublicSiteSetting('facebook_pixel_enabled', 'false')).toBe(false)
    expect(sanitizePublicSiteSetting('facebook_pixel_id', ' 1234567890 ')).toBe('1234567890')
    expect(sanitizePublicSiteSetting('facebook_pixel_id', 'fbq("track")')).toBe('')
  })

  it('归一化首页广告排期并清空历史异常时间', () => {
    expect(sanitizePublicSiteSetting('home_ad_starts_at', '2026-06-01T08:30:00+08:00')).toBe('2026-06-01T00:30:00.000Z')
    expect(sanitizePublicSiteSetting('home_ad_ends_at', 'not-a-date')).toBe('')
  })

  it('归一化首页广告文案并清空历史异常文案', () => {
    expect(sanitizePublicSiteSetting('home_ad_title', '  会员季   精选内容  ')).toBe('会员季 精选内容')
    expect(sanitizePublicSiteSetting('home_ad_eyebrow', 'x'.repeat(13))).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_summary', 'x'.repeat(121))).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_cta_label', '查看\u0001推荐')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_sponsor', 'x'.repeat(31))).toBe('')
  })

  it('保留非安全敏感设置原值', () => {
    expect(sanitizePublicSiteSetting('site_name', 'MeiGallery')).toBe('MeiGallery')
    expect(sanitizePublicSiteSetting('home_hot_tag_limit', 12)).toBe(12)
  })
})
