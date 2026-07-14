import { describe, expect, it } from 'vitest'
import { normalizeContactActionUrl, normalizeContactQrCodeUrl } from './contactUrlSecurity'

describe('contactUrlSecurity', () => {
  it('联系方式跳转链接允许安全联系协议', () => {
    expect(normalizeContactActionUrl(' https://example.com/contact ')).toBe('https://example.com/contact')
    expect(normalizeContactActionUrl('https://telegram.me/meigallery')).toBe('https://telegram.me/meigallery')
    expect(normalizeContactActionUrl('https://www.telegram.me/meigallery?start=hello')).toBe('https://www.telegram.me/meigallery?start=hello')
    expect(normalizeContactActionUrl('mailto:hello@616618.xyz')).toBe('mailto:hello@616618.xyz')
    expect(normalizeContactActionUrl('tel:+8613800138000')).toBe('tel:+8613800138000')
    expect(normalizeContactActionUrl('tg://resolve?domain=meigallery')).toBe('tg://resolve?domain=meigallery')
  })

  it('联系方式跳转链接拒绝危险协议、内部地址和非公网 IP', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com',
      'https://localhost/contact',
      'https://localhost./contact',
      'https://localhost%2e/contact',
      'https://127.0.0.1/contact',
      'https://192.168.1.10/contact',
      'https://100.64.0.1/contact',
      'https://198.18.0.1/contact',
      'https://198.51.100.10/contact',
      'https://203.0.113.10/contact',
      'https://240.0.0.1/contact',
      'https://preview.local/contact',
      'https://preview.local./contact',
      'https://example.com/a b',
      'https://example.com/%0Acontact',
      'https://user:pass@example.com/contact',
      'https://example.com\\@evil.test/contact',
      'https://example.com/%5Ccontact',
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
      'https://localhost./qr.png',
      'https://127.0.0.1/qr.png',
      'https://198.51.100.10/qr.png',
      'https://240.0.0.1/qr.png',
      'https://example.local/qr.png',
      'https://example.local./qr.png',
      '/api/contact-methods/contact-1/qr%20bad',
      '/api/contact-methods/contact-1/%5Cqr.png',
      'https://user:pass@example.com/qr.png',
      'https://example.com\\@evil.test/qr.png',
      'https://example.com/%5Cqr.png',
      '//example.com/qr.png',
    ]) {
      expect(normalizeContactQrCodeUrl(url)).toBeNull()
    }
  })
})
