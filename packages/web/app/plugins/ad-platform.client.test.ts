import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'

describe('广告平台浏览器插件', () => {
  const afterEachHandlers: Array<() => void> = []
  const trackPageView = vi.fn()
  const teardownAdBrowserTracking = vi.fn()
  const clearAdAttribution = vi.fn()
  const refreshMarketingConsent = vi.fn()
  let consent = ref<'limited' | 'granted' | 'denied'>('limited')

  beforeEach(() => {
    vi.resetModules()
    afterEachHandlers.splice(0)
    consent = ref<'limited' | 'granted' | 'denied'>('limited')
    trackPageView.mockReset().mockResolvedValue(undefined)
    teardownAdBrowserTracking.mockReset().mockResolvedValue(undefined)
    clearAdAttribution.mockReset().mockResolvedValue(undefined)
    refreshMarketingConsent.mockReset().mockResolvedValue(undefined)

    vi.stubGlobal('defineNuxtPlugin', <T>(plugin: T) => plugin)
    vi.stubGlobal('useRouter', () => ({ afterEach: (handler: () => void) => afterEachHandlers.push(handler) }))
    vi.stubGlobal('useSiteSettings', () => { throw new Error('禁止读取 public settings 广告连接') })
    vi.stubGlobal('useMarketingConsent', () => ({
      canTrackMarketing: computed(() => consent.value === 'granted'),
      refresh: refreshMarketingConsent,
    }))
    vi.stubGlobal('useTracking', () => ({ trackPageView, teardownAdBrowserTracking, clearAdAttribution }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('授权和路由变化只委托 Tracking Facade 从 bootstrap 同步当前 provider', async () => {
    const plugin = (await import('./ad-platform.client')).default

    await plugin({} as never)
    await nextTick()
    expect(clearAdAttribution).toHaveBeenCalledOnce()
    expect(trackPageView).not.toHaveBeenCalled()

    consent.value = 'granted'
    await nextTick()
    expect(trackPageView).toHaveBeenCalledOnce()

    await afterEachHandlers[0]?.()
    expect(trackPageView).toHaveBeenCalledTimes(2)

    consent.value = 'denied'
    await nextTick()
    expect(clearAdAttribution).toHaveBeenCalledTimes(2)
  })

  it('初始化 consent refresh 失败时不启用外部脚本并安全 teardown', async () => {
    consent.value = 'granted'
    refreshMarketingConsent.mockRejectedValueOnce(new Error('receipt unavailable'))
    const plugin = (await import('./ad-platform.client')).default

    await expect(plugin({} as never)).resolves.toBeUndefined()

    expect(trackPageView).not.toHaveBeenCalled()
    expect(teardownAdBrowserTracking).toHaveBeenCalledOnce()
    expect(afterEachHandlers).toHaveLength(0)
  })
})
