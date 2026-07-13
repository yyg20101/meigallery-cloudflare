import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useSiteSettings } from './useSiteSettings'

const stateStore = new Map<string, ReturnType<typeof ref>>()
const apiMock = vi.fn()

vi.stubGlobal('useApi', () => ({ api: apiMock }))
vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
  if (!stateStore.has(key)) stateStore.set(key, ref(init()))
  return stateStore.get(key)
})

function resetState() {
  stateStore.clear()
  apiMock.mockReset()
}

describe('useSiteSettings', () => {
  it('首次加载失败时保留默认值并允许下次普通请求重试', async () => {
    resetState()
    apiMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ site_name: '测试站', seo_title: '测试 SEO' })

    const siteSettings = useSiteSettings()
    const firstSettings = await siteSettings.fetchSettings()

    expect(firstSettings).toEqual({})
    expect(siteSettings.siteName.value).toBe('图库站')
    expect(apiMock).toHaveBeenCalledTimes(1)

    const secondSettings = await siteSettings.fetchSettings()

    expect(secondSettings).toEqual({ site_name: '测试站', seo_title: '测试 SEO' })
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(siteSettings.siteName.value).toBe('测试站')
    expect(siteSettings.seoTitle.value).toBe('测试 SEO')
  })

  it('旧脚手架站名会回退为中性站点名称', async () => {
    resetState()
    apiMock.mockResolvedValueOnce({ site_name: 'MeiGallery', seo_title: '' })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.siteName.value).toBe('图库站')
    expect(siteSettings.seoTitle.value).toBe('图库站')
  })

  it('公开 SEO 关键词会归一化为数组，供 meta 与结构化数据复用', async () => {
    resetState()
    apiMock.mockResolvedValueOnce({
      seo_keywords: ' 授权图库, 写真\n#时尚写真，授权图库 ',
    })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.seoKeywords.value).toEqual(['授权图库', '写真', '时尚写真'])
  })

  it('缺少浏览器平台连接时营销追踪模式为 disabled', async () => {
    resetState()
    apiMock.mockResolvedValueOnce({ ad_platform_browser_connections: [] })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.marketingTrackingMode.value).toBe('disabled')
  })

  it('仅配置 TikTok 时仍由统一浏览器连接启用营销追踪模式', async () => {
    resetState()
    apiMock.mockResolvedValueOnce({
      ad_platform_browser_connections: [{
        provider: 'tiktok',
        destinationId: 'C123456789ABCDEF',
        mode: 'test',
      }],
    })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.metaBrowserConnection.value).toBeNull()
    expect(siteSettings.tiktokBrowserConnection.value?.destinationId).toBe('C123456789ABCDEF')
    expect(siteSettings.marketingTrackingMode.value).toBe('test')
  })

  it('已加载后默认复用缓存，强制刷新会重新请求并更新 SEO', async () => {
    resetState()
    apiMock
      .mockResolvedValueOnce({ site_name: '旧站名', seo_title: '旧标题' })
      .mockResolvedValueOnce({ site_name: '新站名', seo_title: '新标题' })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()
    await siteSettings.fetchSettings()

    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(siteSettings.seoTitle.value).toBe('旧标题')

    await siteSettings.fetchSettings({ force: true })

    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(siteSettings.siteName.value).toBe('新站名')
    expect(siteSettings.seoTitle.value).toBe('新标题')
  })

  it('强制刷新失败时抛出错误，便于后台提示当前会话可能仍是旧设置', async () => {
    resetState()
    apiMock
      .mockResolvedValueOnce({ site_name: '旧站名', seo_title: '旧标题' })
      .mockRejectedValueOnce(new Error('network'))

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    await expect(siteSettings.fetchSettings({ force: true })).rejects.toThrow('公开站点设置刷新失败')
    expect(siteSettings.seoTitle.value).toBe('旧标题')
  })

  it('图片类公开设置只暴露站点公开媒体路径和安全 https 链接', async () => {
    resetState()
    apiMock
      .mockResolvedValueOnce({
        site_icon: '/discover?sort=hot',
        og_image: '/api/media/public/avatars/user.png',
      })
      .mockResolvedValueOnce({
        site_icon: '/api/media/public/site/icon.png',
        og_image: 'HTTPS://example.com/og.jpg?next="x"',
      })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.siteIcon.value).toBe('')
    expect(siteSettings.ogImage.value).toBe('')

    await siteSettings.fetchSettings({ force: true })

    expect(siteSettings.siteIcon.value).toBe('/api/media/public/site/icon.png')
    expect(siteSettings.ogImage.value).toBe('https://example.com/og.jpg?next=%22x%22')
  })

  it('优先使用公开 API 派生的首页广告展示状态，并保留旧响应兜底计算', async () => {
    resetState()
    apiMock
      .mockResolvedValueOnce({
        home_ad_enabled: true,
        home_ad_active: false,
        home_ad_starts_at: '2000-01-01T00:00:00.000Z',
        home_ad_ends_at: '2099-01-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        home_ad_enabled: true,
        home_ad_starts_at: '2000-01-01T00:00:00.000Z',
        home_ad_ends_at: '2099-01-01T00:00:00.000Z',
      })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.homeAdActive.value).toBe(false)

    await siteSettings.fetchSettings({ force: true })

    expect(siteSettings.homeAdActive.value).toBe(true)
  })

  it('优先使用公开 home_ads，多广告为空时才回退旧单广告配置', async () => {
    resetState()
    apiMock
      .mockResolvedValueOnce({
        home_ad_enabled: true,
        home_ad_active: true,
        home_ad_title: '旧单广告',
        home_ad_url: '/discover?sort=old',
        home_ads: [
          {
            id: 'ad-2',
            title: '第二条',
            targetUrl: '/cases',
            ctaLabel: '看案例',
            imageUrl: 'https://example.com/ad.webp',
            sortOrder: 2,
          },
          {
            id: 'ad-1',
            eyebrow: '本周推荐',
            title: '第一条',
            summary: '精选内容',
            targetUrl: '/discover?sort=hot',
            sponsor: '运营精选',
            imageUrl: '/api/media/public/home-ads/ad-1/cover.webp',
            sortOrder: 1,
          },
          {
            id: 'unsafe',
            title: '危险广告',
            targetUrl: 'javascript:alert(1)',
            sortOrder: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        home_ad_enabled: true,
        home_ad_active: true,
        home_ad_title: '旧单广告',
        home_ad_summary: '旧摘要',
        home_ad_cta_label: '查看旧广告',
        home_ad_url: '/discover?sort=old',
        home_ads: [],
      })

    const siteSettings = useSiteSettings()
    await siteSettings.fetchSettings()

    expect(siteSettings.homeAds.value.map(ad => ad.id)).toEqual(['ad-1', 'ad-2'])
    expect(siteSettings.homeAds.value[0]).toMatchObject({
      title: '第一条',
      url: '/discover?sort=hot',
      imageUrl: '/api/media/public/home-ads/ad-1/cover.webp',
    })
    expect(siteSettings.homeAds.value[1]).toMatchObject({
      title: '第二条',
      url: '/cases',
      imageUrl: 'https://example.com/ad.webp',
    })

    await siteSettings.fetchSettings({ force: true })

    expect(siteSettings.homeAds.value).toEqual([
      expect.objectContaining({
        id: 'legacy-home-ad',
        title: '旧单广告',
        summary: '旧摘要',
        ctaLabel: '查看旧广告',
        url: '/discover?sort=old',
      }),
    ])
  })
})
