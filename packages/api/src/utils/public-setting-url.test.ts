import { describe, expect, it } from 'vitest'
import { normalizeInternalPathSetting, normalizePublicSettingUrl } from './public-setting-url'

describe('公开站点设置 URL 校验', () => {
  it('允许空 URL 表示不配置', () => {
    expect(normalizePublicSettingUrl('', '站点图标 URL')).toBe('')
    expect(normalizePublicSettingUrl('   ', '站点图标 URL')).toBe('')
    expect(normalizeInternalPathSetting(null, '规则页链接')).toBe('')
  })

  it('公开 URL 允许站内相对路径和 https 链接', () => {
    expect(normalizePublicSettingUrl('/api/media/public/site/icon.png', '站点图标 URL')).toBe('/api/media/public/site/icon.png')
    expect(normalizePublicSettingUrl('/discover?sort=hot#top', '站点图标 URL')).toBe('/discover?sort=hot#top')
    expect(normalizePublicSettingUrl(' https://example.com/og.jpg ', 'OG 封面图 URL')).toBe('https://example.com/og.jpg')
    expect(normalizePublicSettingUrl('HTTPS://example.com/og.jpg?next="x"', 'OG 封面图 URL')).toBe('https://example.com/og.jpg?next=%22x%22')
  })

  it('公开 URL 拒绝危险协议和不明确路径', () => {
    const blocked = [
      'javascript:alert(1)',
      'data:image/svg+xml,hello',
      'http://example.com/a.png',
      '//example.com/a.png',
      '/\\example.com/a.png',
      '/a b.png',
      '/discover%20next',
      'https://example.com/%0Ajavascript:alert(1)',
    ]

    for (const url of blocked) {
      expect(() => normalizePublicSettingUrl(url, '站点图标 URL')).toThrow('站点图标 URL')
    }
  })

  it('站内路径设置只允许明确相对路径', () => {
    expect(normalizeInternalPathSetting('/rules', '规则页链接')).toBe('/rules')
    expect(normalizeInternalPathSetting(' /rules?from=entry ', '规则页链接')).toBe('/rules?from=entry')
    expect(() => normalizeInternalPathSetting('https://example.com/rules', '规则页链接')).toThrow('规则页链接只允许站内相对路径')
    expect(() => normalizeInternalPathSetting('//example.com/rules', '规则页链接')).toThrow('规则页链接只允许站内相对路径')
    expect(() => normalizeInternalPathSetting('/rules next', '规则页链接')).toThrow('规则页链接不能包含空白或控制字符')
    expect(() => normalizeInternalPathSetting('/rules%20next', '规则页链接')).toThrow('规则页链接不能包含空白或控制字符')
  })
})
