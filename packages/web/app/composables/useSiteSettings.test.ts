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
  it('首次加载失败时保留默认值并标记已加载', async () => {
    resetState()
    apiMock.mockRejectedValueOnce(new Error('network'))

    const siteSettings = useSiteSettings()
    const settings = await siteSettings.fetchSettings()

    expect(settings).toEqual({})
    expect(siteSettings.siteName.value).toBe('MeiGallery')
    expect(apiMock).toHaveBeenCalledTimes(1)
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
})
