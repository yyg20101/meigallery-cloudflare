import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTracking } from './useTracking'

const trackAnalytics = vi.fn()
const trackContact = vi.fn()
const consumeRegistrationInstruction = vi.fn()
const trackSignal = vi.fn()

let route = {
  name: 'gallery-slug',
  path: '/gallery/summer',
  fullPath: '/gallery/summer?utm_content=button',
  query: { utm_content: 'button' } as Record<string, unknown>,
}

const validContact = {
  contactMethodId: 'contact_123',
  methodType: 'telegram',
  actionType: 'open_link' as const,
  linkUrl: 'https://t.me/example',
  value: '@example',
  attributionCapability: 'capability_0123456789',
}

describe('useTracking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route = {
      name: 'gallery-slug',
      path: '/gallery/summer',
      fullPath: '/gallery/summer?utm_content=button',
      query: { utm_content: 'button' },
    }
    trackContact.mockResolvedValue({
      eventId: 'contact_browser_123',
      externalEventId: 'attr1_contact',
    })
    consumeRegistrationInstruction.mockResolvedValue(null)
    trackSignal.mockResolvedValue(true)
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useAnalytics', () => ({
      getContext: () => ({
        visitorId: 'visitor_123',
        sessionId: 'session_123',
        sourceChannel: 'ad',
        sourceContext: {
          utmSource: 'meta',
          utmMedium: 'paid_social',
          utmCampaign: 'summer',
          utmContent: 'button',
          trackingSourceSlug: 'meta-summer',
          sourceName: 'meta-summer',
        },
      }),
      track: trackAnalytics,
    }))
    vi.stubGlobal('useAdAttribution', () => ({
      trackContact,
      consumeRegistrationInstruction,
      trackSignal,
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('业务 Contact 同时记录一方分析并只委托归因 facade 一次', async () => {
    await useTracking().trackContact(validContact)

    expect(trackContact).toHaveBeenCalledOnce()
    expect(trackContact).toHaveBeenCalledWith({
      ...validContact,
      pagePath: '/gallery/summer',
    })
    expect(trackAnalytics).toHaveBeenCalledOnce()
    expect(trackAnalytics).toHaveBeenCalledWith(
      'contact_method_click',
      expect.objectContaining({
        eventId: 'attr1_contact',
        props: expect.objectContaining({
          action_type: 'open_link',
        }),
      }),
    )
  })

  it('复制成功动作也是唯一 Contact，不调用旧 conversion API', async () => {
    await useTracking().trackContact({
      ...validContact,
      actionType: 'copy',
      linkUrl: null,
    })

    expect(trackContact).toHaveBeenCalledOnce()
    expect(trackContact).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'copy' }),
    )
    expect(trackAnalytics).toHaveBeenCalledWith(
      'contact_method_click',
      expect.objectContaining({
        props: expect.objectContaining({ action_type: 'copy' }),
      }),
    )
  })

  it('注册只消费服务端返回的签名指令引用', async () => {
    await useTracking().consumeRegistrationInstruction(
      'signed_instruction_token',
    )

    expect(consumeRegistrationInstruction).toHaveBeenCalledOnce()
    expect(consumeRegistrationInstruction).toHaveBeenCalledWith(
      'signed_instruction_token',
    )
  })

  it('注册上下文不包含 provider、click ID 或平台 Cookie', async () => {
    route.query = {
      fbclid: 'secret_click',
      ttclid: 'secret_tiktok_click',
      utm_content: 'button',
    }

    const context = await useTracking()
      .buildRegistrationAttributionContext()

    expect(context).toMatchObject({
      visitorId: 'visitor_123',
      sessionId: 'session_123',
      path: '/gallery/summer',
    })
    expect(context).not.toHaveProperty('consentState')
    expect(JSON.stringify(context)).not.toContain('secret_click')
    expect(context).not.toHaveProperty('browserIdentifiers')
    expect(context).not.toHaveProperty('adAttributionState')
  })

  it('ViewContent 和 Search 只委托 Browser signal', async () => {
    const tracking = useTracking()
    await tracking.trackViewContent({ content_id: 'gallery_1' })
    await tracking.trackSearch({
      searchString: '联系 me@example.com',
      resultCount: 7,
    })

    expect(trackSignal).toHaveBeenNthCalledWith(
      1,
      'ViewContent',
      { content_id: 'gallery_1' },
    )
    expect(trackSignal).toHaveBeenNthCalledWith(
      2,
      'Search',
      {
        search_string: '联系 [redacted_email]',
        result_count: 7,
      },
    )
    expect(trackContact).not.toHaveBeenCalled()
  })

  it('后台或敏感 URL 不向平台发送 Browser signal', async () => {
    route.fullPath = '/admin/analytics?token=secret'
    route.path = '/admin/analytics'

    await useTracking().trackViewContent({ content_id: 'gallery_1' })

    expect(trackSignal).not.toHaveBeenCalled()
  })
})
