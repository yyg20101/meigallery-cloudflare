import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'

describe('facebook-pixel plugin', () => {
  const route = { fullPath: '/welcome', path: '/welcome' }
  const afterEachHandlers: Array<(to: { fullPath: string; path: string }) => void> = []
  const fetchSettings = vi.fn()
  const initFacebookPixel = vi.fn()
  const trackPageView = vi.fn()
  const cleanupFacebookPixel = vi.fn()
  const consent = ref<'limited' | 'granted' | 'denied'>('limited')
  const facebookPixelEnabled = ref(true)
  const facebookPixelId = ref('123456789')
  const facebookPixelDebugEnabled = ref(false)

  beforeEach(() => {
    vi.resetModules()
    route.fullPath = '/welcome'
    route.path = '/welcome'
    afterEachHandlers.splice(0)
    consent.value = 'limited'
    fetchSettings.mockReset()
    fetchSettings.mockResolvedValue(undefined)
    initFacebookPixel.mockReset()
    trackPageView.mockReset()
    cleanupFacebookPixel.mockReset()

    vi.stubGlobal('defineNuxtPlugin', <T>(plugin: T) => plugin)
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({ afterEach: (handler: (to: { fullPath: string; path: string }) => void) => afterEachHandlers.push(handler) }))
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { appEnv: 'production' } }))
    vi.stubGlobal('useSiteSettings', () => ({
      fetchSettings,
      facebookPixelEnabled,
      facebookPixelId,
      facebookPixelDebugEnabled,
    }))
    vi.stubGlobal('useMarketingConsent', () => ({
      canTrackMarketing: computed(() => consent.value === 'granted'),
    }))
    vi.stubGlobal('useFacebookPixel', () => ({ initFacebookPixel, trackPageView, cleanupFacebookPixel }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('初始 limited 不初始化，同意后立即初始化并发送当前页 PageView，撤回后导航不再追踪', async () => {
    const plugin = (await import('./facebook-pixel.client')).default

    await plugin({} as never)
    expect(initFacebookPixel).not.toHaveBeenCalled()
    expect(trackPageView).not.toHaveBeenCalled()
    cleanupFacebookPixel.mockClear()

    consent.value = 'granted'
    await nextTick()
    expect(initFacebookPixel).toHaveBeenCalledWith('123456789', false, '/welcome')
    expect(trackPageView).toHaveBeenCalledWith('/welcome')

    consent.value = 'denied'
    await nextTick()
    expect(cleanupFacebookPixel).toHaveBeenCalledTimes(1)
    afterEachHandlers[0]?.({ fullPath: '/discover', path: '/discover' })
    expect(initFacebookPixel).toHaveBeenCalledTimes(1)
    expect(trackPageView).toHaveBeenCalledTimes(1)

    consent.value = 'granted'
    await nextTick()
    expect(initFacebookPixel).toHaveBeenCalledTimes(2)
    expect(trackPageView).toHaveBeenCalledTimes(2)
  })

  it('即使已经授权，后台和敏感 URL 仍不会初始化或发送 PageView', async () => {
    consent.value = 'granted'
    route.fullPath = '/admin/analytics'
    route.path = '/admin/analytics'
    const plugin = (await import('./facebook-pixel.client')).default

    await plugin({} as never)
    afterEachHandlers[0]?.({ fullPath: '/gallery/summer?token=secret', path: '/gallery/summer' })

    expect(initFacebookPixel).not.toHaveBeenCalled()
    expect(trackPageView).not.toHaveBeenCalled()
  })
})
