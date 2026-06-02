import { describe, expect, it } from 'vitest'
import { normalizeInternalPathSetting, normalizePublicImageSettingUrl, normalizePublicSettingUrl } from './public-setting-url'

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
    expect(normalizePublicSettingUrl('https://example.com/og.jpg?utm_source=ad', 'OG 封面图 URL')).toBe('https://example.com/og.jpg?utm_source=ad')
    expect(normalizePublicSettingUrl('/discover?sort=hot&key=style#top', '首页广告链接')).toBe('/discover?sort=hot&key=style#top')
  })

  it('公开 URL 拒绝凭证类查询参数', () => {
    const blocked = [
      'https://example.com/og.jpg?token=abc',
      'https://example.com/og.jpg?ACCESS_TOKEN=abc',
      'https://example.com/og.jpg?api-key=abc',
      'https://example.com/og.jpg?client_secret=abc',
      'https://example.com/og.jpg?x-amz-signature=abc',
      'https://example.com/og.jpg?Key-Pair-Id=abc',
      '/discover?auth_token=abc',
      '/search?session_id=abc',
    ]

    for (const url of blocked) {
      expect(() => normalizePublicSettingUrl(url, '首页广告链接')).toThrow('首页广告链接不能包含凭证类查询参数')
    }
  })

  it('公开图片 URL 只允许站点公开媒体路径和安全 https 链接', () => {
    expect(normalizePublicImageSettingUrl('/api/media/public/site/icon.png', '站点图标 URL')).toBe('/api/media/public/site/icon.png')
    expect(normalizePublicImageSettingUrl('HTTPS://example.com/og.jpg?next="x"', 'OG 封面图 URL')).toBe('https://example.com/og.jpg?next=%22x%22')
    expect(() => normalizePublicImageSettingUrl('/discover?sort=hot#top', '站点图标 URL')).toThrow('站点图标 URL只允许站点公开媒体路径或 https 链接')
    expect(() => normalizePublicImageSettingUrl('/api/media/public/avatars/user.png', 'OG 封面图 URL')).toThrow('OG 封面图 URL只允许站点公开媒体路径或 https 链接')
  })

  it('公开 URL 拒绝危险协议和不明确路径', () => {
    const blocked = [
      'javascript:alert(1)',
      'data:image/svg+xml,hello',
      'http://example.com/a.png',
      '//example.com/a.png',
      '/\\example.com/a.png',
      '/discover\\next',
      '/discover%5Cnext',
      '/a b.png',
      '/discover%20next',
      'https:\\\\example.com\\a.png',
      'https://example.com\\a.png',
      'https://example.com/%5Ca.png',
      'https://example.com/%0Ajavascript:alert(1)',
    ]

    for (const url of blocked) {
      expect(() => normalizePublicSettingUrl(url, '站点图标 URL')).toThrow('站点图标 URL')
    }
  })

  it('公开 URL 拒绝包含用户名或密码的 https 链接', () => {
    for (const url of [
      'https://user@example.com/og.jpg',
      'https://user:pass@example.com/og.jpg',
      'https://%E7%94%A8%E6%88%B7@example.com/og.jpg',
    ]) {
      expect(() => normalizePublicSettingUrl(url, 'OG 封面图 URL')).toThrow('OG 封面图 URL不允许包含用户名或密码')
    }
  })

  it('公开 URL 拒绝本机和非公网 IPv4 地址', () => {
    const blocked = [
      'https://localhost/icon.png',
      'https://localhost./icon.png',
      'https://localhost%2e/icon.png',
      'https://preview.local/icon.png',
      'https://preview.local./icon.png',
      'https://127.0.0.1/icon.png',
      'https://127.1/icon.png',
      'https://2130706433/icon.png',
      'https://0x7f000001/icon.png',
      'https://0177.0.0.1/icon.png',
      'https://10.0.0.1/icon.png',
      'https://172.16.0.1/icon.png',
      'https://192.168.1.10/icon.png',
      'https://0xc0a8010a/icon.png',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/icon.png',
      'https://192.0.2.10/icon.png',
      'https://198.18.0.1/icon.png',
      'https://198.51.100.10/icon.png',
      'https://203.0.113.10/icon.png',
      'https://224.0.0.1/icon.png',
      'https://240.0.0.1/icon.png',
      'https://255.255.255.255/icon.png',
      'https://[::1]/icon.png',
      'https://[fc00::1]/icon.png',
      'https://[2001:db8::1]/icon.png',
    ]

    for (const url of blocked) {
      expect(() => normalizePublicSettingUrl(url, '站点图标 URL')).toThrow(/本机|非公网|内部/)
    }
  })

  it('站内路径设置只允许明确相对路径', () => {
    expect(normalizeInternalPathSetting('/rules', '规则页链接')).toBe('/rules')
    expect(normalizeInternalPathSetting(' /rules?from=entry ', '规则页链接')).toBe('/rules?from=entry')
    expect(() => normalizeInternalPathSetting('https://example.com/rules', '规则页链接')).toThrow('规则页链接只允许站内相对路径')
    expect(() => normalizeInternalPathSetting('//example.com/rules', '规则页链接')).toThrow('规则页链接只允许站内相对路径')
    expect(() => normalizeInternalPathSetting('/rules?access_token=abc', '规则页链接')).toThrow('规则页链接不能包含凭证类查询参数')
    expect(() => normalizeInternalPathSetting('/rules next', '规则页链接')).toThrow('规则页链接不能包含空白或控制字符')
    expect(() => normalizeInternalPathSetting('/rules%20next', '规则页链接')).toThrow('规则页链接不能包含空白或控制字符')
    expect(() => normalizeInternalPathSetting('/rules\\next', '规则页链接')).toThrow('规则页链接不能包含反斜杠')
    expect(() => normalizeInternalPathSetting('/rules%5Cnext', '规则页链接')).toThrow('规则页链接不能包含反斜杠')
  })
})
