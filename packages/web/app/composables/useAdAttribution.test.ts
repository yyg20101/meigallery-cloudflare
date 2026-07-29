import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type {
  AdAttributionProvider,
  AdAttributionResolution,
  AdBrowserPublicConfig,
} from '@meigallery/shared'
import { requiresFullReload, useAdAttribution } from './useAdAttribution'

const stateStore = new Map<string, ReturnType<typeof ref>>()
const api = vi.fn()

beforeEach(() => {
  stateStore.clear()
  api.mockReset()
  vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
    if (!stateStore.has(key)) stateStore.set(key, ref(init()))
    return stateStore.get(key)
  })
  vi.stubGlobal('useApi', () => ({ api }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAdAttribution', () => {
  it('来源平台发生任何变化时要求整页刷新', () => {
    expect(requiresFullReload('meta', 'tiktok')).toBe(true)
    expect(requiresFullReload('tiktok', 'google')).toBe(true)
    expect(requiresFullReload('meta', null)).toBe(true)
    expect(requiresFullReload(null, 'meta')).toBe(true)
    expect(requiresFullReload('meta', 'meta')).toBe(false)
    expect(requiresFullReload(null, null)).toBe(false)
  })

  it.each([
    ['meta', { provider: 'meta', pixelId: '123456789' }],
    ['tiktok', { provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }],
    ['google', { provider: 'google', tagId: 'AW-123456789' }],
  ] as const)('%s 来源通过一次请求取得可信来源、公开配置和事件模板', async (provider, publicConfig) => {
    const response = resolvedResponse(provider, 'matched', publicConfig)
    api.mockResolvedValueOnce(response)
    const attribution = useAdAttribution()
    const route = { path: `/${provider}-source`, query: clickQuery(provider) }

    await expect(attribution.resolve(route)).resolves.toBe(provider)

    expect(api).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledWith('/api/ad-attribution', {
      method: 'PUT',
      body: expect.objectContaining(clickQuery(provider)),
    })
    expect(attribution.provider.value).toBe(provider)
    expect(attribution.publicConfig.value).toEqual(publicConfig)
    expect(attribution.getBrowserEventTemplate(route, 'Contact')).toEqual(response.events[0])
    expect(attribution).not.toHaveProperty('browserEvents')
    expect(attribution).not.toHaveProperty('bootstrap')
    expect(attribution).not.toHaveProperty('isResolvedFor')
  })

  it.each([
    ['顶层额外字段', {
      ...resolvedResponse('meta'),
      token: 'secret',
    }],
    ['公开配置包含敏感字段', {
      ...resolvedResponse('meta'),
      publicConfig: { provider: 'meta', pixelId: '123456789', token: 'secret' },
    }],
    ['provider 与配置不一致', {
      ...resolvedResponse('meta'),
      publicConfig: { provider: 'google', tagId: 'AW-123456789' },
    }],
    ['浏览器模板包含服务端目标', {
      ...resolvedResponse('meta'),
      events: [{ ...browserEvent('meta'), serverDestination: 'meta_capi' }],
    }],
  ])('严格拒绝%s的越界响应并清除服务端上下文', async (_label, response) => {
    api
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(emptyResponse())
    const attribution = useAdAttribution()

    await expect(attribution.resolve({ path: '/invalid', query: { fbclid: 'click' } })).resolves.toBeNull()

    expect(attribution.provider.value).toBeNull()
    expect(attribution.publicConfig.value).toBeNull()
    expect(api).toHaveBeenNthCalledWith(2, '/api/ad-attribution', { method: 'DELETE' })
  })

  it('Google 公开配置拒绝 customerId 等服务端字段', async () => {
    api
      .mockResolvedValueOnce({
        ...resolvedResponse('google'),
        publicConfig: {
          provider: 'google',
          tagId: 'AW-123456789',
          customerId: '1234567890',
        },
      })
      .mockResolvedValueOnce(emptyResponse())
    const attribution = useAdAttribution()

    await expect(attribution.resolve({ path: '/google', query: { gclid: 'click' } })).resolves.toBeNull()
    expect(attribution.publicConfig.value).toBeNull()
  })

  it('只提交官方来源信号和受管 mg_source，不在本地状态保留 click id', async () => {
    api.mockResolvedValueOnce(resolvedResponse('google'))
    const attribution = useAdAttribution()

    await attribution.resolve({
      path: '/google-source',
      query: {
        gclid: 'sensitive-google-click',
        gbraid: 'sensitive-gbraid',
        mg_source: 'ad-google-team',
        utm_source: 'ignored',
      },
    })

    expect(api).toHaveBeenCalledWith('/api/ad-attribution', {
      method: 'PUT',
      body: expect.objectContaining({
        gclid: 'sensitive-google-click',
        gbraid: 'sensitive-gbraid',
        trackingSourceSlug: 'ad-google-team',
      }),
    })
    expect(JSON.stringify({
      provider: attribution.provider.value,
      resolution: attribution.resolution.value,
      publicConfig: attribution.publicConfig.value,
    })).not.toContain('sensitive-google-click')
  })

  it('冲突和自然流量不选择平台，同一路由只解析一次', async () => {
    api.mockResolvedValueOnce(emptyResponse('conflict'))
    const attribution = useAdAttribution()
    const route = {
      path: '/conflict',
      query: { fbclid: 'meta-click', ttclid: 'tiktok-click' },
    }

    await expect(attribution.resolve(route)).resolves.toBeNull()
    await expect(attribution.resolve(route)).resolves.toBeNull()

    expect(api).toHaveBeenCalledOnce()
    expect(attribution.resolution.value).toBe('conflict')
    expect(attribution.publicConfig.value).toBeNull()
  })

  it('同一路由并发调用共用一次来源解析', async () => {
    let release!: (value: ReturnType<typeof resolvedResponse>) => void
    api.mockReturnValueOnce(new Promise(resolve => {
      release = resolve
    }))
    const attribution = useAdAttribution()
    const route = { path: '/meta-source', query: { fbclid: 'meta-click' } }

    const first = attribution.resolve(route)
    const second = attribution.resolve(route)
    await Promise.resolve()

    expect(api).toHaveBeenCalledOnce()
    release(resolvedResponse('meta'))
    await expect(first).resolves.toBe('meta')
    await expect(second).resolves.toBe('meta')
  })

  it('自然路由变化重新校验来源并在同一响应更新公开配置', async () => {
    api
      .mockResolvedValueOnce(resolvedResponse('meta'))
      .mockResolvedValueOnce(resolvedResponse('meta', 'inherited'))
    const attribution = useAdAttribution()

    await attribution.resolve({ path: '/landing', query: { fbclid: 'meta-click' } })
    await attribution.resolve({ path: '/gallery/demo', query: {} })

    expect(api.mock.calls.filter(call => call[0] === '/api/ad-attribution')).toHaveLength(2)
    expect(attribution.resolution.value).toBe('inherited')
    expect(attribution.publicConfig.value).toEqual({ provider: 'meta', pixelId: '123456789' })
  })

  it('来源验证失败时失败关闭并允许同一路由重新解析', async () => {
    api
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(resolvedResponse('meta'))
    const attribution = useAdAttribution()
    const route = { path: '/failed-source', query: { fbclid: 'meta-click' } }

    await expect(attribution.resolve(route)).resolves.toBeNull()
    await expect(attribution.resolve(route)).resolves.toBe('meta')

    expect(api).toHaveBeenNthCalledWith(2, '/api/ad-attribution', { method: 'DELETE' })
    expect(attribution.provider.value).toBe('meta')
  })

  it('快速切换来源时迟到结果不能覆盖最新来源', async () => {
    let releaseMeta!: (value: ReturnType<typeof resolvedResponse>) => void
    const metaResponse = new Promise(resolve => {
      releaseMeta = resolve
    })
    api.mockImplementation((_path, options?: { body?: Record<string, string> }) => (
      options?.body?.fbclid ? metaResponse : Promise.resolve(resolvedResponse('tiktok'))
    ))
    const attribution = useAdAttribution()

    const meta = attribution.resolve({ path: '/fast-meta', query: { fbclid: 'meta-click' } })
    const tiktok = attribution.resolve({ path: '/fast-tiktok', query: { ttclid: 'tiktok-click' } })
    releaseMeta(resolvedResponse('meta'))

    await expect(meta).resolves.toBeNull()
    await expect(tiktok).resolves.toBe('tiktok')
    expect(attribution.provider.value).toBe('tiktok')
  })

  it('clear 清除本地状态和服务端上下文', async () => {
    api
      .mockResolvedValueOnce(resolvedResponse('meta'))
      .mockResolvedValueOnce(emptyResponse())
    const attribution = useAdAttribution()
    await attribution.resolve({ path: '/clear-source', query: { fbclid: 'meta-click' } })

    await attribution.clear()

    expect(attribution.provider.value).toBeNull()
    expect(attribution.resolution.value).toBe('none')
    expect(attribution.publicConfig.value).toBeNull()
    expect(api).toHaveBeenLastCalledWith('/api/ad-attribution', { method: 'DELETE' })
  })
})

function resolvedResponse(
  provider: AdAttributionProvider,
  resolution: AdAttributionResolution = 'matched',
  publicConfig: AdBrowserPublicConfig = defaultConfig(provider),
) {
  return {
    provider,
    resolution,
    expiresInSeconds: resolution === 'inherited' ? 1_800 : 2_592_000,
    publicConfig,
    events: [browserEvent(provider)],
  }
}

function emptyResponse(resolution: 'none' | 'conflict' = 'none') {
  return {
    provider: null,
    resolution,
    expiresInSeconds: null,
    publicConfig: null,
    events: [],
  }
}

function defaultConfig(provider: AdAttributionProvider): AdBrowserPublicConfig {
  if (provider === 'meta') return { provider, pixelId: '123456789' }
  if (provider === 'tiktok') return { provider, pixelCode: 'C123456789ABCDEF' }
  return { provider, tagId: 'AW-123456789' }
}

function browserEvent(provider: AdAttributionProvider) {
  return {
    provider,
    canonicalEvent: 'Contact' as const,
    browserEventName: provider === 'google' ? 'conversion' : 'Contact',
    browserDestination: provider === 'google'
      ? 'AW-123456789/Contact_Label'
      : provider === 'meta' ? 'meta_pixel' : 'tiktok_pixel',
  }
}

function clickQuery(provider: AdAttributionProvider) {
  if (provider === 'meta') return { fbclid: 'click' }
  if (provider === 'tiktok') return { ttclid: 'click' }
  return { gclid: 'click' }
}
