import { beforeEach, describe, expect, it, vi } from 'vitest'

const adapters = vi.hoisted(() => ({
  meta: {
    initialize: vi.fn(() => true),
    pageView: vi.fn(() => true),
    standardEvent: vi.fn(() => true),
    teardown: vi.fn(),
  },
  tiktok: {
    initialize: vi.fn(() => true),
    pageView: vi.fn(() => true),
    standardEvent: vi.fn(() => true),
    teardown: vi.fn(),
  },
}))
vi.mock('./metaPixel.client', () => ({ metaPixelAdapter: adapters.meta }))
vi.mock('./tiktokPixel.client', () => ({ tiktokPixelAdapter: adapters.tiktok }))

describe('浏览器广告平台 adapter registry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按 provider 分发 Meta 指令', async () => {
    const { executeAdBrowserInstruction } = await import('./adPlatformBrowser.client')
    expect(executeAdBrowserInstruction({
      provider: 'meta',
      deliveryId: 'delivery_1',
      eventName: 'Contact',
      eventId: 'event_1',
      payload: {},
      receiptToken: 'receipt_1',
    })).toBe(true)
    expect(adapters.meta.standardEvent).toHaveBeenCalledWith('Contact', {}, { eventID: 'event_1' })
  })

  it('注册表统一识别支持的平台并卸载全部 adapter', async () => {
    const { isRegisteredAdBrowserProvider, teardownAllAdBrowserProviders } = await import('./adPlatformBrowser.client')

    expect(isRegisteredAdBrowserProvider('meta')).toBe(true)
    expect(isRegisteredAdBrowserProvider('tiktok')).toBe(true)
    expect(isRegisteredAdBrowserProvider('google')).toBe(false)

    teardownAllAdBrowserProviders()
    expect(adapters.meta.teardown).toHaveBeenCalledOnce()
    expect(adapters.tiktok.teardown).toHaveBeenCalledOnce()
  })
})
