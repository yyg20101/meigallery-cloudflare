import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useAnalytics, resetAnalyticsForTest } from './useAnalytics'

const apiMock = vi.fn()
const stateStore = new Map<string, ReturnType<typeof ref>>()
let route = { fullPath: '/', path: '/', params: {} }

vi.stubGlobal('useApi', () => ({ api: apiMock, baseURL: 'https://api.example.com' }))
vi.stubGlobal('useRoute', () => route)
vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
  if (!stateStore.has(key)) stateStore.set(key, ref(init()))
  return stateStore.get(key)
})

describe('useAnalytics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-07T10:00:00.000Z'))
    apiMock.mockReset()
    apiMock.mockResolvedValue({ accepted: 1, rejected: 0, duplicate: 0 })
    stateStore.clear()
    localStorage.clear()
    sessionStorage.clear()
    document.title = '测试页面'
    route = { fullPath: '/', path: '/', params: {} }
    resetAnalyticsForTest()
  })

  afterEach(() => {
    resetAnalyticsForTest()
    vi.useRealTimers()
  })

  it('关闭时不初始化 visitor/session，也不排队事件', () => {
    const analytics = useAnalytics()
    analytics.initialize({ enabled: false, route })
    analytics.trackPageView(route)

    expect(analytics.getContext().visitorId).toBe('')
    expect(localStorage.getItem('mg_analytics_visitor_id')).toBeNull()
    expect(analytics.state.value.queue).toHaveLength(0)
  })

  it('开启后生成 visitor/session，并能 flush 批量事件', async () => {
    const analytics = useAnalytics()
    analytics.initialize({ enabled: true, consentState: 'granted', route })
    analytics.trackPageView(route)

    expect(analytics.getContext().visitorId).toMatch(/^visitor_/)
    expect(analytics.getContext().sessionId).toMatch(/^session_/)
    expect(localStorage.getItem('mg_analytics_visitor_id')).toContain('visitor_')

    await analytics.flush()

    expect(apiMock).toHaveBeenCalledWith('/api/analytics/events', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        visitorId: expect.stringMatching(/^visitor_/),
        sessionId: expect.stringMatching(/^session_/),
        events: expect.arrayContaining([
          expect.objectContaining({ eventName: 'session_start' }),
          expect.objectContaining({ eventName: 'page_view', routeName: '/' }),
        ]),
      }),
    }))
  })

  it('会把初始化来源上下文自动附加到事件', async () => {
    const analytics = useAnalytics()
    analytics.initialize({
      enabled: true,
      consentState: 'granted',
      sourceChannel: 'social',
      sourceContext: {
        referrer: 'https://t.me/channel',
        referrerHost: 't.me',
        utmSource: 'telegram-june',
        utmMedium: 'social',
        utmCampaign: 'telegram-june',
        trackingSourceSlug: 'telegram-june',
        sourceName: 'telegram-june',
      },
      route,
    })
    analytics.trackPageView(route)

    await analytics.flush()

    const body = apiMock.mock.calls[0]?.[1]?.body
    expect(body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: 'page_view',
        referrerHost: 't.me',
        utmSource: 'telegram-june',
        utmMedium: 'social',
        utmCampaign: 'telegram-june',
        trackingSourceSlug: 'telegram-june',
        sourceChannel: 'social',
        props: expect.objectContaining({
          source_name: 'telegram-june',
          tracking_source_slug: 'telegram-june',
          utm_source: 'telegram-june',
        }),
      }),
    ]))
  })

  it('limited consent 会跳过非必要点击和曝光事件', () => {
    const analytics = useAnalytics()
    analytics.initialize({ enabled: true, consentState: 'limited', route })
    analytics.track('home_ad_click', { props: { ad_id: 'ad_1' } })
    analytics.track('register_submit', { props: { email_verification_enabled: false } })

    expect(analytics.state.value.queue.some(event => event.eventName === 'home_ad_click')).toBe(false)
    expect(analytics.state.value.queue.some(event => event.eventName === 'register_submit')).toBe(true)
  })

  it('15 秒心跳只累计有效浏览时长，不发网络请求', async () => {
    const analytics = useAnalytics()
    analytics.initialize({ enabled: true, consentState: 'granted', route })
    analytics.trackPageView(route)
    await analytics.flush()
    apiMock.mockClear()

    vi.advanceTimersByTime(15_000)

    expect(analytics.state.value.currentPageActiveSeconds).toBe(15)
    expect(apiMock).not.toHaveBeenCalled()
  })

  it('page leave 会记录有效浏览秒数并用 sendBeacon 兜底发送', async () => {
    const sendBeacon = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true })
    const analytics = useAnalytics()
    analytics.initialize({ enabled: true, consentState: 'granted', route })
    analytics.trackPageView(route)
    analytics.state.value.currentPageStartedAt = Date.now() - 20_000
    analytics.trackPageLeave(route)

    await analytics.flush({ beacon: true })
    analytics.sendSessionEnd({ beacon: true })

    expect(sendBeacon).toHaveBeenCalledWith('https://api.example.com/api/analytics/events', expect.any(Blob))
    expect(sendBeacon).toHaveBeenCalledWith('https://api.example.com/api/analytics/session/end', expect.any(Blob))
  })

  it('flush 失败会把事件放回队列并持久化到 localStorage', async () => {
    apiMock.mockRejectedValueOnce(new Error('network'))
    const analytics = useAnalytics()
    analytics.initialize({ enabled: true, consentState: 'granted', route })
    analytics.track('login_submit', { props: { identifier_type: 'email' } })

    await analytics.flush()

    expect(analytics.state.value.queue.length).toBeGreaterThan(0)
    expect(localStorage.getItem('mg_analytics_failed_queue')).toContain('login_submit')
  })
})
