import { describe, expect, it } from 'vitest'
import { canGenerateContactLink, generateContactLink } from '@meigallery/shared/constants'

describe('联系方式跳转链接生成', () => {
  it('微信个人号默认不生成跳转链接', () => {
    expect(generateContactLink('wechat', 'meigallery')).toBeNull()
    expect(canGenerateContactLink('wechat', 'meigallery')).toBe(false)
  })

  it('自动生成 telegram.me 链接并保留用户输入的完整链接', () => {
    expect(generateContactLink('telegram', '@meigallery')).toBe('https://telegram.me/meigallery')
    expect(generateContactLink('telegram', 'https://t.me/meigallery')).toBe('https://t.me/meigallery')
    expect(generateContactLink('telegram', 'https://telegram.me/meigallery')).toBe('https://telegram.me/meigallery')
    expect(generateContactLink('telegram', 'https://telegram.me/MeiGallery?start=Hello')).toBe('https://telegram.me/MeiGallery?start=Hello')
    expect(generateContactLink('telegram', 'telegram.me/meigallery')).toBe('https://telegram.me/meigallery')
  })

  it('生成 WhatsApp wa.me 链接并只保留手机号数字', () => {
    expect(generateContactLink('whatsapp', '+86 138-0013-8000')).toBe('https://wa.me/8613800138000')
  })

  it('生成 LINE 官方账号链接并按官方要求编码 @', () => {
    expect(generateContactLink('line', '@meigallery')).toBe('https://line.me/R/ti/p/%40meigallery')
  })

  it('仅为有效邮箱生成 mailto 链接', () => {
    expect(generateContactLink('email', 'hello@616618.xyz')).toBe('mailto:hello@616618.xyz')
    expect(generateContactLink('email', 'hello')).toBeNull()
  })

  it('Discord 仅按邀请链接生成跳转，普通用户名走复制', () => {
    expect(generateContactLink('discord', 'https://discord.gg/abc123')).toBe('https://discord.gg/abc123')
    expect(generateContactLink('discord', 'meigallery')).toBeNull()
  })
})
