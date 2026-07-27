import { describe, expect, it } from 'vitest'
import { getHomeAdTextPreviewWarnings, isScheduledSiteFeatureActive, normalizeAnalyticsConsentMode, normalizeAnalyticsSampleRate, normalizeBooleanSetting, normalizeFeaturedRegionSlugs, normalizeHomeAdText, normalizeHomeAdUrl, normalizeHomeHotTagLimit, normalizeInternalPath, normalizePublicImageSettingUrl, normalizePublicSettingUrl, normalizeSeoKeywords, normalizeSiteSettingDateTime, safeRulesMarkdown, safeSiteText } from './siteSettingsSecurity'

describe('siteSettingsSecurity', () => {
  it('公开 URL 只允许站内路径和 https 链接', () => {
    expect(normalizePublicSettingUrl(' /api/media/public/site/icon.png ')).toBe('/api/media/public/site/icon.png')
    expect(normalizePublicSettingUrl('HTTPS://example.com/og.jpg?next="x"')).toBe('https://example.com/og.jpg?next=%22x%22')
    expect(normalizePublicSettingUrl('/discover?sort=hot&key=style#top')).toBe('/discover?sort=hot&key=style#top')
    expect(normalizePublicSettingUrl('https://example.com/og.jpg?utm_source=home')).toBe('https://example.com/og.jpg?utm_source=home')
    expect(normalizePublicSettingUrl('https://example.com/og.jpg#preview')).toBe('https://example.com/og.jpg#preview')
  })

  it('公开 URL 拒绝凭证类 URL 参数', () => {
    for (const url of [
      'https://example.com/og.jpg?token=abc',
      'https://example.com/og.jpg?ACCESS_TOKEN=abc',
      'https://example.com/og.jpg?api-key=abc',
      'https://example.com/og.jpg?client_secret=abc',
      'https://example.com/og.jpg?x-amz-signature=abc',
      'https://example.com/og.jpg?Key-Pair-Id=abc',
      '/discover?auth_token=abc',
      '/search?session_id=abc',
      'https://example.com/og.jpg#token=abc',
      'https://example.com/og.jpg#/callback?access_token=abc',
      'https://example.com/og.jpg#state=ok&signature=abc',
      'https://example.com/og.jpg#access_token%3Dabc',
      '/discover#api-key=abc',
    ]) {
      expect(normalizePublicSettingUrl(url)).toBe('')
    }
  })

  it('公开图片 URL 只允许站点公开媒体路径和 https 链接', () => {
    expect(normalizePublicImageSettingUrl(' /api/media/public/site/icon.png ')).toBe('/api/media/public/site/icon.png')
    expect(normalizePublicImageSettingUrl('HTTPS://example.com/og.jpg?next="x"')).toBe('https://example.com/og.jpg?next=%22x%22')
    expect(normalizePublicImageSettingUrl('https://example.com/og.jpg?utm_source=home')).toBe('https://example.com/og.jpg?utm_source=home')
    expect(normalizePublicImageSettingUrl('https://example.com/og.jpg?signature=abc')).toBe('')
    expect(normalizePublicImageSettingUrl('https://example.com/og.jpg#signature=abc')).toBe('')
    expect(normalizePublicImageSettingUrl('/discover?sort=hot')).toBe('')
    expect(normalizePublicImageSettingUrl('/api/media/public/avatars/user.png')).toBe('')
  })

  it('公开 URL 拒绝危险协议、协议相对链接和控制字符', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com/og.jpg',
      '//example.com/og.jpg',
      '/\\example.com/og.jpg',
      '/discover\\next',
      '/discover%5Cnext',
      '/api/media/public/site/icon%20bad.png',
      'https:\\\\example.com\\og.jpg',
      'https://example.com\\og.jpg',
      'https://example.com/%5Cog.jpg',
      'https://example.com/%0Ajavascript:alert(1)',
    ]) {
      expect(normalizePublicSettingUrl(url)).toBe('')
    }
  })

  it('公开 URL 拒绝包含用户名或密码的 https 链接', () => {
    for (const url of [
      'https://user@example.com/og.jpg',
      'https://user:pass@example.com/og.jpg',
      'https://%E7%94%A8%E6%88%B7@example.com/og.jpg',
    ]) {
      expect(normalizePublicSettingUrl(url)).toBe('')
    }
  })

  it('公开 URL 拒绝本机和非公网 IPv4 地址', () => {
    for (const url of [
      'https://localhost/og.jpg',
      'https://localhost./og.jpg',
      'https://localhost%2e/og.jpg',
      'https://127.0.0.1/og.jpg',
      'https://127.1/og.jpg',
      'https://2130706433/og.jpg',
      'https://0x7f000001/og.jpg',
      'https://0177.0.0.1/og.jpg',
      'https://10.0.0.1/og.jpg',
      'https://172.31.255.1/og.jpg',
      'https://192.168.1.10/og.jpg',
      'https://0xc0a8010a/og.jpg',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/og.jpg',
      'https://192.0.2.10/og.jpg',
      'https://198.18.0.1/og.jpg',
      'https://198.51.100.10/og.jpg',
      'https://203.0.113.10/og.jpg',
      'https://224.0.0.1/og.jpg',
      'https://240.0.0.1/og.jpg',
      'https://255.255.255.255/og.jpg',
      'https://preview.local/og.jpg',
      'https://preview.local./og.jpg',
      'https://[::1]/og.jpg',
      'https://[fc00::1]/og.jpg',
      'https://[2001:db8::1]/og.jpg',
    ]) {
      expect(normalizePublicSettingUrl(url)).toBe('')
    }
  })

  it('首页广告 URL 只允许公开前台路径或 https 外链', () => {
    expect(normalizeHomeAdUrl('/')).toBe('/')
    expect(normalizeHomeAdUrl(' /discover?sort=hot#top ')).toBe('/discover?sort=hot#top')
    expect(normalizeHomeAdUrl('/gallery/summer-portrait')).toBe('/gallery/summer-portrait')
    expect(normalizeHomeAdUrl('/cases/spring-lookbook')).toBe('/cases/spring-lookbook')
    expect(normalizeHomeAdUrl('/search?q=夏日')).toBe('/search?q=%E5%A4%8F%E6%97%A5')
    expect(normalizeHomeAdUrl('/login?redirect=/user')).toBe('/login?redirect=/user')
    expect(normalizeHomeAdUrl('/login?redirect=%2Fgallery%2Fsummer-portrait')).toBe('/login?redirect=%2Fgallery%2Fsummer-portrait')
    expect(normalizeHomeAdUrl('/discover#top')).toBe('/discover#top')
    expect(normalizeHomeAdUrl('HTTPS://example.com/campaign?next="x"')).toBe('https://example.com/campaign?next=%22x%22')
    expect(normalizeHomeAdUrl('https://example.com/campaign?utm_source=home')).toBe('https://example.com/campaign?utm_source=home')
    expect(normalizeHomeAdUrl('https://example.com/campaign#details')).toBe('https://example.com/campaign#details')

    for (const url of [
      '/admin',
      '/admin/settings',
      '/api/settings/public',
      '/api/media/public/site/icon.png',
      '/_nuxt/entry.js',
      '/cdn-cgi/trace',
      'https://localhost./campaign',
      'https://2130706433/campaign',
      'https://0x7f000001/campaign',
      'https://0177.0.0.1/campaign',
      'https://127.1/campaign',
      'https://[::1]/campaign',
      'https://[fc00::1]/campaign',
      'https://[2001:db8::1]/campaign',
      'https://preview.local./campaign',
      'https://example.com/campaign?api_key=abc',
      'https://example.com/campaign?signature=abc',
      'https://example.com/campaign#token=abc',
      'https://example.com/campaign#/callback?access_token=abc',
      '/discover?token=abc',
      '/discover#api-key=abc',
      '/login?redirect=',
      '/login?redirect=/admin',
      '/login?redirect=/api/settings/public',
      '/login?redirect=https%3A%2F%2Fevil.example%2Fcampaign',
      '/register?next=//evil.example/campaign',
      '/login?redirect=%2Flogin%3Fredirect%3D%2Fadmin',
      '/search?access-token=abc',
      '/search#access-token=abc',
      'javascript:alert(1)',
    ]) {
      expect(normalizeHomeAdUrl(url)).toBe('')
    }
  })

  it('站内路径只允许明确相对路径', () => {
    expect(normalizeInternalPath(' /rules?from=entry#top ')).toBe('/rules?from=entry#top')
    expect(normalizeInternalPath(' /rules#top ')).toBe('/rules#top')
    expect(normalizeInternalPath('https://example.com/rules')).toBe('')
    expect(normalizeInternalPath('//example.com/rules')).toBe('')
    expect(normalizeInternalPath('/rules?access_token=abc')).toBe('')
    expect(normalizeInternalPath('/rules#access_token=abc')).toBe('')
    expect(normalizeInternalPath('/rules%20next')).toBe('')
    expect(normalizeInternalPath('/rules\\next')).toBe('')
    expect(normalizeInternalPath('/rules%5Cnext')).toBe('')
  })

  it('归一化布尔设置', () => {
    expect(normalizeBooleanSetting(true)).toBe(true)
    expect(normalizeBooleanSetting('true')).toBe(true)
    expect(normalizeBooleanSetting('TRUE')).toBe(false)
  })

  it('归一化数据分析设置', () => {
    expect(normalizeAnalyticsSampleRate('')).toBe(0.01)
    expect(normalizeAnalyticsSampleRate('0.03')).toBe(0.03)
    expect(normalizeAnalyticsSampleRate('0.9')).toBe(0.05)
    expect(normalizeAnalyticsSampleRate('bad')).toBe(0.01)
    expect(normalizeAnalyticsConsentMode('granted')).toBe('granted')
    expect(normalizeAnalyticsConsentMode('limited')).toBe('limited')
    expect(normalizeAnalyticsConsentMode('denied')).toBe('denied')
    expect(normalizeAnalyticsConsentMode('bad')).toBe('limited')
  })

  it('归一化 SEO 和前台短文案并拒绝异常文本', () => {
    expect(safeSiteText('site_name', '  测试   图库站  ')).toBe('测试 图库站')
    expect(safeSiteText('seo_title', 'x'.repeat(81))).toBe('')
    expect(safeSiteText('home_hero_subtitle', 'x'.repeat(181))).toBe('')
    expect(safeSiteText('rules_entry_summary', '入口\u0001说明')).toBe('')
    expect(safeSiteText('rules_entry_icon', '<svg>')).toBe('')
    expect(safeSiteText('rules_page_title', '入站规则')).toBe('入站规则')
  })

  it('归一化 SEO 关键词池为前台可复用数组', () => {
    expect(normalizeSeoKeywords(' 授权图库, 写真\n#时尚写真，授权图库 ')).toEqual(['授权图库', '写真', '时尚写真'])
    expect(normalizeSeoKeywords(Array.from({ length: 31 }, (_, index) => `关键词${index}`).join(','))).toEqual([])
    expect(normalizeSeoKeywords(`授权图库,${'x'.repeat(25)}`)).toEqual([])
  })

  it('归一化首页内容配置并拒绝异常历史值', () => {
    expect(normalizeHomeHotTagLimit('')).toBe(15)
    expect(normalizeHomeHotTagLimit('12')).toBe(12)
    expect(normalizeHomeHotTagLimit('31')).toBe(30)
    expect(normalizeHomeHotTagLimit('abc')).toBe(15)

    expect(normalizeFeaturedRegionSlugs(' Canada,domestic,canada,toronto-city ')).toEqual(['canada', 'domestic', 'toronto-city'])
    expect(normalizeFeaturedRegionSlugs('canada,../admin')).toEqual([])
    expect(normalizeFeaturedRegionSlugs(Array.from({ length: 13 }, (_, index) => `tag-${index}`).join(','))).toEqual([])

    expect(safeRulesMarkdown('## 规则\r\n\r\n- 内容')).toBe('## 规则\n\n- 内容')
    expect(safeRulesMarkdown('规则\u0001内容')).toBe('')
    expect(safeRulesMarkdown('x'.repeat(8001))).toBe('')
  })

  it('归一化首页广告文案并拒绝超长或控制字符', () => {
    expect(normalizeHomeAdText('home_ad_title', '  会员季   精选内容  ')).toBe('会员季 精选内容')
    expect(normalizeHomeAdText('home_ad_sponsor', null)).toBe('')
    expect(normalizeHomeAdText('home_ad_eyebrow', 'x'.repeat(17))).toBe('')
    expect(normalizeHomeAdText('home_ad_title', 'x'.repeat(65))).toBe('')
    expect(normalizeHomeAdText('home_ad_summary', 'x'.repeat(181))).toBe('')
    expect(normalizeHomeAdText('home_ad_cta_label', 'x'.repeat(17))).toBe('')
    expect(normalizeHomeAdText('home_ad_sponsor', 'x'.repeat(41))).toBe('')
    expect(normalizeHomeAdText('home_ad_title', '会员\u0001精选')).toBe('')
  })

  it('生成首页广告文案安全提示', () => {
    expect(getHomeAdTextPreviewWarnings({
      home_ad_eyebrow: '  本周   推荐  ',
      home_ad_title: 'x'.repeat(65),
      home_ad_summary: '会员\u0001精选',
      home_ad_cta_label: '',
      home_ad_sponsor: 'x'.repeat(41),
    })).toEqual([
      '广告标题已按安全规则清空',
      '广告摘要已按安全规则清空',
      '赞助/来源说明已按安全规则清空',
    ])
  })

  it('归一化站点设置时间并判断定时功能状态', () => {
    expect(normalizeSiteSettingDateTime('2026-06-01T08:30:00+08:00')).toBe('2026-06-01T00:30:00.000Z')
    expect(normalizeSiteSettingDateTime('')).toBe('')
    expect(normalizeSiteSettingDateTime('not-a-date')).toBe('')

    const now = new Date('2026-06-01T12:00:00.000Z')
    expect(isScheduledSiteFeatureActive(true, '2026-06-01T11:00:00.000Z', '2026-06-01T13:00:00.000Z', now)).toBe(true)
    expect(isScheduledSiteFeatureActive(true, '2026-06-01T13:00:00.000Z', '', now)).toBe(false)
    expect(isScheduledSiteFeatureActive(true, '', '2026-06-01T12:00:00.000Z', now)).toBe(false)
    expect(isScheduledSiteFeatureActive(false, '', '', now)).toBe(false)
  })
})
