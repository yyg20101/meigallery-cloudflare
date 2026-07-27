import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('广告平台浏览器插件', () => {
  const afterEachHandlers: Array<() => void> = []
  const trackPageView = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    afterEachHandlers.splice(0)
    trackPageView.mockReset().mockResolvedValue(undefined)

    vi.stubGlobal('defineNuxtPlugin', <T>(plugin: T) => plugin)
    vi.stubGlobal('useRouter', () => ({ afterEach: (handler: () => void) => afterEachHandlers.push(handler) }))
    vi.stubGlobal('useSiteSettings', () => { throw new Error('禁止读取 public settings 广告连接') })
    vi.stubGlobal('useTracking', () => ({ trackPageView }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('首屏和路由变化只委托 Tracking Facade 同步当前来源 provider', async () => {
    const plugin = (await import('./ad-platform.client')).default

    await plugin({} as never)
    expect(trackPageView).toHaveBeenCalledOnce()
    expect(afterEachHandlers).toHaveLength(1)

    await afterEachHandlers[0]?.()
    expect(trackPageView).toHaveBeenCalledTimes(2)
  })
})
