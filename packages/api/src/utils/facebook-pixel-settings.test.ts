import { describe, expect, it } from 'vitest'
import { normalizeBooleanSetting, normalizeFacebookPixelId } from './facebook-pixel-settings'

describe('Facebook Pixel 设置校验', () => {
  it('允许空 Pixel ID 表示关闭加载', () => {
    expect(normalizeFacebookPixelId('')).toBe('')
    expect(normalizeFacebookPixelId('   ')).toBe('')
  })

  it('只允许 5-30 位数字 Pixel ID', () => {
    expect(normalizeFacebookPixelId('12345')).toBe('12345')
    expect(normalizeFacebookPixelId(' 123456789012345 ')).toBe('123456789012345')
    expect(() => normalizeFacebookPixelId('1234')).toThrow('Facebook Pixel ID 只能填写 5-30 位数字')
    expect(() => normalizeFacebookPixelId('abc12345')).toThrow('Facebook Pixel ID 只能填写 5-30 位数字')
    expect(() => normalizeFacebookPixelId('1234567890123456789012345678901')).toThrow('Facebook Pixel ID 只能填写 5-30 位数字')
  })

  it('归一化布尔设置', () => {
    expect(normalizeBooleanSetting(true)).toBe(true)
    expect(normalizeBooleanSetting(false)).toBe(false)
    expect(normalizeBooleanSetting('true')).toBe(true)
    expect(normalizeBooleanSetting('false')).toBe(false)
    expect(normalizeBooleanSetting('bad')).toBe(false)
  })
})
