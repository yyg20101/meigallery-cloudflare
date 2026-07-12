import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('初始化一次 PageView 并发送带 event_id 的标准事件', async () => {
    const { createTikTokPixelAdapter } = await import('./tiktokPixel.client')
    const adapter = createTikTokPixelAdapter()
    let script: HTMLScriptElement | undefined
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
      script = node as unknown as HTMLScriptElement
      return node
    })

    expect(adapter.initialize('c123456789abcdef')).toBe(true)
    expect(adapter.pageView()).toBe(true)
    expect(adapter.pageView()).toBe(false)
    expect(adapter.standardEvent('Contact', { method_type: 'telegram' }, 'event_1')).toBe(true)

    expect(window.ttq).toEqual(expect.arrayContaining([
      ['page'],
      ['track', 'Contact', { method_type: 'telegram', event_id: 'event_1' }],
    ]))
    expect(script?.src).toContain('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C123456789ABCDEF&lib=ttq')
    expect(script?.referrerPolicy).toBe('no-referrer')
  })

  it('拒绝非法 ID 并在 teardown 后移除自有全局对象', async () => {
    const { createTikTokPixelAdapter } = await import('./tiktokPixel.client')
    const adapter = createTikTokPixelAdapter()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    expect(adapter.initialize('ttq.track(1)')).toBe(false)
    expect(adapter.initialize('C123456789ABCDEF')).toBe(true)
    adapter.teardown()

    expect(window.ttq).toBeUndefined()
    expect(window.TiktokAnalyticsObject).toBeUndefined()
    expect(adapter.standardEvent('Contact')).toBe(false)
  })
})
