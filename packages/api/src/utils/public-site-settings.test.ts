import { describe, expect, it } from 'vitest'
import { LEGACY_DEFAULT_SEO_TITLE, LEGACY_DEFAULT_SITE_NAME, sanitizePublicSiteSetting, sanitizePublicSiteSettings } from './public-site-settings'

describe('公开站点设置安全读取', () => {
  it('清空历史危险 URL 设置', () => {
    expect(sanitizePublicSiteSetting('site_icon', 'javascript:alert(1)')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', 'http://example.com/og.jpg')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://example.com/%0Ajavascript:alert(1)')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/admin/settings')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/api/media/public/site/icon.png')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_url', 'https://example.com/rules')).toBe('')
    expect(sanitizePublicSiteSetting('site_icon', 'https://localhost./icon.png')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://preview.local./campaign')).toBe('')
    expect(sanitizePublicSiteSetting('site_icon', 'https://example.com\\icon.png')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', 'https://example.com/%5Cog.jpg')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', 'https://example.com/og.jpg?signature=abc')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', 'https://example.com/og.jpg#signature=abc')).toBe('')
    expect(sanitizePublicSiteSetting('site_icon', '/discover?sort=hot')).toBe('')
    expect(sanitizePublicSiteSetting('og_image', '/api/media/public/avatars/user.png')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https:\\\\example.com\\campaign')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/discover?token=abc')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/discover#token=abc')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://example.com/campaign?api_key=abc')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://example.com/campaign#/callback?access_token=abc')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/login?redirect=')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/login?redirect=/admin')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/login?redirect=/api/settings/public')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/login?redirect=https%3A%2F%2Fevil.example%2Fcampaign')).toBe('')
    expect(sanitizePublicSiteSetting('home_ad_url', '/login?redirect=%2Flogin%3Fredirect%3D%2Fadmin')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_url', '/rules%5Cnext')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_url', '/rules?access_token=abc')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_url', '/rules#access_token=abc')).toBe('')
  })

  it('归一化允许的 URL 设置', () => {
    expect(sanitizePublicSiteSetting('site_icon', ' /api/media/public/site/icon.png ')).toBe('/api/media/public/site/icon.png')
    expect(sanitizePublicSiteSetting('og_image', 'HTTPS://example.com/og.jpg?next="x"')).toBe('https://example.com/og.jpg?next=%22x%22')
    expect(sanitizePublicSiteSetting('home_ad_url', ' /discover?sort=hot#top ')).toBe('/discover?sort=hot#top')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://example.com/campaign?utm_source=home')).toBe('https://example.com/campaign?utm_source=home')
    expect(sanitizePublicSiteSetting('home_ad_url', 'https://example.com/campaign#details')).toBe('https://example.com/campaign#details')
    expect(sanitizePublicSiteSetting('home_ad_url', '/login?redirect=/user')).toBe('/login?redirect=/user')
    expect(sanitizePublicSiteSetting('home_ad_url', '/gallery/summer-portrait')).toBe('/gallery/summer-portrait')
    expect(sanitizePublicSiteSetting('rules_page_url', ' /rules?from=entry ')).toBe('/rules?from=entry')
    expect(sanitizePublicSiteSetting('rules_page_url', ' /rules#top ')).toBe('/rules#top')
  })

  it('归一化公开布尔和 Pixel 设置', () => {
    expect(sanitizePublicSiteSetting('home_ad_enabled', 'true')).toBe(true)
    expect(sanitizePublicSiteSetting('facebook_pixel_enabled', 'false')).toBe(false)
    expect(sanitizePublicSiteSetting('facebook_pixel_id', ' 1234567890 ')).toBe('1234567890')
    expect(sanitizePublicSiteSetting('facebook_pixel_id', 'fbq("track")')).toBe('')
  })

  it('归一化数据分析公开设置', () => {
    expect(sanitizePublicSiteSetting('analytics_enabled', 'true')).toBe(true)
    expect(sanitizePublicSiteSetting('analytics_enabled', 'false')).toBe(false)
    expect(sanitizePublicSiteSetting('analytics_sample_rate', '0.03')).toBe(0.03)
    expect(sanitizePublicSiteSetting('analytics_sample_rate', '0.9')).toBe(0.05)
    expect(sanitizePublicSiteSetting('analytics_sample_rate', 'bad')).toBe(0.01)
    expect(sanitizePublicSiteSetting('analytics_consent_mode', 'granted')).toBe('granted')
    expect(sanitizePublicSiteSetting('analytics_consent_mode', 'bad')).toBe('limited')
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

  it('归一化 SEO 和前台短文案并清空历史异常文本', () => {
    expect(sanitizePublicSiteSetting('site_name', '  测试   图库站  ')).toBe('测试 图库站')
    expect(sanitizePublicSiteSetting('seo_title', 'x'.repeat(81))).toBe('')
    expect(sanitizePublicSiteSetting('seo_keywords', ' 授权图库, 写真\n#时尚写真，授权图库 ')).toBe('授权图库,写真,时尚写真')
    expect(sanitizePublicSiteSetting('seo_keywords', Array.from({ length: 31 }, (_, index) => `关键词${index}`).join(','))).toBe('')
    expect(sanitizePublicSiteSetting('home_hero_subtitle', 'x'.repeat(181))).toBe('')
    expect(sanitizePublicSiteSetting('rules_entry_summary', '入口\u0001说明')).toBe('')
    expect(sanitizePublicSiteSetting('rules_entry_icon', '<svg>')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_title', '入站规则')).toBe('入站规则')
  })

  it('清空公开响应中的历史默认站名和 SEO 标题并保留自定义标题', () => {
    const legacySettings = {
      site_name: LEGACY_DEFAULT_SITE_NAME,
      seo_title: LEGACY_DEFAULT_SEO_TITLE,
    }
    const customSettings = {
      site_name: '星耀传媒',
      seo_title: '星耀传媒 - 官方图库',
    }

    expect(sanitizePublicSiteSettings(legacySettings)).toEqual({
      site_name: '',
      seo_title: '',
      home_ad_active: false,
    })
    expect(sanitizePublicSiteSettings(customSettings)).toEqual({
      ...customSettings,
      home_ad_active: false,
    })
    expect(legacySettings.site_name).toBe(LEGACY_DEFAULT_SITE_NAME)
    expect(legacySettings.seo_title).toBe(LEGACY_DEFAULT_SEO_TITLE)
  })

  it('公开响应派生首页广告当前展示状态', () => {
    const now = new Date('2026-06-01T12:00:00.000Z')

    expect(sanitizePublicSiteSettings({
      home_ad_enabled: true,
      home_ad_starts_at: '2026-06-01T11:00:00.000Z',
      home_ad_ends_at: '2026-06-01T13:00:00.000Z',
    }, now).home_ad_active).toBe(true)

    expect(sanitizePublicSiteSettings({
      home_ad_enabled: true,
      home_ad_starts_at: '2026-06-01T13:00:00.000Z',
      home_ad_ends_at: '',
    }, now).home_ad_active).toBe(false)

    expect(sanitizePublicSiteSettings({
      home_ad_enabled: false,
      home_ad_starts_at: '',
      home_ad_ends_at: '',
    }, now).home_ad_active).toBe(false)
  })

  it('归一化首页内容配置并清空历史异常内容', () => {
    expect(sanitizePublicSiteSetting('home_hot_tag_limit', 12)).toBe('12')
    expect(sanitizePublicSiteSetting('home_hot_tag_limit', '31')).toBe('15')
    expect(sanitizePublicSiteSetting('home_featured_region_slugs', ' Canada,domestic,canada ')).toBe('canada,domestic')
    expect(sanitizePublicSiteSetting('home_featured_region_slugs', 'canada,../admin')).toBe('')
    expect(sanitizePublicSiteSetting('rules_page_content', '## 规则\r\n\r\n- 内容')).toBe('## 规则\n\n- 内容')
    expect(sanitizePublicSiteSetting('rules_modal_content', '规则\u0001内容')).toBe('')
  })
})
