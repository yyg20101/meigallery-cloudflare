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
    expect(siteSettings.siteName.value).toBe('MeiGallery')
    expect(apiMock).toHaveBeenCalledTimes(1)

    const secondSettings = await siteSettings.fetchSettings()

    expect(secondSettings).toEqual({ site_name: '测试站', seo_title: '测试 SEO' })
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(siteSettings.siteName.value).toBe('测试站')
    expect(siteSettings.seoTitle.value).toBe('测试 SEO')
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
})
