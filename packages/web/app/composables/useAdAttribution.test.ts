import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdAttribution } from './useAdAttribution'

const trackContact = vi.fn()
const consumeInstructionToken = vi.fn()
const trackSignal = vi.fn()

describe('useAdAttribution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useNuxtApp', () => ({
      $attribution: {
        trackContact,
        consumeInstructionToken,
        trackSignal,
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Contact 只委托唯一 Browser Client 一次', async () => {
    const input = {
      contactMethodId: 'contact_1',
      methodType: 'telegram',
      actionType: 'open_link' as const,
      linkUrl: 'https://t.me/example',
      value: '@example',
      attributionCapability: 'capability_0123456789',
      pagePath: '/',
    }
    trackContact.mockResolvedValueOnce({
      eventId: 'contact_browser_1',
      externalEventId: 'attr1_contact',
    })

    await expect(
      useAdAttribution().trackContact(input),
    ).resolves.toEqual({
      eventId: 'contact_browser_1',
      externalEventId: 'attr1_contact',
    })
    expect(trackContact).toHaveBeenCalledOnce()
    expect(trackContact).toHaveBeenCalledWith(input)
  })

  it('同一注册成功响应只把签名指令引用交给 Client', async () => {
    consumeInstructionToken.mockResolvedValueOnce({
      eventId: 'registration_1',
      externalEventId: 'attr1_registration',
    })

    await useAdAttribution().consumeRegistrationInstruction(
      'signed_instruction_token',
    )

    expect(consumeInstructionToken).toHaveBeenCalledOnce()
    expect(consumeInstructionToken).toHaveBeenCalledWith(
      'signed_instruction_token',
    )
  })

  it('普通 Browser signal 不创建业务事件', async () => {
    trackSignal.mockResolvedValueOnce(true)

    await expect(useAdAttribution().trackSignal(
      'ViewContent',
      { content_id: 'gallery_1' },
    )).resolves.toBe(true)

    expect(trackSignal).toHaveBeenCalledWith(
      'ViewContent',
      { content_id: 'gallery_1' },
    )
    expect(trackContact).not.toHaveBeenCalled()
  })
})
