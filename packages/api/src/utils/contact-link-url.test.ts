import { describe, expect, it } from 'vitest'
import { normalizeContactLinkUrl, safeContactLinkUrl } from './contact-link-url'

describe('联系方式跳转链接校验', () => {
  it('允许空链接表示前台复制联系值', () => {
    expect(normalizeContactLinkUrl('')).toBeNull()
    expect(normalizeContactLinkUrl('   ')).toBeNull()
    expect(normalizeContactLinkUrl(null)).toBeNull()
  })

  it('允许常见安全联系协议', () => {
    expect(normalizeContactLinkUrl(' https://t.me/meigallery ')).toBe('https://t.me/meigallery')
    expect(normalizeContactLinkUrl('mailto:hello@616618.xyz')).toBe('mailto:hello@616618.xyz')
    expect(normalizeContactLinkUrl('tel:+8613800138000')).toBe('tel:+8613800138000')
    expect(normalizeContactLinkUrl('tg://resolve?domain=meigallery')).toBe('tg://resolve?domain=meigallery')
    expect(normalizeContactLinkUrl('line://ti/p/@meigallery')).toBe('line://ti/p/@meigallery')
    expect(normalizeContactLinkUrl('whatsapp://send?phone=8613800138000')).toBe('whatsapp://send?phone=8613800138000')
  })

  it('拒绝脚本协议、明文 http 和空白控制字符', () => {
    const blocked = [
      'javascript:alert(1)',
      'data:text/html,hello',
      'http://example.com',
      '//example.com/contact',
      'https://example.com/a b',
      'mailto:hello@example.com\nbcc:evil@example.com',
    ]

    for (const url of blocked) {
      expect(() => normalizeContactLinkUrl(url)).toThrow('联系方式跳转链接')
    }
  })

  it('安全读取历史链接时丢弃危险值', () => {
    expect(safeContactLinkUrl('https://t.me/meigallery')).toBe('https://t.me/meigallery')
    expect(safeContactLinkUrl('javascript:alert(1)')).toBeNull()
    expect(safeContactLinkUrl('http://example.com')).toBeNull()
  })
})
