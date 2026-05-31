import { describe, expect, it } from 'vitest'
import { normalizeHomeAdUrl } from './home-ad-settings'

describe('首页广告设置校验', () => {
  it('允许空链接表示不跳转', () => {
    expect(normalizeHomeAdUrl('')).toBe('')
    expect(normalizeHomeAdUrl('   ')).toBe('')
    expect(normalizeHomeAdUrl(null)).toBe('')
  })

  it('允许站内相对路径和 https 外链', () => {
    expect(normalizeHomeAdUrl('/discover?sort=hot')).toBe('/discover?sort=hot')
    expect(normalizeHomeAdUrl(' /cases ')).toBe('/cases')
    expect(normalizeHomeAdUrl('https://example.com/campaign')).toBe('https://example.com/campaign')
  })

  it('拒绝危险或不明确的广告链接', () => {
    const blocked = [
      'javascript:alert(1)',
      'data:text/html,hello',
      'http://example.com',
      '//example.com',
      '/\\example.com',
      'https://example.com/a b',
      '/discover\n?sort=hot',
    ]

    for (const url of blocked) {
      expect(() => normalizeHomeAdUrl(url)).toThrow('首页广告链接')
    }
  })
})
