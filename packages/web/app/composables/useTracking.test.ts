import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const adapter = vi.hoisted(() => ({
  initialize: vi.fn(),
  dispatch: vi.fn(),
  execute: vi.fn(),
  signal: vi.fn(),
  teardown: vi.fn(),
}))

vi.mock('~/adapters/adPlatformBrowser.client', () => ({
  initializeAdBrowserProvider: adapter.initialize,
  dispatchAdBrowserEvent: adapter.dispatch,
  executeAdBrowserInstruction: adapter.execute,
  trackAdBrowserSignal: adapter.signal,
  teardownAllAdBrowserProviders: adapter.teardown,
  isRegisteredAdBrowserProvider: (provider: unknown) => provider === 'meta' || provider === 'tiktok' || provider === 'google',
}))

import { useTracking } from './useTracking'

const api = vi.fn()
const trackAnalytics = vi.fn()
const flushAnalytics = vi.fn()
const attributionProvider = ref<'meta' | 'tiktok' | 'google' | null>('meta')
const attributionResolution = ref<'matched' | 'inherited' | 'none' | 'conflict'>('matched')
const publicConfig = ref<Record<string, string> | null>({ provider: 'meta', pixelId: '123456789' })
const browserEvents = ref([{
  provider: 'meta' as const,
  canonicalEvent: 'Contact' as const,
  browserEventName: 'Contact',
  browserDestination: 'meta_pixel',
}])
const resolveAdAttribution = vi.fn(async () => attributionProvider.value)
const getBrowserEventTemplate = vi.fn(() => (
  browserEvents.value.find(event => (
    event.provider === attributionProvider.value
    && event.canonicalEvent === 'Contact'
  )) ?? null
))
const clearAdAttribution = vi.fn(async () => {
  attributionProvider.value = null
  attributionResolution.value = 'none'
  publicConfig.value = null
  browserEvents.value = []
})
let route = {
  name: 'gallery-slug',
  path: '/gallery/summer',
  fullPath: '/gallery/summer?utm_content=button',
  query: { utm_content: 'button' } as Record<string, unknown>,
}

const metaInstruction = {
  provider: 'meta' as const,
  canonicalEvent: 'Contact' as const,
  externalEventId: `mg3_${'m'.repeat(43)}`,
  descriptor: {
    provider: 'meta' as const,
    canonicalEvent: 'Contact' as const,
    browserEventName: 'Contact',
    browserDestination: 'meta_pixel',
    serverDestination: 'meta_capi',
  },
  payload: { method_type: 'telegram' },
}

describe('useTracking', () => {
  beforeEach(() => {
    api.mockReset().mockResolvedValue({ data: { id: 'fact_1', created: true, trackingInstructions: [] } })
    trackAnalytics.mockReset()
    flushAnalytics.mockReset().mockResolvedValue(null)
    adapter.initialize.mockReset().mockResolvedValue(true)
    adapter.dispatch.mockReset().mockResolvedValue(true)
    adapter.execute.mockReset().mockResolvedValue(true)
    adapter.signal.mockReset().mockResolvedValue(true)
    adapter.teardown.mockReset().mockResolvedValue(undefined)
    attributionProvider.value = 'meta'
    attributionResolution.value = 'matched'
    publicConfig.value = { provider: 'meta', pixelId: '123456789' }
    browserEvents.value = [{
      provider: 'meta',
      canonicalEvent: 'Contact',
      browserEventName: 'Contact',
      browserDestination: 'meta_pixel',
    }]
    resolveAdAttribution.mockClear()
    clearAdAttribution.mockClear()
    getBrowserEventTemplate.mockClear()
    route = {
      name: 'gallery-slug',
      path: '/gallery/summer',
      fullPath: '/gallery/summer?utm_content=button',
      query: { utm_content: 'button' },
    }
    document.cookie = 'mg_ttclid=; Max-Age=0; Path=/'
    sessionStorage.clear()
    vi.stubGlobal('useApi', () => ({ api }))
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useSiteSettings', () => { throw new Error('禁止读取 browserConnections') })
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
      flush: flushAnalytics,
    }))
    vi.stubGlobal('useAdAttribution', () => ({
      provider: attributionProvider,
      resolution: attributionResolution,
      publicConfig,
      resolve: resolveAdAttribution,
      clear: clearAdAttribution,
      getBrowserEventTemplate,
    }))
  })

  afterEach(async () => {
    await useTracking().teardownAdBrowserTracking()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('合法 open_link 在离页前以同一编号发送 Browser Pixel 与唯一服务端事实', async () => {
    await useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      method: 'POST',
      keepalive: true,
      body: expect.objectContaining({
        actionType: 'open_link',
        contactMethodId: 'contact_123',
        methodType: 'telegram',
      }),
    }))
    const body = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    expect(body.externalEventId).toMatch(/^mg3_[A-Za-z0-9_-]{43}$/)
    expect(body).not.toHaveProperty('actionTarget')
    expect(JSON.stringify(body)).not.toContain('actionType":"contact')
    expect(adapter.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'meta',
      canonicalEvent: 'Contact',
      externalEventId: body.externalEventId,
      browserEventName: 'Contact',
      browserDestination: 'meta_pixel',
    }))
    expect(trackAnalytics).not.toHaveBeenCalled()
    expect(flushAnalytics).not.toHaveBeenCalled()
    expect(adapter.execute).not.toHaveBeenCalled()
    expect(resolveAdAttribution).not.toHaveBeenCalled()
  })

  it('Conversion API 未返回时，离页所需动作已经同步启动', async () => {
    let release!: (value: unknown) => void
    api.mockReturnValueOnce(new Promise(resolve => {
      release = resolve
    }))

    const request = useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    expect(trackAnalytics).not.toHaveBeenCalled()
    expect(flushAnalytics).not.toHaveBeenCalled()
    expect(adapter.dispatch).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      keepalive: true,
    }))
    release({ data: { id: 'fact_1', created: true, trackingInstructions: [] } })
    await request
  })

  it('同一 session 的重复联系复用一个外部事件编号', async () => {
    const tracking = useTracking()
    await tracking.trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })
    await tracking.trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    const bodies = api.mock.calls.map(call => call[1]?.body as { externalEventId?: string })
    expect(bodies[0]?.externalEventId).toBeTruthy()
    expect(bodies[1]?.externalEventId).toBe(bodies[0]?.externalEventId)
  })

  it('Contact 向服务端携带原始来源信号但不声明 provider', async () => {
    route.fullPath = '/gallery/summer?mg_source=ad-meta-team&fbclid=meta-click'
    route.query = { mg_source: 'ad-meta-team', fbclid: 'meta-click' }

    await useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    const body = api.mock.calls.find(call => call[0] === '/api/conversions/events')?.[1]?.body
    expect(body).toEqual(expect.objectContaining({
      adAttributionSignals: {
        fbclid: 'meta-click',
        ttclid: '',
        gclid: '',
        gbraid: '',
        wbraid: '',
        trackingSourceSlug: 'ad-meta-team',
      },
    }))
    expect(body).not.toHaveProperty('provider')
  })

  it('Contact 遇到瞬时失败时使用同一 body 有界幂等重试', async () => {
    vi.useFakeTimers()
    api
      .mockRejectedValueOnce(Object.assign(new Error('temporary unavailable'), { statusCode: 503 }))
      .mockResolvedValueOnce({ data: { id: 'fact_1', created: true, trackingInstructions: [metaInstruction] } })

    const tracking = useTracking()
    const request = tracking.trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })
    await vi.runAllTimersAsync()
    await request

    const conversionCalls = api.mock.calls.filter(call => call[0] === '/api/conversions/events')
    expect(conversionCalls).toHaveLength(2)
    expect(conversionCalls[1]?.[1]?.body).toEqual(conversionCalls[0]?.[1]?.body)
    expect(adapter.dispatch).toHaveBeenCalledOnce()
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('平台脚本执行失败不触发第二条浏览器补发路径，也不影响服务端事实', async () => {
    api.mockResolvedValueOnce({ data: { id: 'fact_1', created: true, trackingInstructions: [metaInstruction] } })
    adapter.dispatch.mockResolvedValueOnce(false)

    await useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    expect(api.mock.calls.filter(call => call[0] === '/api/conversions/events')).toHaveLength(1)
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('缓存模板与当前来源不一致时失败关闭，不依据响应补发 Browser 事件', async () => {
    attributionProvider.value = 'tiktok'
    publicConfig.value = { provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }
    browserEvents.value = [{
      provider: 'meta',
      canonicalEvent: 'Contact',
      browserEventName: 'Contact',
      browserDestination: 'meta_pixel',
    }]
    api.mockResolvedValueOnce({ data: { id: 'fact_tiktok', created: true, trackingInstructions: [metaInstruction] } })

    await useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    expect(adapter.dispatch).not.toHaveBeenCalled()
    expect(adapter.initialize).not.toHaveBeenCalled()
    expect(adapter.execute).not.toHaveBeenCalled()
    const body = api.mock.calls[0]?.[1]?.body as Record<string, unknown>
    expect(body).not.toHaveProperty('externalEventId')
  })

  it('Contact 遇到业务 4xx 时不重试', async () => {
    api.mockRejectedValueOnce(Object.assign(new Error('invalid contact'), { statusCode: 400 }))

    await useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'telegram',
      actionType: 'open_link',
    })

    expect(api).toHaveBeenCalledOnce()
    expect(adapter.execute).not.toHaveBeenCalled()
    expect(adapter.dispatch).toHaveBeenCalledOnce()
  })

  it('copy 永不 POST conversion 或执行广告 instruction', async () => {
    await useTracking().trackContact({
      contactMethodId: 'contact_123',
      methodType: 'wechat',
      actionType: 'copy',
    } as never)

    expect(api).not.toHaveBeenCalled()
    expect(adapter.initialize).not.toHaveBeenCalled()
    expect(adapter.dispatch).not.toHaveBeenCalled()
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('跨 provider instruction 和旧 instruction 结构均 fail closed', async () => {
    await useTracking().executeBrowserInstructions([
      { ...metaInstruction, provider: 'tiktok' },
      { provider: 'meta', eventName: 'Contact', eventId: 'legacy', payload: {} },
    ] as never)

    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('PageView 只用已解析的当前 provider 配置初始化并发送 Browser Signal', async () => {
    await useTracking().trackPageView()

    expect(resolveAdAttribution).toHaveBeenCalledWith(route)
    expect(adapter.initialize).toHaveBeenCalledWith({ provider: 'meta', pixelId: '123456789' })
    expect(adapter.signal).toHaveBeenCalledWith('meta', 'PageView', {})
  })

  it('同一路由并发初始化时只发送一次 PageView', async () => {
    const tracking = useTracking()

    await Promise.all([
      tracking.trackPageView(),
      tracking.trackPageView(),
    ])

    expect(adapter.signal).toHaveBeenCalledTimes(1)
    expect(adapter.signal).toHaveBeenCalledWith('meta', 'PageView', {})
  })

  it('来源切换后只初始化新的 Google provider', async () => {
    await useTracking().trackPageView()
    adapter.initialize.mockClear()
    route.fullPath = '/gallery/google?gclid=click'
    route.query = { gclid: 'click' }
    attributionProvider.value = 'google'
    publicConfig.value = { provider: 'google', tagId: 'AW-123456789' }

    await useTracking().trackPageView()

    expect(adapter.initialize).toHaveBeenCalledOnce()
    expect(adapter.initialize).toHaveBeenCalledWith(publicConfig.value)
    expect(adapter.signal).toHaveBeenCalledWith('google', 'PageView', {})
  })

  it('PageView/ViewContent/Search 只发送 signal，不调用 conversion API 或创建事件编号', async () => {
    const tracking = useTracking()
    await tracking.trackPageView()
    await tracking.trackViewContent({ content_id: 'gallery_1', required_rank: 10 })
    await tracking.trackSearch({ searchString: '联系 me@example.com', resultCount: 7 })

    expect(api.mock.calls.some(call => call[0] === '/api/conversions/events')).toBe(false)
    expect(adapter.execute).not.toHaveBeenCalled()
    expect(adapter.signal).toHaveBeenCalledWith('meta', 'ViewContent', { content_id: 'gallery_1', required_rank: 10 })
    expect(adapter.signal).toHaveBeenCalledWith('meta', 'Search', { search_string: '联系 [redacted_email]', result_count: 7 })
  })

  it('自然流量且没有历史来源时不初始化任何广告平台', async () => {
    attributionProvider.value = null
    attributionResolution.value = 'none'
    publicConfig.value = null

    await useTracking().trackPageView()

    expect(adapter.teardown).toHaveBeenCalledOnce()
    expect(adapter.initialize).not.toHaveBeenCalled()
  })

  it('注册归因只读取当前 Meta provider 的 identifier', async () => {
    route = {
      name: 'register',
      path: '/register',
      fullPath: '/register?fbclid=meta-click&ttclid=tiktok-click',
      query: { fbclid: 'meta-click', ttclid: 'tiktok-click' },
    }
    document.cookie = '_fbp=fb.1.1700000000000.123456789; Path=/'
    document.cookie = '_ttp=tiktok-cookie; Path=/'

    const context = await useTracking().buildRegistrationAttributionContext()

    expect(context.browserIdentifiers).toMatchObject({ fbp: 'fb.1.1700000000000.123456789' })
    expect(context.browserIdentifiers).not.toHaveProperty('ttclid')
    expect(context.browserIdentifiers).not.toHaveProperty('ttp')
  })

  it('后台或敏感 URL 不初始化广告平台', async () => {
    route.fullPath = '/admin/analytics?token=secret'
    route.path = '/admin/analytics'

    await useTracking().trackPageView()

    expect(adapter.initialize).not.toHaveBeenCalled()
    expect(adapter.signal).not.toHaveBeenCalled()
    expect(adapter.teardown).toHaveBeenCalled()
  })
})
