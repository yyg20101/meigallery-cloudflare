import { describe, expect, it } from 'vitest'
import { normalizeContactActionUrl, normalizeContactQrCodeUrl } from './contactUrlSecurity'

describe('contactUrlSecurity', () => {
  it('联系方式跳转链接允许安全联系协议', () => {
    expect(normalizeContactActionUrl(' https://example.com/contact ')).toBe('https://example.com/contact')
    expect(normalizeContactActionUrl('mailto:hello@616618.xyz')).toBe('mailto:hello@616618.xyz')
    expect(normalizeContactActionUrl('tel:+8613800138000')).toBe('tel:+8613800138000')
    expect(normalizeContactActionUrl('tg://resolve?domain=meigallery')).toBe('tg://resolve?domain=meigallery')
  })

  it('联系方式跳转链接拒绝危险协议和内部地址', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com',
      'https://localhost/contact',
      'https://127.0.0.1/contact',
      'https://192.168.1.10/contact',
      'https://preview.local/contact',
      'https://example.com/a b',
      'https://example.com/%0Acontact',
      'mailto:hello@example.com%0Abcc:evil@example.com',
    ]) {
      expect(normalizeContactActionUrl(url)).toBeNull()
    }
  })

  it('二维码图片 URL 只允许站内路径和安全 HTTPS 公开地址', () => {
    expect(normalizeContactQrCodeUrl('/api/contact-methods/contact-1/qrcode')).toBe('/api/contact-methods/contact-1/qrcode')
    expect(normalizeContactQrCodeUrl('HTTPS://example.com/qr.png?next="x"')).toBe('https://example.com/qr.png?next=%22x%22')

    for (const url of [
      'javascript:alert(1)',
      'http://example.com/qr.png',
      'https://localhost/qr.png',
      'https://127.0.0.1/qr.png',
      'https://example.local/qr.png',
      '/api/contact-methods/contact-1/qr%20bad',
      '//example.com/qr.png',
    ]) {
      expect(normalizeContactQrCodeUrl(url)).toBeNull()
    }
  })
})
