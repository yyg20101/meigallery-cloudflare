import { describe, expect, it } from 'vitest'
import { buildAdExternalEventId } from './ad-event-id'

describe('buildAdExternalEventId', () => {
  const secret = 'test-ad-event-id-secret'

  it('对相同事实生成稳定编号', async () => {
    const first = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')
    const second = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')

    expect(second).toBe(first)
  })

  it('为不同事实生成不同编号', async () => {
    const contact = await buildAdExternalEventId(secret, 'contact:user_42:wechat', 'Contact')
    const registration = await buildAdExternalEventId(secret, 'registration:user_42', 'CompleteRegistration')

    expect(registration).not.toBe(contact)
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
})
