import { describe, expect, it } from 'vitest'
import {
  buildAdExternalEventId,
  buildAdExternalEventIdFromKey,
  createRandomAdExternalEventId,
  isAdExternalEventId,
} from './ad-event-id'

describe('buildAdExternalEventId', () => {
  const secret = 'test-ad-event-id-secret'

  it('对相同事实生成稳定编号', async () => {
    const first = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')
    const second = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')

    expect(second).toBe(first)
  })

  it('为不同事实生成不同编号', async () => {
    const first = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')
    const second = await buildAdExternalEventId(secret, 'contact:user_43:wechat', 'Contact')

    expect(second).not.toBe(first)
  })

  it('生成带 mg3_ 前缀、URL-safe 且不超过 64 字符的编号', async () => {
    const eventId = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')

    expect(eventId).toMatch(/^mg3_[A-Za-z0-9_-]+$/)
    expect(eventId.length).toBeLessThanOrEqual(64)
  })

  it('在主密钥为空时 fail closed', async () => {
    await expect(buildAdExternalEventId('', 'contact:user_42:wechat', 'Contact'))
      .rejects.toThrow('AD_EVENT_ID_INPUT_INVALID')
  })

  it('可用不可导出的 HMAC key 生成相同协议 ID', async () => {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('a'.repeat(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    await expect(buildAdExternalEventIdFromKey(key, 'fact_1', 'Contact')).resolves.toMatch(/^mg3_/)
    expect(key.extractable).toBe(false)
  })

  it('浏览器随机编号与服务端编号共用严格协议', () => {
    const first = createRandomAdExternalEventId()
    const second = createRandomAdExternalEventId()

    expect(isAdExternalEventId(first)).toBe(true)
    expect(isAdExternalEventId(second)).toBe(true)
    expect(second).not.toBe(first)
    expect(first).toHaveLength(47)
    expect(isAdExternalEventId('mg3_short')).toBe(false)
  })
})
