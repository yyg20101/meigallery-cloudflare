import { describe, expect, it } from 'vitest'
import { isHomeAdTextKey, normalizeHomeAdText, normalizeHomeAdUrl } from './home-ad-settings'

describe('首页广告设置校验', () => {
  it('允许空链接表示不跳转', () => {
    expect(normalizeHomeAdUrl('')).toBe('')
    expect(normalizeHomeAdUrl('   ')).toBe('')
    expect(normalizeHomeAdUrl(null)).toBe('')
  })

  it('允许站内相对路径和 https 外链', () => {
    expect(normalizeHomeAdUrl('/discover?sort=hot#top')).toBe('/discover?sort=hot#top')
    expect(normalizeHomeAdUrl(' /cases ')).toBe('/cases')
    expect(normalizeHomeAdUrl('https://example.com/campaign')).toBe('https://example.com/campaign')
    expect(normalizeHomeAdUrl('HTTPS://example.com/campaign?next="x"')).toBe('https://example.com/campaign?next=%22x%22')
  })

  it('拒绝危险或不明确的广告链接', () => {
    const blocked = [
      'javascript:alert(1)',
      'data:text/html,hello',
      'http://example.com',
      'https://localhost/campaign',
      'https://127.0.0.1/campaign',
      'https://192.168.1.10/campaign',
      'https://preview.local/campaign',
      '//example.com',
      '/\\example.com',
      'https://example.com/a b',
      'https://example.com/%0Ajavascript:alert(1)',
      '/discover%20next',
      '/discover\n?sort=hot',
    ]

    for (const url of blocked) {
      expect(() => normalizeHomeAdUrl(url)).toThrow('首页广告链接')
    }
  })

  it('归一化首页广告文案并限制长度', () => {
    expect(isHomeAdTextKey('home_ad_title')).toBe(true)
    expect(isHomeAdTextKey('site_name')).toBe(false)
    expect(normalizeHomeAdText('home_ad_title', '  会员季   精选内容  ')).toBe('会员季 精选内容')
    expect(normalizeHomeAdText('home_ad_sponsor', null)).toBe('')

    expect(() => normalizeHomeAdText('home_ad_eyebrow', '超过十二个字符的广告活动眉标')).toThrow('首页广告眉标不能超过 12 个字符')
    expect(() => normalizeHomeAdText('home_ad_title', 'x'.repeat(41))).toThrow('首页广告标题不能超过 40 个字符')
    expect(() => normalizeHomeAdText('home_ad_summary', 'x'.repeat(121))).toThrow('首页广告摘要不能超过 120 个字符')
    expect(() => normalizeHomeAdText('home_ad_cta_label', 'x'.repeat(13))).toThrow('首页广告按钮文案不能超过 12 个字符')
    expect(() => normalizeHomeAdText('home_ad_sponsor', 'x'.repeat(31))).toThrow('首页广告来源说明不能超过 30 个字符')
    expect(() => normalizeHomeAdText('home_ad_title', '会员\u0001精选')).toThrow('首页广告标题不能包含控制字符')
  })
})
