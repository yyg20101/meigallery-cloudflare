import { describe, expect, it } from 'vitest'
import { normalizeBooleanSetting, normalizeInternalPath, normalizePublicSettingUrl, normalizeSiteSettingPixelId } from './siteSettingsSecurity'

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
})
