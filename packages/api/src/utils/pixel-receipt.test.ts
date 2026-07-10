import { describe, expect, it } from 'vitest'
import { createPixelReceiptToken, verifyPixelReceiptToken } from './pixel-receipt'

describe('Pixel 回执令牌', () => {
  it('绑定 delivery、event 和五分钟有效期', async () => {
    const token = await createPixelReceiptToken('secret', {
      deliveryId: 'cdlv_1',
      eventId: 'meta:Contact:contact:session_1:telegram:panel',
      expiresAt: 1_783_600_300,
    })

    await expect(verifyPixelReceiptToken('secret', token, 1_783_600_000)).resolves.toMatchObject({ deliveryId: 'cdlv_1' })
    await expect(verifyPixelReceiptToken('secret', token, 1_783_600_301)).rejects.toThrow('Pixel 回执已过期')
    await expect(verifyPixelReceiptToken('other', token, 1_783_600_000)).rejects.toThrow('Pixel 回执签名无效')
  })
})
