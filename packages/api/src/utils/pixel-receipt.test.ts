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

  it('只序列化允许的 claims，验证时拒绝额外字段', async () => {
    const claims = {
      deliveryId: 'cdlv_1',
      eventId: 'meta:Contact:contact:session_1:telegram:panel',
      expiresAt: 1_783_600_300,
      ignored: 'must-not-be-signed',
    }
    const token = await createPixelReceiptToken('secret', claims)
    const [payload] = token.split('.')
    const serialized = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload!)))

    expect(serialized).toEqual({
      deliveryId: claims.deliveryId,
      eventId: claims.eventId,
      expiresAt: claims.expiresAt,
    })

    const extraPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
    const extraToken = `${extraPayload}.${base64UrlEncode(await sign('secret', extraPayload))}`
    await expect(verifyPixelReceiptToken('secret', extraToken, 1_783_600_000)).rejects.toThrow('Pixel 回执无效')
  })
})

async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`meigallery:pixel-receipt:v1:${payload}`)))
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}
