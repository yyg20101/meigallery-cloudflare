import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Meta Pixel adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    const pixelWindow = window as unknown as { fbq?: unknown; _fbq?: unknown }
    delete pixelWindow.fbq
    delete pixelWindow._fbq
    document.head.querySelectorAll('script[src*="fbevents.js"]').forEach(element => element.remove())
  })

  afterEach(() => {
    const pixelWindow = window as unknown as { fbq?: unknown; _fbq?: unknown }
    delete pixelWindow.fbq
    delete pixelWindow._fbq
    document.head.querySelectorAll('script[src*="fbevents.js"]').forEach(element => element.remove())
  })

  it('初始化后发送 PageView 和带 eventID 的标准事件', async () => {
    const { metaPixelAdapter } = await import('./metaPixel.client')
    let appendedScript: HTMLScriptElement | undefined
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
      appendedScript = node as unknown as HTMLScriptElement
      return node
    })

    expect(metaPixelAdapter.initialize('123456789')).toBe(true)
    expect(metaPixelAdapter.pageView()).toBe(true)
    expect(metaPixelAdapter.standardEvent(
      'Contact',
      { method_type: 'telegram' },
      { eventID: 'meta:Contact:contact_1' },
    )).toBe(true)

    const fbq = (window as unknown as { fbq?: { queue: unknown[] } }).fbq
    expect(fbq?.queue).toEqual([
      ['init', '123456789'],
      ['track', 'PageView'],
      ['track', 'Contact', { method_type: 'telegram' }, { eventID: 'meta:Contact:contact_1' }],
    ])
    expect(appendedScript?.src).toBe('https://connect.facebook.net/en_US/fbevents.js')
    expect(appendedScript?.referrerPolicy).toBe('no-referrer')
  })

  it('未初始化或 Pixel ID 非法时不发送事件', async () => {
    const { createMetaPixelAdapter } = await import('./metaPixel.client')
    const adapter = createMetaPixelAdapter()

    expect(adapter.pageView()).toBe(false)
    expect(adapter.standardEvent('Search', { result_count: 0 })).toBe(false)
    expect(adapter.initialize('fbq("track")')).toBe(false)
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined()
  })

  it('重复初始化同一实例时只排队一次 init', async () => {
    const { metaPixelAdapter } = await import('./metaPixel.client')
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    expect(metaPixelAdapter.initialize('123456789')).toBe(true)
    expect(metaPixelAdapter.initialize('123456789')).toBe(true)

    const fbq = (window as unknown as { fbq?: { queue: unknown[] } }).fbq
    expect(fbq?.queue).toEqual([['init', '123456789']])
  })
})
