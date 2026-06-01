import { describe, expect, it } from 'vitest'
import { assertSafeExternalUrl } from './external-url'

describe('外部 URL 安全校验', () => {
  it('允许公开 HTTPS 域名', () => {
    expect(assertSafeExternalUrl('https://zuole.me/wp-json/wp/v2/posts')).toBe('https://zuole.me/wp-json/wp/v2/posts')
  })

  it('拒绝非 HTTPS 地址', () => {
    expect(() => assertSafeExternalUrl('http://example.com/image.jpg')).toThrow('仅允许 HTTPS 外部地址')
  })

  it('拒绝 localhost 和非公网 IPv4 地址', () => {
    expect(() => assertSafeExternalUrl('https://localhost/wp-json')).toThrow('不允许访问本机或内部域名')
    expect(() => assertSafeExternalUrl('https://localhost./wp-json')).toThrow('不允许访问本机或内部域名')
    expect(() => assertSafeExternalUrl('https://localhost%2e/wp-json')).toThrow('不允许访问本机或内部域名')
    expect(() => assertSafeExternalUrl('https://preview.local./wp-json')).toThrow('不允许访问本机或内部域名')
    for (const url of [
      'https://127.0.0.1/wp-json',
      'https://10.0.0.1/image.jpg',
      'https://192.168.1.10/image.jpg',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/source.jpg',
      'https://192.0.2.10/source.jpg',
      'https://198.18.0.1/source.jpg',
      'https://198.51.100.10/source.jpg',
      'https://203.0.113.10/source.jpg',
      'https://224.0.0.1/source.jpg',
      'https://240.0.0.1/source.jpg',
      'https://255.255.255.255/source.jpg',
    ]) {
      expect(() => assertSafeExternalUrl(url)).toThrow('不允许访问本机或非公网 IP')
    }
  })
})
