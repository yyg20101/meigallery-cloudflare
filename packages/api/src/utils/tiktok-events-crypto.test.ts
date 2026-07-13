import { describe, expect, it } from 'vitest'
import {
  decryptTikTokEventsContext,
  encryptTikTokEventsContext,
  loadTikTokEventsCryptoKeys,
  TikTokEventsCryptoError,
  tiktokConnectionFingerprint,
} from './tiktok-events-crypto'

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const AAD = {
  deliveryId: 'cdlv_tiktok_1',
  externalEventId: 'event-tiktok-1',
  eventName: 'Contact' as const,
}

describe('TikTok Events API 安全上下文', () => {
  it('使用独立数据密钥完成 AES-GCM round trip', async () => {
    const keys = await loadTikTokEventsCryptoKeys({ TIKTOK_EVENTS_DATA_KEY_CURRENT: KEY })
    const value = {
      ttclid: 'E.C.P.example-click',
      ttp: 'cookie-id-123',
      clientIpAddress: '203.0.113.8',
      clientUserAgent: 'MeiGallery-Test/1.0',
    }
    const envelope = await encryptTikTokEventsContext({ keys, aad: AAD, value })
    await expect(decryptTikTokEventsContext({ keys, aad: AAD, envelope })).resolves.toEqual(value)
  })

  it('AAD 修改后返回认证失败且不泄漏明文', async () => {
    const keys = await loadTikTokEventsCryptoKeys({ TIKTOK_EVENTS_DATA_KEY_CURRENT: KEY })
    const envelope = await encryptTikTokEventsContext({ keys, aad: AAD, value: { ttp: 'private-cookie' } })
    const error = await decryptTikTokEventsContext({
      keys,
      aad: { ...AAD, deliveryId: 'cdlv_tiktok_2' },
      envelope,
    }).catch(value => value)
    expect(error).toBeInstanceOf(TikTokEventsCryptoError)
    expect(error).toMatchObject({ code: 'TIKTOK_EVENTS_AUTHENTICATION_FAILED' })
    expect(JSON.stringify(error)).not.toContain('private-cookie')
  })

  it('拒绝未知字段、非法 hash 和 Meta 专属标识', async () => {
    const keys = await loadTikTokEventsCryptoKeys({ TIKTOK_EVENTS_DATA_KEY_CURRENT: KEY })
    await expect(encryptTikTokEventsContext({
      keys,
      aad: AAD,
      value: { fbp: 'fb.1.1.private' } as never,
    })).rejects.toThrow('TIKTOK_EVENTS_CONTEXT_INVALID')
    await expect(encryptTikTokEventsContext({
      keys,
      aad: AAD,
      value: { emailSha256: 'A'.repeat(64) },
    })).rejects.toThrow('TIKTOK_EVENTS_CONTEXT_INVALID')
  })

  it('连接指纹绑定 Pixel ID 与 token', async () => {
    const first = await tiktokConnectionFingerprint('C1234567890', 'token-sensitive')
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await expect(tiktokConnectionFingerprint('C1234567890', 'token-sensitive')).resolves.toBe(first)
    await expect(tiktokConnectionFingerprint('C1234567891', 'token-sensitive')).resolves.not.toBe(first)
  })
})
