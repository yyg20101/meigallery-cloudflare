import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const adapter = vi.hoisted(() => ({
  initialize: vi.fn(),
  pageView: vi.fn(),
  standardEvent: vi.fn(),
  teardown: vi.fn(),
}))

vi.mock('~/adapters/metaPixel.client', () => ({ metaPixelAdapter: adapter }))

import { useTracking } from './useTracking'

const api = vi.fn()
const trackAnalytics = vi.fn()
const marketingConsentState = ref<'granted' | 'limited' | 'denied'>('granted')
const canTrackMarketing = ref(true)
const facebookPixelEnabled = ref(true)
const facebookPixelId = ref('123456789')
const facebookPixelDebugEnabled = ref(false)
let analyticsVisitorId = 'visitor_1'
let analyticsSessionId = 'session_1'
let route = {
  name: 'gallery-slug',
  path: '/gallery/summer',
  fullPath: '/gallery/summer?utm_content=button',
  query: { utm_content: 'button' } as Record<string, unknown>,
}

describe('useTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T08:00:00.000Z'))
    api.mockReset()
    api.mockResolvedValue({ data: { id: 'contact_1', created: true, pixelEvents: [] } })
    trackAnalytics.mockReset()
    adapter.initialize.mockReset()
    adapter.initialize.mockReturnValue(true)
    adapter.pageView.mockReset()
    adapter.pageView.mockReturnValue(true)
    adapter.standardEvent.mockReset()
    adapter.standardEvent.mockReturnValue(true)
    adapter.teardown.mockReset()
    marketingConsentState.value = 'granted'
    canTrackMarketing.value = true
    facebookPixelEnabled.value = true
    facebookPixelId.value = '123456789'
    facebookPixelDebugEnabled.value = false
    analyticsVisitorId = 'visitor_1'
    analyticsSessionId = 'session_1'
    route = {
      name: 'gallery-slug',
      path: '/gallery/summer',
      fullPath: '/gallery/summer?utm_content=button',
      query: { utm_content: 'button' },
    }
    sessionStorage.clear()
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appEnv: 'production' } }))
    vi.stubGlobal('useSiteSettings', () => ({
      facebookPixelEnabled,
      facebookPixelId,
      facebookPixelDebugEnabled,
    }))
    vi.stubGlobal('useAnalytics', () => ({
      getContext: () => ({
        visitorId: analyticsVisitorId,
        sessionId: analyticsSessionId,
        sourceChannel: 'ad',
        sourceContext: {
          utmSource: 'meta',
          utmMedium: 'paid_social',
          utmCampaign: 'summer',
          trackingSourceSlug: 'meta-summer',
          sourceName: 'meta-summer',
        },
      }),
      track: trackAnalytics,
    }))
    vi.stubGlobal('useMarketingConsent', () => ({
      state: marketingConsentState,
      canTrackMarketing,
    }))
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('trackContact 只创建一次 contact 并写第一方兼容事件', async () => {
    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })

    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        actionType: 'contact',
        methodType: 'telegram',
        actionTarget: 'floating_contact_panel',
        metadata: { action_type: 'open_link' },
      }),
    }))
    expect(trackAnalytics).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({
      flush: true,
      props: {
        method_type: 'telegram',
        action_type: 'open_link',
        location: 'floating_contact_panel',
      },
    }))
  })

  it('Contact Pixel instruction 使用服务端同一个 eventID', async () => {
    api.mockResolvedValueOnce({ data: { pixelEvents: [instruction('Contact')] } })

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })

    expect(adapter.standardEvent).toHaveBeenCalledWith(
      'Contact',
      { method_type: 'telegram' },
      { eventID: 'meta:Contact:contact_1' },
    )
    expect(trackAnalytics).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({
      eventId: 'meta:Contact:contact_1',
    }))
  })

  it.each(['limited', 'denied'] as const)('%s 授权仍写第一方 Contact 且不执行 Pixel', async consent => {
    marketingConsentState.value = consent
    canTrackMarketing.value = false
    api.mockResolvedValueOnce({ data: { pixelEvents: [instruction('Contact')] } })

    await useTracking().trackContact({
      methodType: 'wechat',
      actionTarget: 'floating_contact_panel',
      actionType: 'copy',
    })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      body: expect.objectContaining({ actionType: 'contact', consentState: consent }),
    }))
    expect(trackAnalytics).toHaveBeenCalledOnce()
    expect(adapter.standardEvent).not.toHaveBeenCalled()
  })

  it('Pixel attempted 回执失败走有界重试且不重复创建 Contact', async () => {
    api
      .mockResolvedValueOnce({ data: { pixelEvents: [instruction('Contact')] } })
      .mockRejectedValue(new Error('receipt failed'))

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })
    await vi.runAllTimersAsync()

    const conversionCalls = api.mock.calls.filter(call => call[0] === '/api/conversions/events')
    const receiptCalls = api.mock.calls.filter(call => call[0] === '/api/conversions/pixel-receipts')
    expect(conversionCalls).toHaveLength(1)
    expect(receiptCalls).toHaveLength(4)
    expect(adapter.standardEvent).toHaveBeenCalledOnce()
  })

  it('granted 时只读取合法 browser identifiers', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    document.cookie = '_fbc=fb.1.1700000000000.saved-click; path=/'
    route.query.fbclid = 'CLICK_abc-123'

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      body: expect.objectContaining({
        browserIdentifiers: {
          fbp: 'fb.1.1700000000000.123456789',
          fbc: `fb.1.${new Date('2026-07-10T08:00:00.000Z').getTime()}.CLICK_abc-123`,
        },
      }),
    }))
  })

  it('conversion API 首次失败后有界重试且只完成一次兼容分析', async () => {
    api.mockRejectedValueOnce(new Error('conversion failed')).mockResolvedValueOnce({
      data: { pixelEvents: [instruction('Contact')] },
    })

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })
    expect(trackAnalytics).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(api.mock.calls.filter(call => call[0] === '/api/conversions/events')).toHaveLength(2)
    expect(trackAnalytics).toHaveBeenCalledOnce()
    expect(adapter.standardEvent).toHaveBeenCalledOnce()
  })

  it('重试前撤回授权会移除浏览器标识且不执行 Pixel', async () => {
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    route.query.fbclid = 'CLICK_abc-123'
    api.mockRejectedValueOnce(new Error('conversion failed')).mockResolvedValueOnce({
      data: { pixelEvents: [instruction('Contact')] },
    })

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })
    marketingConsentState.value = 'denied'
    canTrackMarketing.value = false
    await vi.advanceTimersByTimeAsync(1_000)

    const initialBody = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    const retryBody = api.mock.calls[1]?.[1]?.body as Record<string, unknown>
    expect(initialBody).toHaveProperty('browserIdentifiers')
    expect(retryBody).toMatchObject({ consentState: 'denied' })
    expect(retryBody).not.toHaveProperty('browserIdentifiers')
    expect(adapter.standardEvent).not.toHaveBeenCalled()
  })

  it('limited activation 即使重试前升级 granted 也不读取标识或执行 Pixel', async () => {
    marketingConsentState.value = 'limited'
    canTrackMarketing.value = false
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'
    route.query.fbclid = 'CLICK_abc-123'
    api.mockRejectedValueOnce(new Error('conversion failed')).mockResolvedValueOnce({
      data: { pixelEvents: [instruction('Contact')] },
    })

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })
    marketingConsentState.value = 'granted'
    canTrackMarketing.value = true
    await vi.advanceTimersByTimeAsync(1_000)

    const bodies = api.mock.calls
      .filter(call => call[0] === '/api/conversions/events')
      .map(call => call[1]?.body as Record<string, unknown>)
    expect(bodies).toHaveLength(2)
    expect(bodies.every(body => body.consentState === 'limited')).toBe(true)
    expect(bodies.every(body => !('browserIdentifiers' in body))).toBe(true)
    expect(adapter.standardEvent).not.toHaveBeenCalled()
  })

  it('analytics 本地异常不会重新提交 conversion', async () => {
    trackAnalytics.mockImplementationOnce(() => { throw new Error('analytics failed') })

    await expect(useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })).resolves.toBeUndefined()
    await vi.runAllTimersAsync()

    expect(api.mock.calls.filter(call => call[0] === '/api/conversions/events')).toHaveLength(1)
  })

  it('Pixel 本地异常不会重新提交 conversion', async () => {
    api.mockResolvedValueOnce({ data: { pixelEvents: [instruction('Contact')] } })
    adapter.standardEvent.mockImplementationOnce(() => { throw new Error('fbq failed') })

    await expect(useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })).resolves.toBeUndefined()
    await vi.runAllTimersAsync()

    expect(api.mock.calls.filter(call => call[0] === '/api/conversions/events')).toHaveLength(1)
  })

  it('conversion API 全部补发失败后只写一次空 ID 兼容分析', async () => {
    api.mockRejectedValue(new Error('conversion failed'))

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })
    await vi.advanceTimersByTimeAsync(3_000)

    expect(api.mock.calls.filter(call => call[0] === '/api/conversions/events')).toHaveLength(4)
    expect(trackAnalytics).toHaveBeenCalledOnce()
    expect(trackAnalytics).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({ eventId: '' }))
    expect(adapter.standardEvent).not.toHaveBeenCalled()
  })

  it('analytics 关闭时按浏览器会话生成稳定且相互隔离的必要身份', async () => {
    analyticsVisitorId = ''
    analyticsSessionId = ''
    const input = {
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link' as const,
    }

    await useTracking().trackContact(input)
    await useTracking().trackContact(input)
    const firstSessionBodies = api.mock.calls.map(call => call[1]?.body as Record<string, unknown>)

    expect(firstSessionBodies[0]?.visitorId).toMatch(/^conversion_visitor_[A-Za-z0-9_-]+$/)
    expect(firstSessionBodies[0]?.sessionId).toMatch(/^conversion_session_[A-Za-z0-9_-]+$/)
    expect(firstSessionBodies[1]?.visitorId).toBe(firstSessionBodies[0]?.visitorId)
    expect(firstSessionBodies[1]?.sessionId).toBe(firstSessionBodies[0]?.sessionId)

    sessionStorage.clear()
    api.mockClear()
    await useTracking().trackContact(input)
    const nextSessionBody = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    expect(nextSessionBody.visitorId).not.toBe(firstSessionBodies[0]?.visitorId)
    expect(nextSessionBody.sessionId).not.toBe(firstSessionBodies[0]?.sessionId)
  })

  it('utm_content 不泄露邮箱、URL 或凭证值', async () => {
    route.query.utm_content = 'me@example.com https://example.com/path?token=secret'

    await useTracking().trackContact({
      methodType: 'telegram',
      actionTarget: 'floating_contact_panel',
      actionType: 'open_link',
    })

    const request = JSON.stringify(api.mock.calls[0])
    expect(request).not.toContain('me@example.com')
    expect(request).not.toContain('https://example.com')
    expect(request).not.toContain('token=secret')
  })

  it('executePixelInstructions 拒绝 Lead 与结构不完整指令', () => {
    useTracking().executePixelInstructions([
      instruction('Lead'),
      { ...instruction('Contact'), receiptToken: '' },
    ] as never)

    expect(adapter.standardEvent).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  })

  it('trackPageView、trackViewContent 和 trackSearch 只委托 adapter', () => {
    const tracking = useTracking()
    tracking.trackPageView()
    tracking.trackViewContent({ content_id: 'gallery_1', required_rank: 10 })
    tracking.trackSearch({ searchString: 'has_query=true', resultCount: 12 })

    expect(adapter.initialize).toHaveBeenCalledWith('123456789')
    expect(adapter.pageView).toHaveBeenCalledOnce()
    expect(adapter.standardEvent).toHaveBeenNthCalledWith(
      1,
      'ViewContent',
      { content_id: 'gallery_1', required_rank: 10 },
    )
    expect(adapter.standardEvent).toHaveBeenNthCalledWith(
      2,
      'Search',
      { search_string: 'has_query=true', result_count: 12 },
    )
  })

  it('Search 统一清洗并发送 snake_case payload', () => {
    useTracking().trackSearch({
      searchString: '联系 me@example.com',
      resultCount: 7,
    })

    expect(adapter.standardEvent).toHaveBeenCalledWith('Search', {
      search_string: '联系 [redacted_email]',
      result_count: 7,
    })
  })

  it('同页 Pixel ID 变化会重新初始化并补发 PageView', () => {
    route.fullPath = '/gallery/pixel-id-change'
    route.path = '/gallery/pixel-id-change'
    const tracking = useTracking()
    tracking.trackPageView()
    facebookPixelId.value = '987654321'
    tracking.trackPageView()

    expect(adapter.initialize).toHaveBeenNthCalledWith(1, '123456789')
    expect(adapter.initialize).toHaveBeenNthCalledWith(2, '987654321')
    expect(adapter.pageView).toHaveBeenCalledTimes(2)
  })

  it('配置禁用会 teardown，再启用同页会补发 PageView', () => {
    route.fullPath = '/gallery/pixel-reenable'
    route.path = '/gallery/pixel-reenable'
    const tracking = useTracking()
    tracking.trackPageView()
    facebookPixelEnabled.value = false
    tracking.trackPageView()
    facebookPixelEnabled.value = true
    tracking.trackPageView()

    expect(adapter.teardown).toHaveBeenCalledOnce()
    expect(adapter.initialize).toHaveBeenCalledTimes(2)
    expect(adapter.pageView).toHaveBeenCalledTimes(2)
  })

  it('注册归因只在 granted 范围读取 browser identifiers', () => {
    route = {
      name: 'register',
      path: '/register',
      fullPath: '/register?utm_content=hero',
      query: { utm_content: 'hero', fbclid: 'CLICK_abc-123' },
    }
    document.cookie = '_fbp=fb.1.1700000000000.123456789; path=/'

    const attribution = useTracking().buildRegistrationAttributionContext()

    expect(attribution).toMatchObject({
      visitorId: 'visitor_1',
      sessionId: 'session_1',
      routeName: 'register',
      path: '/register',
      utmContent: 'hero',
      consentState: 'granted',
      browserIdentifiers: {
        fbp: 'fb.1.1700000000000.123456789',
        fbc: `fb.1.${new Date('2026-07-10T08:00:00.000Z').getTime()}.CLICK_abc-123`,
      },
    })
  })

  it('注册归因在 limited 时不读取 browser identifiers', () => {
    marketingConsentState.value = 'limited'
    canTrackMarketing.value = false
    route.query.fbclid = 'CLICK_abc-123'

    const attribution = useTracking().buildRegistrationAttributionContext()

    expect(attribution).toMatchObject({ consentState: 'limited' })
    expect(attribution).not.toHaveProperty('browserIdentifiers')
  })

  it('后台与敏感 URL 不委托 adapter', () => {
    const tracking = useTracking()

    route.fullPath = '/admin/analytics'
    route.path = '/admin/analytics'
    tracking.trackPageView()
    route.fullPath = '/gallery/summer?token=secret'
    route.path = '/gallery/summer'
    tracking.trackPageView()

    expect(adapter.initialize).not.toHaveBeenCalled()
    expect(adapter.pageView).not.toHaveBeenCalled()
  })
})

function instruction(eventName: 'Contact' | 'Lead' | 'CompleteRegistration') {
  return {
    deliveryId: 'cdlv_1',
    eventName,
    eventId: `meta:${eventName}:contact_1`,
    payload: { method_type: 'telegram' },
    receiptToken: 'receipt_1',
  }
}
