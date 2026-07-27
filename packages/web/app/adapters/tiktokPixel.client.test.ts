import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function instruction(provider: 'tiktok' | 'meta' = 'tiktok') {
  return {
    provider,
    canonicalEvent: 'CompleteRegistration' as const,
    externalEventId: 'mg3_tiktok_registration_1',
    descriptor: {
      provider,
      canonicalEvent: 'CompleteRegistration' as const,
      browserEventName: 'CompleteRegistration',
      browserDestination: 'tiktok_pixel',
      serverDestination: 'tiktok_events_api',
    },
    payload: { content_type: 'registration' },
  }
}

describe('TikTok Pixel adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    delete window.ttq
    delete window.TiktokAnalyticsObject
    document.head.querySelectorAll('script[src*="analytics.tiktok.com"]').forEach(element => element.remove())
  })

  afterEach(() => {
    delete window.ttq
    delete window.TiktokAnalyticsObject
    vi.restoreAllMocks()
  })

  it('使用 externalEventId 发送 TikTok event_id 并映射安全 signal', async () => {
    const { createTikTokPixelAdapter } = await import('./tiktokPixel.client')
    const adapter = createTikTokPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    await expect(adapter.initialize({ provider: 'tiktok', pixelCode: 'C123456789ABCDEF' })).resolves.toBe(true)
    await expect(adapter.trackSignal('PageView', {})).resolves.toBe(true)
    await expect(adapter.trackSignal('Search', { search_string: 'portrait' })).resolves.toBe(true)
    await expect(adapter.track(instruction())).resolves.toBe(true)

    expect(window.ttq).toEqual(expect.arrayContaining([
      ['page'],
      ['track', 'Search', { search_string: 'portrait' }],
      ['track', 'CompleteRegistration', { content_type: 'registration' }, { event_id: 'mg3_tiktok_registration_1' }],
    ]))
  })

  it('跨 provider instruction 和非法 externalEventId 均 fail closed', async () => {
    const { createTikTokPixelAdapter } = await import('./tiktokPixel.client')
    const adapter = createTikTokPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'tiktok', pixelCode: 'C123456789ABCDEF' })

    await expect(adapter.track(instruction('meta'))).resolves.toBe(false)
    await expect(adapter.track({ ...instruction(), externalEventId: 'person@example.com' })).resolves.toBe(false)
    expect(window.ttq?.some(item => Array.isArray(item) && item[0] === 'track')).toBe(false)
  })

  it('检测到第三方 ttq 时 fail closed 且不接管', async () => {
    const thirdPartyQueue = [] as NonNullable<Window['ttq']>
    thirdPartyQueue.load = vi.fn()
    window.ttq = thirdPartyQueue
    window.TiktokAnalyticsObject = 'ttq'
    const { createTikTokPixelAdapter } = await import('./tiktokPixel.client')
    const adapter = createTikTokPixelAdapter()

    await expect(adapter.initialize({ provider: 'tiktok', pixelCode: 'C123456789ABCDEF' })).resolves.toBe(false)
    await adapter.teardown()

    expect(window.ttq).toBe(thirdPartyQueue)
    expect(window.TiktokAnalyticsObject).toBe('ttq')
    expect(thirdPartyQueue.load).not.toHaveBeenCalled()
  })
})
