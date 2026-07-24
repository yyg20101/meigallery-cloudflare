import { beforeEach, describe, expect, it, vi } from 'vitest'

const adapters = vi.hoisted(() => ({
  meta: { initialize: vi.fn(), track: vi.fn(), trackSignal: vi.fn(), teardown: vi.fn() },
  tiktok: { initialize: vi.fn(), track: vi.fn(), trackSignal: vi.fn(), teardown: vi.fn() },
  google: { initialize: vi.fn(), track: vi.fn(), trackSignal: vi.fn(), teardown: vi.fn() },
}))

vi.mock('./metaPixel.client', () => ({ metaPixelAdapter: adapters.meta }))
vi.mock('./tiktokPixel.client', () => ({ tiktokPixelAdapter: adapters.tiktok }))
vi.mock('./googleAds.client', () => ({ googleAdsAdapter: adapters.google }))

const consent = {
  consentVersion: 1,
  marketingAllowed: true,
  adUserDataAllowed: true,
  adPersonalizationAllowed: false,
  decidedAt: '2026-07-15T00:00:00.000Z',
}

const metaInstruction = {
  schemaVersion: 1 as const,
  deliveryId: 'delivery_meta_browser',
  provider: 'meta' as const,
  canonicalEvent: 'Contact' as const,
  eventName: 'Contact',
  destination: 'meta_pixel',
  externalEventId: 'mg3_meta_contact',
  receiptToken: `v1.${'a'.repeat(16)}.${'b'.repeat(43)}`,
  payload: { method_type: 'telegram' },
}

describe('浏览器广告平台 adapter registry', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    for (const adapter of Object.values(adapters)) {
      adapter.initialize.mockResolvedValue(true)
      adapter.track.mockResolvedValue(true)
      adapter.trackSignal.mockResolvedValue(true)
      adapter.teardown.mockResolvedValue(undefined)
    }
  })

  it('使用 Map 注册三平台且拒绝对象原型键', async () => {
    const { isRegisteredBrowserTrackingProvider } = await import('./registry.client')

    expect(isRegisteredBrowserTrackingProvider('meta')).toBe(true)
    expect(isRegisteredBrowserTrackingProvider('tiktok')).toBe(true)
    expect(isRegisteredBrowserTrackingProvider('google')).toBe(true)
    expect(isRegisteredBrowserTrackingProvider('__proto__')).toBe(false)
    expect(isRegisteredBrowserTrackingProvider('constructor')).toBe(false)
  })

  it('只向当前 active provider 分发 instruction 和 signal', async () => {
    const { executeBrowserTrackingInstruction, initializeBrowserTrackingProvider, trackBrowserTrackingSignal } = await import('./registry.client')

    await expect(initializeBrowserTrackingProvider({ provider: 'meta', pixelId: '123456789' }, consent)).resolves.toBe(true)
    await expect(executeBrowserTrackingInstruction(metaInstruction)).resolves.toBe(true)
    await expect(trackBrowserTrackingSignal('meta', 'PageView', {})).resolves.toBe(true)
    await expect(executeBrowserTrackingInstruction({ ...metaInstruction, provider: 'tiktok' })).resolves.toBe(false)

    expect(adapters.meta.initialize).toHaveBeenCalledWith({ provider: 'meta', pixelId: '123456789' }, consent)
    expect(adapters.meta.track).toHaveBeenCalledWith(metaInstruction)
    expect(adapters.meta.trackSignal).toHaveBeenCalledWith('PageView', {})
    expect(adapters.tiktok.track).not.toHaveBeenCalled()
  })

  it('来源从 Meta 切换到 TikTok 再切换 Google 时先 teardown', async () => {
    const order: string[] = []
    adapters.meta.teardown.mockImplementation(async () => { order.push('meta:teardown') })
    adapters.tiktok.teardown.mockImplementation(async () => { order.push('tiktok:teardown') })
    adapters.tiktok.initialize.mockImplementation(async () => { order.push('tiktok:initialize'); return true })
    adapters.google.initialize.mockImplementation(async () => { order.push('google:initialize'); return true })
    const { initializeBrowserTrackingProvider } = await import('./registry.client')

    await initializeBrowserTrackingProvider({ provider: 'meta', pixelId: '123456789' }, consent)
    await initializeBrowserTrackingProvider({ provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }, consent)
    await initializeBrowserTrackingProvider({ provider: 'google', tagId: 'AW-123456789' }, consent)

    expect(order).toEqual(['meta:teardown', 'tiktok:initialize', 'tiktok:teardown', 'google:initialize'])
  })

  it('未授权时不初始化且会卸载 active provider', async () => {
    const { initializeBrowserTrackingProvider } = await import('./registry.client')
    await initializeBrowserTrackingProvider({ provider: 'meta', pixelId: '123456789' }, consent)

    await expect(initializeBrowserTrackingProvider(
      { provider: 'meta', pixelId: '123456789' },
      { ...consent, marketingAllowed: false, adUserDataAllowed: false },
    )).resolves.toBe(false)

    expect(adapters.meta.teardown).toHaveBeenCalledOnce()
    expect(adapters.meta.initialize).toHaveBeenCalledOnce()
  })

  it('并发切换 provider 时严格串行化，新平台不会在旧平台 teardown 前初始化', async () => {
    let releaseMeta!: (value: boolean) => void
    const metaInitialization = new Promise<boolean>((resolve) => { releaseMeta = resolve })
    const order: string[] = []
    adapters.meta.initialize.mockImplementation(async () => {
      order.push('meta:initialize:start')
      const result = await metaInitialization
      order.push('meta:initialize:end')
      return result
    })
    adapters.meta.teardown.mockImplementation(async () => { order.push('meta:teardown') })
    adapters.tiktok.initialize.mockImplementation(async () => { order.push('tiktok:initialize'); return true })
    const { initializeBrowserTrackingProvider } = await import('./registry.client')

    const meta = initializeBrowserTrackingProvider({ provider: 'meta', pixelId: '123456789' }, consent)
    const tiktok = initializeBrowserTrackingProvider({ provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }, consent)
    await Promise.resolve()

    expect(order).toEqual(['meta:initialize:start'])
    releaseMeta(true)
    await expect(meta).resolves.toBe(true)
    await expect(tiktok).resolves.toBe(true)
    expect(order).toEqual([
      'meta:initialize:start',
      'meta:initialize:end',
      'meta:teardown',
      'tiktok:initialize',
    ])
  })

  it('当前 provider 重新初始化失败时 fail closed 并卸载旧实例', async () => {
    const { executeBrowserTrackingInstruction, initializeBrowserTrackingProvider } = await import('./registry.client')
    await initializeBrowserTrackingProvider({ provider: 'meta', pixelId: '123456789' }, consent)
    adapters.meta.initialize.mockResolvedValueOnce(false)

    await expect(initializeBrowserTrackingProvider({ provider: 'meta', pixelId: '987654321' }, consent)).resolves.toBe(false)
    await expect(executeBrowserTrackingInstruction(metaInstruction)).resolves.toBe(false)

    expect(adapters.meta.teardown).toHaveBeenCalledOnce()
    expect(adapters.meta.track).not.toHaveBeenCalled()
  })
})
