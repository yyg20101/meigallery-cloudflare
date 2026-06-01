import { describe, expect, it } from 'vitest'
import { getHomeAdTextPreviewWarnings, isScheduledSiteFeatureActive, normalizeBooleanSetting, normalizeHomeAdText, normalizeInternalPath, normalizePublicSettingUrl, normalizeSiteSettingDateTime, normalizeSiteSettingPixelId } from './siteSettingsSecurity'

describe('siteSettingsSecurity', () => {
  it('公开 URL 只允许站内路径和 https 链接', () => {
    expect(normalizePublicSettingUrl(' /api/media/public/site/icon.png ')).toBe('/api/media/public/site/icon.png')
    expect(normalizePublicSettingUrl('HTTPS://example.com/og.jpg?next="x"')).toBe('https://example.com/og.jpg?next=%22x%22')
  })

  it('公开 URL 拒绝危险协议、协议相对链接和控制字符', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com/og.jpg',
      '//example.com/og.jpg',
      '/\\example.com/og.jpg',
      '/api/media/public/site/icon%20bad.png',
      'https://example.com/%0Ajavascript:alert(1)',
    ]) {
      expect(normalizePublicSettingUrl(url)).toBe('')
    }
  })

  it('公开 URL 拒绝本机和私网地址', () => {
    for (const url of [
      'https://localhost/og.jpg',
      'https://127.0.0.1/og.jpg',
      'https://10.0.0.1/og.jpg',
      'https://172.31.255.1/og.jpg',
      'https://192.168.1.10/og.jpg',
      'https://169.254.169.254/latest/meta-data',
      'https://preview.local/og.jpg',
    ]) {
      expect(normalizePublicSettingUrl(url)).toBe('')
    }
  })

  it('站内路径只允许明确相对路径', () => {
    expect(normalizeInternalPath(' /rules?from=entry#top ')).toBe('/rules?from=entry#top')
    expect(normalizeInternalPath('https://example.com/rules')).toBe('')
    expect(normalizeInternalPath('//example.com/rules')).toBe('')
    expect(normalizeInternalPath('/rules%20next')).toBe('')
  })

  it('归一化公开 Pixel ID 和布尔设置', () => {
    expect(normalizeSiteSettingPixelId(' 1234567890 ')).toBe('1234567890')
    expect(normalizeSiteSettingPixelId('fbq("track")')).toBe('')
    expect(normalizeBooleanSetting(true)).toBe(true)
    expect(normalizeBooleanSetting('true')).toBe(true)
    expect(normalizeBooleanSetting('TRUE')).toBe(false)
  })

  it('归一化首页广告文案并拒绝超长或控制字符', () => {
    expect(normalizeHomeAdText('home_ad_title', '  会员季   精选内容  ')).toBe('会员季 精选内容')
    expect(normalizeHomeAdText('home_ad_sponsor', null)).toBe('')
    expect(normalizeHomeAdText('home_ad_eyebrow', '超过十二个字符的广告活动眉标')).toBe('')
    expect(normalizeHomeAdText('home_ad_title', 'x'.repeat(41))).toBe('')
    expect(normalizeHomeAdText('home_ad_summary', 'x'.repeat(121))).toBe('')
    expect(normalizeHomeAdText('home_ad_cta_label', 'x'.repeat(13))).toBe('')
    expect(normalizeHomeAdText('home_ad_sponsor', 'x'.repeat(31))).toBe('')
    expect(normalizeHomeAdText('home_ad_title', '会员\u0001精选')).toBe('')
  })

  it('生成首页广告文案安全提示', () => {
    expect(getHomeAdTextPreviewWarnings({
      home_ad_eyebrow: '  本周   推荐  ',
      home_ad_title: 'x'.repeat(41),
      home_ad_summary: '会员\u0001精选',
      home_ad_cta_label: '',
      home_ad_sponsor: 'x'.repeat(31),
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
