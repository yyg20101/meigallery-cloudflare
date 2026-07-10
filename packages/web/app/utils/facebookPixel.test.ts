import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFacebookPixelScript, FACEBOOK_PIXEL_SCRIPT_SRC, hasSensitiveAnalyticsUrl, sanitizeAnalyticsText } from './facebookPixel'

describe('facebookPixel 安全工具', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
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
  })

  it('Pixel 脚本加载不发送来源页信息', () => {
    const script = createFacebookPixelScript()

    expect(script.async).toBe(true)
    expect(script.src).toBe(FACEBOOK_PIXEL_SCRIPT_SRC)
    expect(script.referrerPolicy).toBe('no-referrer')
  })
})

describe('useFacebookPixel 兼容包装', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只委托 Tracking Facade 且不再接受 Lead', async () => {
    const trackPageView = vi.fn()
    const trackViewContent = vi.fn()
    const trackSearch = vi.fn()
    vi.stubGlobal('useTracking', () => ({ trackPageView, trackViewContent, trackSearch }))
    const { useFacebookPixel } = await import('../composables/useFacebookPixel')
    const pixel = useFacebookPixel()

    pixel.trackPageView('/gallery/summer')
    pixel.trackViewContent({ id: 'gallery_1', title: '夏日', requiredRank: 10, tags: ['summer'] })
    pixel.trackSearch({ searchString: 'has_query=true', resultCount: 3 })

    expect(trackPageView).toHaveBeenCalledOnce()
    expect(trackViewContent).toHaveBeenCalledWith({
      content_id: 'gallery_1',
      content_name: '夏日',
      required_rank: 10,
      tag_count: 1,
    })
    expect(trackSearch).toHaveBeenCalledWith({ search_string: 'has_query=true', result_count: 3 })
    expect(pixel.trackStandardEvent('Lead' as never)).toBe(false)
  })
})
