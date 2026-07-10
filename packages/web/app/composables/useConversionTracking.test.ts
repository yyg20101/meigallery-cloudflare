import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useConversionTracking } from './useConversionTracking'

const api = vi.fn()
const track = vi.fn()
const executePixelInstructions = vi.fn()
let consentState: 'granted' | 'limited' | 'denied' = 'granted'
const marketingConsentState = ref<'granted' | 'limited' | 'denied'>('granted')
const canTrackMarketing = ref(true)
let analyticsVisitorId = 'visitor_1'
let analyticsSessionId = 'session_1'

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
    executePixelInstructions.mockReset()
    executePixelInstructions.mockResolvedValue(undefined)
    consentState = 'granted'
    marketingConsentState.value = 'granted'
    canTrackMarketing.value = true
    analyticsVisitorId = 'visitor_1'
    analyticsSessionId = 'session_1'
    sessionStorage.clear()
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
        visitorId: analyticsVisitorId,
        sessionId: analyticsSessionId,
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
    vi.stubGlobal('useTracking', () => ({ executePixelInstructions }))
    vi.stubGlobal('useMarketingConsent', () => ({ state: marketingConsentState, canTrackMarketing }))
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('点击联系方式时写 conversion API、analytics 兼容事件并委托 Pixel 指令', async () => {
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
    expect(executePixelInstructions).toHaveBeenCalledWith([
      expect.objectContaining({ eventName: 'Contact' }),
      expect.objectContaining({ eventName: 'Lead' }),
    ])
    expect(JSON.stringify(api.mock.calls)).not.toContain('@secret')
    expect(JSON.stringify(track.mock.calls)).not.toContain('@secret')
    expect(JSON.stringify(executePixelInstructions.mock.calls)).not.toContain('@secret')
  })

  it('仅在 granted 时将合法 _fbp、_fbc 和 fbclid 置于顶层 browserIdentifiers', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    document.cookie = '_fbc=fb.1.1700000000000.saved-click; path=/'
    route.query.fbclid = 'CLICK_abc-123'

    await useConversionTracking().trackConversion('contact')

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      body: expect.objectContaining({
        browserIdentifiers: {
          fbp: 'fb.1.1700000000000.123456789',
          fbc: 'fb.1.1783584000000.CLICK_abc-123',
        },
      }),
    }))
  })

  it('limited 时不读取或上报 browserIdentifiers', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    marketingConsentState.value = 'limited'
    route.query.fbclid = 'CLICK_abc-123'

    await useConversionTracking().trackConversion('contact')

    const body = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    expect(body).not.toHaveProperty('browserIdentifiers')
  })

  it('Meta mode disabled 时不读取或上报 browserIdentifiers', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    route.query.fbclid = 'CLICK_abc-123'
    canTrackMarketing.value = false

    await useConversionTracking().trackConversion('contact')

    const body = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    expect(body).not.toHaveProperty('browserIdentifiers')
  })

  it('conversion API 首次失败时不提前发送兼容 analytics 或 Pixel', async () => {
    api.mockRejectedValueOnce(new Error('conversion api failed'))

    const conversion = useConversionTracking()
    await expect(conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      metadata: { location: 'floating_contact_panel' },
    })).resolves.toBeUndefined()

    expect(track).not.toHaveBeenCalled()
    expect(executePixelInstructions).not.toHaveBeenCalled()
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
    expect(track).not.toHaveBeenCalled()
    expect(executePixelInstructions).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(api).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({
      eventId: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
      flush: true,
    }))
    expect(executePixelInstructions).toHaveBeenCalledWith([
      expect.objectContaining({ eventName: 'Contact' }),
    ])
  })

  it('granted 首次失败后撤回授权，重试实时降级并移除浏览器标识且不发 Pixel', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    route.query.fbclid = 'CLICK_abc-123'
    api.mockRejectedValueOnce(new Error('conversion api failed')).mockResolvedValueOnce({
      data: {
        pixelEvents: [{
          deliveryId: 'cdlv_stale',
          eventName: 'Contact',
          eventId: 'meta:Contact:contact:session_1:telegram:floating_contact_panel',
          payload: { location: 'floating_contact_panel' },
          receiptToken: 'receipt_stale',
        }],
      },
    })

    await useConversionTracking().trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
    })
    marketingConsentState.value = 'denied'
    canTrackMarketing.value = false

    await vi.advanceTimersByTimeAsync(1_000)

    const initialBody = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    const retryBody = api.mock.calls[1]?.[1]?.body as Record<string, unknown>
    expect(initialBody).toMatchObject({ consentState: 'granted' })
    expect(initialBody).toHaveProperty('browserIdentifiers')
    expect(retryBody).toMatchObject({ consentState: 'denied' })
    expect(retryBody).not.toHaveProperty('browserIdentifiers')
    expect(executePixelInstructions).toHaveBeenCalledWith([
      expect.objectContaining({ eventName: 'Contact' }),
    ])
  })

  it('三次补发全部失败后只发送一次空 ID 兼容事件', async () => {
    api.mockRejectedValue(new Error('conversion api failed'))
    const conversion = useConversionTracking()

    await conversion.trackConversion('contact', {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
    })
    await vi.advanceTimersByTimeAsync(3_000)

    expect(api).toHaveBeenCalledTimes(4)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({ eventId: '', flush: true }))
    expect(executePixelInstructions).toHaveBeenCalledWith([])
  })

  it('analytics 关闭时按浏览器会话生成稳定且相互隔离的必要转化身份', async () => {
    analyticsVisitorId = ''
    analyticsSessionId = ''

    await useConversionTracking().trackConversion('contact')
    await useConversionTracking().trackConversion('contact')
    const firstUserBodies = api.mock.calls.map(call => call[1]?.body as Record<string, unknown>)

    expect(firstUserBodies[0]?.visitorId).toMatch(/^conversion_visitor_[A-Za-z0-9_-]+$/)
    expect(firstUserBodies[0]?.sessionId).toMatch(/^conversion_session_[A-Za-z0-9_-]+$/)
    expect(firstUserBodies[1]?.visitorId).toBe(firstUserBodies[0]?.visitorId)
    expect(firstUserBodies[1]?.sessionId).toBe(firstUserBodies[0]?.sessionId)

    sessionStorage.clear()
    api.mockClear()
    await useConversionTracking().trackConversion('contact')
    const secondUserBody = api.mock.calls[0]?.[1]?.body as Record<string, unknown>

    expect(secondUserBody.visitorId).not.toBe(firstUserBodies[0]?.visitorId)
    expect(secondUserBody.sessionId).not.toBe(firstUserBodies[0]?.sessionId)
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
    expect(executePixelInstructions).toHaveBeenCalledWith([])
  })
})
