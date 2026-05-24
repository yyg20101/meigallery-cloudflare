import { describe, expect, it } from 'vitest'
import { assertSafeExternalUrl } from './external-url'

describe('外部 URL 安全校验', () => {
  it('允许公开 HTTPS 域名', () => {
    expect(assertSafeExternalUrl('https://zuole.me/wp-json/wp/v2/posts')).toBe('https://zuole.me/wp-json/wp/v2/posts')
  })

  it('拒绝非 HTTPS 地址', () => {
    expect(() => assertSafeExternalUrl('http://example.com/image.jpg')).toThrow('仅允许 HTTPS 外部地址')
  })

  it('拒绝 localhost 和私网 IP', () => {
    expect(() => assertSafeExternalUrl('https://localhost/wp-json')).toThrow('不允许访问本机或内部域名')
    expect(() => assertSafeExternalUrl('https://127.0.0.1/wp-json')).toThrow('不允许访问本机或私网 IP')
    expect(() => assertSafeExternalUrl('https://10.0.0.1/image.jpg')).toThrow('不允许访问本机或私网 IP')
    expect(() => assertSafeExternalUrl('https://192.168.1.10/image.jpg')).toThrow('不允许访问本机或私网 IP')
    expect(() => assertSafeExternalUrl('https://169.254.169.254/latest/meta-data')).toThrow('不允许访问本机或私网 IP')
  })
})
