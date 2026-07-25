import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const consent = {
  consentVersion: 1,
  marketingAllowed: true,
  adUserDataAllowed: true,
  adPersonalizationAllowed: false,
  decidedAt: '2026-07-15T00:00:00.000Z',
}

function instruction(provider: 'meta' | 'tiktok' = 'meta') {
  return {
    schemaVersion: 1 as const,
    deliveryId: 'delivery_meta_contact_1',
    provider,
    canonicalEvent: 'Contact' as const,
    eventName: 'Contact',
    destination: 'meta_pixel',
    externalEventId: 'mg3_meta_contact_1',
    receiptToken: `v1.${'a'.repeat(16)}.${'b'.repeat(43)}`,
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

  it('未同意时零脚本和零平台调用', async () => {
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()
    const append = vi.spyOn(document.head, 'appendChild')

    await expect(adapter.initialize(
      { provider: 'meta', pixelId: '123456789' },
      { ...consent, marketingAllowed: false },
    )).resolves.toBe(false)

    expect(append).not.toHaveBeenCalled()
    expect(window.fbq).toBeUndefined()
  })

  it('使用 externalEventId 发送 Meta eventID 并映射安全 signal', async () => {
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    await expect(adapter.initialize({ provider: 'meta', pixelId: '123456789' }, consent)).resolves.toBe(true)
    await expect(adapter.trackSignal('PageView', {})).resolves.toBe(true)
    await expect(adapter.trackSignal('ViewContent', { content_id: 'gallery_1' })).resolves.toBe(true)
    await expect(adapter.track(instruction())).resolves.toBe(true)

    expect(window.fbq?.queue).toEqual([
      ['init', '123456789'],
      ['track', 'PageView'],
      ['track', 'ViewContent', { content_id: 'gallery_1' }],
      ['track', 'Contact', { method_type: 'telegram' }, { eventID: 'mg3_meta_contact_1' }],
    ])
  })

  it('跨 provider instruction 和非法 externalEventId 均 fail closed', async () => {
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)
    await adapter.initialize({ provider: 'meta', pixelId: '123456789' }, consent)

    await expect(adapter.track(instruction('tiktok'))).resolves.toBe(false)
    await expect(adapter.track({ ...instruction(), externalEventId: 'person@example.com' })).resolves.toBe(false)
    expect(window.fbq?.queue).toEqual([['init', '123456789']])
  })

  it('检测到第三方 fbq 时 fail closed 且不接管', async () => {
    const thirdPartyFbq = Object.assign(vi.fn(), { queue: [], loaded: true, version: '2.0' })
    window.fbq = thirdPartyFbq
    window._fbq = thirdPartyFbq
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()

    await expect(adapter.initialize({ provider: 'meta', pixelId: '123456789' }, consent)).resolves.toBe(false)
    await adapter.teardown()

    expect(window.fbq).toBe(thirdPartyFbq)
    expect(window._fbq).toBe(thirdPartyFbq)
    expect(thirdPartyFbq).not.toHaveBeenCalled()
  })
})
