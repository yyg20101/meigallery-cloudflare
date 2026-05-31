import { describe, expect, it } from 'vitest'
import { normalizeHomeAdUrl } from './home-ad-settings'

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
})
