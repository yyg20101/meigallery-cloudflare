import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useConversionTracking } from './useConversionTracking'

const api = vi.fn()
const track = vi.fn()
const trackStandardEvent = vi.fn()
let consentState: 'granted' | 'limited' | 'denied' = 'granted'
const marketingConsentState = ref<'granted' | 'limited' | 'denied'>('granted')

let route: {
  name: string
  path: string
  fullPath: string
  query: Record<string, unknown>
} = {
  name: 'contact',
  path: '/contact',
  fullPath: '/contact?utm_content=button',
  query: { utm_content: 'button' },
}

describe('useConversionTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-09T08:00:00.000Z'))
    api.mockReset()
    api.mockResolvedValue({ data: { id: 'conv_1', created: true, pixelEvents: [] } })
    track.mockReset()
    trackStandardEvent.mockReset()
    consentState = 'granted'
    marketingConsentState.value = 'granted'
    route = {
      name: 'contact',
      path: '/contact',
      fullPath: '/contact?utm_content=button',
      query: { utm_content: 'button' },
    }
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useAnalytics', () => ({
      getContext: () => ({
        visitorId: 'visitor_1',
        sessionId: 'session_1',
        consentState,
        sourceChannel: 'ad',
        sourceContext: {
          utmSource: 'ad-july',
          utmMedium: 'paid_social',
          utmCampaign: 'july',
          trackingSourceSlug: 'ad-july',
          sourceName: 'ad-july',
        },
      }),
      track,
    }))
    vi.stubGlobal('useFacebookPixel', () => ({ trackStandardEvent }))
    vi.stubGlobal('useMarketingConsent', () => ({ state: marketingConsentState }))
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('点击联系方式时同时写 conversion API、analytics 兼容事件和 Pixel eventID', async () => {
    api.mockResolvedValueOnce({
      data: {
        id: 'conv_1',
        created: true,
        pixelEvents: [
          {
            deliveryId: 'cdlv_contact',
            eventName: 'Contact',
            eventId: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
            payload: { location: 'floating_contact_panel', method_type: 'telegram' },
            receiptToken: 'receipt_contact',
          },
          {
            deliveryId: 'cdlv_lead',
            eventName: 'Lead',
            eventId: 'meta:Lead:lead:session_1',
            payload: {},
            receiptToken: 'receipt_lead',
          },
        ],
      },
    })
    const conversion = useConversionTracking()
    await conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { location: 'floating_contact_panel', contactValue: '@secret' },
    })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({ method: 'POST' }))
    expect(track).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({ flush: true }))
    expect(trackStandardEvent).toHaveBeenNthCalledWith(1, 'Contact', { location: 'floating_contact_panel', method_type: 'telegram' }, { eventID: 'meta:Contact:contact:session_1:telegram:floating_contact_panel' })
    expect(trackStandardEvent).toHaveBeenNthCalledWith(2, 'Lead', {}, { eventID: 'meta:Lead:lead:session_1' })
    expect(JSON.stringify(api.mock.calls)).not.toContain('@secret')
    expect(JSON.stringify(track.mock.calls)).not.toContain('@secret')
    expect(JSON.stringify(trackStandardEvent.mock.calls)).not.toContain('@secret')
  })

  it('注册成功时写 complete_registration 并发送 CompleteRegistration Pixel', async () => {
    api.mockResolvedValueOnce({
      data: {
        id: 'conv_1',
        created: true,
        pixelEvents: [{
          deliveryId: 'cdlv_registration',
          eventName: 'CompleteRegistration',
          eventId: 'meta:CompleteRegistration:complete_registration:session_1:2026-07-09',
          payload: { method: 'email' },
          receiptToken: 'receipt_registration',
        }],
      },
    })
    const conversion = useConversionTracking()
    await conversion.trackConversion('complete_registration', { metadata: { method: 'email' } })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        actionType: 'complete_registration',
        metadata: { method: 'email' },
      }),
    }))
    expect(track).toHaveBeenCalledWith('register_success', expect.objectContaining({
      eventId: 'meta:CompleteRegistration:complete_registration:session_1:2026-07-09',
      flush: true,
    }))
    expect(trackStandardEvent).toHaveBeenCalledWith(
      'CompleteRegistration',
      { method: 'email' },
      { eventID: 'meta:CompleteRegistration:complete_registration:session_1:2026-07-09' },
    )
    expect(trackStandardEvent).toHaveBeenCalledTimes(1)
  })

  it('注册页路径只保留 allow-list query，invite 不进入 conversion body.path', async () => {
    route = {
      name: 'register',
      path: '/register',
      fullPath: '/register?invite=abc&utm_content=ad-a',
      query: { invite: 'abc', utm_content: 'ad-a' },
    }

    const conversion = useConversionTracking()
    await conversion.trackConversion('complete_registration', { metadata: { method: 'email' } })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      body: expect.objectContaining({
        path: '/register',
        utmContent: 'ad-a',
      }),
    }))
    expect(JSON.stringify(api.mock.calls)).not.toContain('invite')
  })

  it('conversion API 失败时继续 analytics 兼容事件但不发送 Pixel', async () => {
    api.mockRejectedValueOnce(new Error('conversion api failed'))

    const conversion = useConversionTracking()
    await expect(conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { location: 'floating_contact_panel' },
    })).resolves.toBeUndefined()

    expect(track).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({
      eventId: '',
      flush: true,
    }))
    expect(trackStandardEvent).not.toHaveBeenCalled()
  })

  it('conversion API 首次失败后在内存中补发并消费服务端指令', async () => {
    api.mockRejectedValueOnce(new Error('conversion api failed')).mockResolvedValueOnce({
      data: {
        pixelEvents: [{
          deliveryId: 'cdlv_retry',
          eventName: 'Contact',
          eventId: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
          payload: { location: 'floating_contact_panel' },
          receiptToken: 'receipt_retry',
        }],
      },
    })

    const conversion = useConversionTracking()
    await conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
    })
    expect(trackStandardEvent).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(api).toHaveBeenCalledTimes(2)
    expect(trackStandardEvent).toHaveBeenCalledWith(
      'Contact',
      { location: 'floating_contact_panel' },
      { eventID: 'meta:Contact:contact:session_1:telegram:floating_contact_panel' },
    )
  })

  it('consent 非 granted 时不直接发送 Pixel', async () => {
    consentState = 'granted'
    marketingConsentState.value = 'limited'

    const conversion = useConversionTracking()
    await conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { location: 'floating_contact_panel' },
    })

    expect(api).toHaveBeenCalled()
    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      body: expect.objectContaining({ consentState: 'limited' }),
    }))
    expect(track).toHaveBeenCalled()
    expect(trackStandardEvent).not.toHaveBeenCalled()
  })
})
