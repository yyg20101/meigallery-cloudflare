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
  provider: 'meta' as const,
  canonicalEvent: 'Contact' as const,
  externalEventId: 'mg3_meta_contact',
  descriptor: {
    provider: 'meta' as const,
    canonicalEvent: 'Contact' as const,
    browserEventName: 'Contact',
    browserDestination: 'meta_pixel',
    serverDestination: 'meta_capi',
  },
  payload: { method_type: 'telegram' },
}

describe('浏览器广告平台 adapter registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const adapter of Object.values(adapters)) {
      adapter.initialize.mockResolvedValue(true)
      adapter.track.mockResolvedValue(true)
      adapter.trackSignal.mockResolvedValue(true)
      adapter.teardown.mockResolvedValue(undefined)
    }
  })

  it('使用 Map 注册三平台且拒绝对象原型键', async () => {
    const { isRegisteredAdBrowserProvider } = await import('./adPlatformBrowser.client')

    expect(isRegisteredAdBrowserProvider('meta')).toBe(true)
    expect(isRegisteredAdBrowserProvider('tiktok')).toBe(true)
    expect(isRegisteredAdBrowserProvider('google')).toBe(true)
    expect(isRegisteredAdBrowserProvider('__proto__')).toBe(false)
    expect(isRegisteredAdBrowserProvider('constructor')).toBe(false)
  })

  it('只向当前 active provider 分发 instruction 和 signal', async () => {
    const { executeAdBrowserInstruction, initializeAdBrowserProvider, trackAdBrowserSignal } = await import('./adPlatformBrowser.client')

    await expect(initializeAdBrowserProvider({ provider: 'meta', pixelId: '123456789' }, consent)).resolves.toBe(true)
    await expect(executeAdBrowserInstruction(metaInstruction)).resolves.toBe(true)
    await expect(trackAdBrowserSignal('meta', 'PageView', {})).resolves.toBe(true)
    await expect(executeAdBrowserInstruction({ ...metaInstruction, provider: 'tiktok' })).resolves.toBe(false)

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
    const { initializeAdBrowserProvider } = await import('./adPlatformBrowser.client')

    await initializeAdBrowserProvider({ provider: 'meta', pixelId: '123456789' }, consent)
    await initializeAdBrowserProvider({ provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }, consent)
    await initializeAdBrowserProvider({ provider: 'google', tagId: 'AW-123456789', customerId: '123-456-7890', cloudProjectId: 'project-1' }, consent)

    expect(order).toEqual(['meta:teardown', 'tiktok:initialize', 'tiktok:teardown', 'google:initialize'])
  })

  it('未授权时不初始化且会卸载 active provider', async () => {
    const { initializeAdBrowserProvider } = await import('./adPlatformBrowser.client')
    await initializeAdBrowserProvider({ provider: 'meta', pixelId: '123456789' }, consent)

    await expect(initializeAdBrowserProvider(
      { provider: 'meta', pixelId: '123456789' },
      { ...consent, marketingAllowed: false, adUserDataAllowed: false },
    )).resolves.toBe(false)

    expect(adapters.meta.teardown).toHaveBeenCalledOnce()
    expect(adapters.meta.initialize).toHaveBeenCalledOnce()
  })
})
