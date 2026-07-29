import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('广告来源 SSR 预解析插件', () => {
  const resolve = vi.fn()
  let route: { path: string; fullPath: string; query: Record<string, unknown> } = {
    path: '/',
    fullPath: '/?fbclid=meta-click',
    query: { fbclid: 'meta-click' },
  }

  beforeEach(() => {
    vi.resetModules()
    resolve.mockReset().mockResolvedValue('meta')
    route = {
      path: '/',
      fullPath: '/?fbclid=meta-click',
      query: { fbclid: 'meta-click' },
    }
    vi.stubGlobal('defineNuxtPlugin', <T>(plugin: T) => plugin)
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useAdAttribution', () => ({ resolve }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('公开首屏在服务端完成来源和 Browser 配置预解析', async () => {
    const plugin = (await import('./ad-attribution.server')).default

    await plugin({} as never)

    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith(route)
  })

  it('后台和含敏感参数的页面不解析广告来源', async () => {
    const plugin = (await import('./ad-attribution.server')).default
    route = {
      path: '/admin/analytics',
      fullPath: '/admin/analytics?token=secret',
      query: { token: 'secret' },
    }

    await plugin({} as never)

    expect(resolve).not.toHaveBeenCalled()
  })
})
