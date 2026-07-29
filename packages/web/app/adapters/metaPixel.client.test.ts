import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const EVENT_ID = `mg3_${'m'.repeat(43)}`

function event(provider: 'meta' | 'tiktok' = 'meta') {
  return {
    provider,
    canonicalEvent: 'Contact' as const,
    externalEventId: EVENT_ID,
    browserEventName: 'Contact',
    browserDestination: 'meta_pixel',
    payload: { method_type: 'telegram' },
  }
}

describe('Meta Pixel adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    delete window.fbq
    delete window._fbq
    document.head.querySelectorAll('script[src*="fbevents.js"]').forEach(element => element.remove())
  })

  afterEach(() => {
    delete window.fbq
    delete window._fbq
    vi.restoreAllMocks()
  })

  it('使用 externalEventId 发送 Meta eventID 并映射安全 signal', async () => {
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    await expect(adapter.initialize({ provider: 'meta', pixelId: '123456789' })).resolves.toBe(true)
    await expect(adapter.trackSignal('PageView', {})).resolves.toBe(true)
    await expect(adapter.trackSignal('ViewContent', { content_id: 'gallery_1' })).resolves.toBe(true)
    await expect(adapter.track(event())).resolves.toBe(true)

    expect(window.fbq?.queue).toEqual([
      ['init', '123456789'],
      ['track', 'PageView'],
      ['track', 'ViewContent', { content_id: 'gallery_1' }],
      ['track', 'Contact', { method_type: 'telegram' }, { eventID: EVENT_ID }],
    ])
  })

  it('跨 provider event 和非法 externalEventId 均 fail closed', async () => {
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'meta', pixelId: '123456789' })

    await expect(adapter.track(event('tiktok'))).resolves.toBe(false)
    await expect(adapter.track({ ...event(), externalEventId: 'person@example.com' })).resolves.toBe(false)
    expect(window.fbq?.queue).toEqual([['init', '123456789']])
  })

  it('检测到第三方 fbq 时 fail closed 且不接管', async () => {
    const thirdPartyFbq = Object.assign(vi.fn(), { queue: [], loaded: true, version: '2.0' })
    window.fbq = thirdPartyFbq
    window._fbq = thirdPartyFbq
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()

    await expect(adapter.initialize({ provider: 'meta', pixelId: '123456789' })).resolves.toBe(false)
    await adapter.teardown()

    expect(window.fbq).toBe(thirdPartyFbq)
    expect(window._fbq).toBe(thirdPartyFbq)
    expect(thirdPartyFbq).not.toHaveBeenCalled()
  })
})
