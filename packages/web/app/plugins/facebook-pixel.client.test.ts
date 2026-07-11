import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'

describe('facebook-pixel plugin', () => {
  const afterEachHandlers: Array<() => void> = []
  const fetchSettings = vi.fn()
  const trackPageView = vi.fn()
  const teardownPixel = vi.fn()
  const consent = ref<'limited' | 'granted' | 'denied'>('limited')
  const facebookPixelEnabled = ref(true)
  const facebookPixelId = ref('123456789')
  const facebookPixelDebugEnabled = ref(false)

  beforeEach(() => {
    vi.resetModules()
    afterEachHandlers.splice(0)
    consent.value = 'limited'
    fetchSettings.mockReset()
    fetchSettings.mockResolvedValue(undefined)
    trackPageView.mockReset()
    teardownPixel.mockReset()

    vi.stubGlobal('defineNuxtPlugin', <T>(plugin: T) => plugin)
    vi.stubGlobal('useRouter', () => ({ afterEach: (handler: () => void) => afterEachHandlers.push(handler) }))
    vi.stubGlobal('useSiteSettings', () => ({
      fetchSettings,
      facebookPixelEnabled,
      facebookPixelId,
      facebookPixelDebugEnabled,
    }))
    vi.stubGlobal('useMarketingConsent', () => ({
      canTrackMarketing: computed(() => consent.value === 'granted'),
      refresh: vi.fn(async () => undefined),
    }))
    vi.stubGlobal('useTracking', () => ({ trackPageView, teardownPixel }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('设置、授权和路由变化都只委托 Tracking Facade 重新判断 PageView', async () => {
    const plugin = (await import('./facebook-pixel.client')).default

    await plugin({} as never)
    expect(fetchSettings).toHaveBeenCalledOnce()
    expect(teardownPixel).toHaveBeenCalledTimes(1)
    expect(trackPageView).not.toHaveBeenCalled()

    consent.value = 'granted'
    await nextTick()
    expect(trackPageView).toHaveBeenCalledTimes(1)

    facebookPixelId.value = '987654321'
    await nextTick()
    expect(trackPageView).toHaveBeenCalledTimes(2)

    afterEachHandlers[0]?.()
    expect(trackPageView).toHaveBeenCalledTimes(3)

    consent.value = 'denied'
    await nextTick()
    expect(teardownPixel).toHaveBeenCalledTimes(2)
    expect(trackPageView).toHaveBeenCalledTimes(3)
  })
})
