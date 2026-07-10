import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createFacebookPixelScript, FACEBOOK_PIXEL_SCRIPT_SRC, hasSensitiveAnalyticsUrl, sanitizeAnalyticsText } from './facebookPixel'

describe('facebookPixel 安全工具', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    const pixelWindow = window as unknown as { fbq?: unknown; _fbq?: unknown }
    delete pixelWindow.fbq
    delete pixelWindow._fbq
    document.head.querySelectorAll(`script[src="${FACEBOOK_PIXEL_SCRIPT_SRC}"]`).forEach(node => node.remove())
    vi.unstubAllGlobals()
  })

  it('识别 query 和 hash 中的凭证类参数', () => {
    for (const url of [
      '/gallery/summer?token=abc',
      '/search?api_key=abc',
      '/login?access-token=abc',
      '/user#session_id=abc',
      '/gallery#state=ok&signature=abc',
      '/gallery#/callback?access_token=abc',
      '/gallery#access_token%3Dabc',
      '/login?redirect=%2Fcallback%3Faccess_token%3Dabc',
      '/login?redirect=https%3A%2F%2Fexample.com%2Fcallback%3Fsignature%3Dabc',
      '/gallery?state=api_key%3Dabc',
      '/gallery#redirect=%2Fcallback%3Ftoken%3Dabc',
      'https://616618.xyz/gallery?x-amz-signature=abc',
    ]) {
      expect(hasSensitiveAnalyticsUrl(url)).toBe(true)
    }
  })

  it('允许普通页面路径用于埋点', () => {
    for (const url of [
      '/',
      '/gallery/summer?from=home',
      '/search?q=%E5%A4%8F%E6%97%A5',
      '/rules#content',
      'https://616618.xyz/gallery?utm_source=home',
    ]) {
      expect(hasSensitiveAnalyticsUrl(url)).toBe(false)
    }
  })

  it('清洗埋点文本中的联系方式、URL 和凭证参数', () => {
    expect(sanitizeAnalyticsText('联系 me@example.com 或 +86 138 0000 0000')).toBe('联系 [redacted_email] 或 [redacted_phone]')
    expect(sanitizeAnalyticsText('查看 https://example.com/rules?token=abc')).toBe('查看 [redacted_url]')
    expect(sanitizeAnalyticsText('搜索 api_key=abc&style=summer signature=xyz')).toBe('搜索 api_key=[redacted_credential]&style=summer signature=[redacted_credential]')
    expect(sanitizeAnalyticsText('授权 x-amz-signature=abc access-token=xyz')).toBe('授权 x-amz-signature=[redacted_credential] access-token=[redacted_credential]')
  })

  it('Pixel 脚本加载不发送来源页信息', () => {
    const script = createFacebookPixelScript()

    expect(script.async).toBe(true)
    expect(script.src).toBe(FACEBOOK_PIXEL_SCRIPT_SRC)
    expect(script.referrerPolicy).toBe('no-referrer')
  })

  it('Pixel adapter 通过 trackStandardEvent 发送标准事件和 eventID', async () => {
    vi.stubGlobal('useRoute', () => ({ fullPath: '/gallery/summer' }))
    vi.stubGlobal('useMarketingConsent', () => ({ canTrackMarketing: ref(true) }))
    const { useFacebookPixel } = await import('../composables/useFacebookPixel')
    const pixel = useFacebookPixel()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    pixel.initFacebookPixel('123456789')
    const sent = pixel.trackStandardEvent(
      'Contact',
      { location: 'floating_contact_panel', method_type: 'telegram' },
      { eventID: 'meta:Contact:contact:session_1:telegram:floating_contact_panel' },
    )

    const fbq = (window as unknown as { fbq?: { queue: unknown[] } }).fbq
    expect(sent).toBe(true)
    expect(fbq?.queue).toContainEqual([
      'track',
      'Contact',
      { location: 'floating_contact_panel', method_type: 'telegram' },
      { eventID: 'meta:Contact:contact:session_1:telegram:floating_contact_panel' },
    ])
    expect(pixel).not.toHaveProperty('trackLeadOnce')
    expect(pixel).not.toHaveProperty('trackContactClick')
    expect(pixel).not.toHaveProperty('trackCompleteRegistration')
    expect(pixel).not.toHaveProperty('trackStartTrialOnce')
  })

  it('授权撤回后，即使 adapter 已初始化也不再调用 fbq', async () => {
    const canTrackMarketing = ref(true)
    vi.stubGlobal('useRoute', () => ({ fullPath: '/gallery/summer' }))
    vi.stubGlobal('useMarketingConsent', () => ({ canTrackMarketing }))
    const { useFacebookPixel } = await import('../composables/useFacebookPixel')
    const pixel = useFacebookPixel()
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => node)

    pixel.initFacebookPixel('123456789')
    pixel.trackPageView('/gallery/summer')
    pixel.trackStandardEvent('Contact', { location: 'contact_panel' })
    pixel.trackLoginCompleted()
    const fbq = (window as unknown as { fbq?: { queue: unknown[] } }).fbq
    const callCountBeforeDenied = fbq?.queue.length

    canTrackMarketing.value = false
    pixel.trackPageView('/gallery/autumn')
    pixel.trackStandardEvent('Lead', { source: 'welcome' })
    pixel.trackLoginCompleted()

    expect(fbq?.queue).toHaveLength(callCountBeforeDenied ?? 0)
  })
})
