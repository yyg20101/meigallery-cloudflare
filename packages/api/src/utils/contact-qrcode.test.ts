import { describe, expect, it } from 'vitest'
import { isExpectedContactQrCodeKey } from './contact-qrcode'

describe('联系方式二维码 key 校验', () => {
  it('只允许当前联系方式自己的二维码对象', () => {
    expect(isExpectedContactQrCodeKey('qrcodes/contact-1.png', 'contact-1')).toBe(true)
    expect(isExpectedContactQrCodeKey('qrcodes/contact-1.jpg', 'contact-1')).toBe(true)
    expect(isExpectedContactQrCodeKey('qrcodes/contact-1.webp', 'contact-1')).toBe(true)
    expect(isExpectedContactQrCodeKey('qrcodes/contact-2.png', 'contact-1')).toBe(false)
    expect(isExpectedContactQrCodeKey('avatars/contact-1.png', 'contact-1')).toBe(false)
    expect(isExpectedContactQrCodeKey('qrcodes/contact-1.svg', 'contact-1')).toBe(false)
  })
})
