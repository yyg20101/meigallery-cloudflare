import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useAdAttribution } from './useAdAttribution'

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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useAdAttribution', () => {
  it.each([
    ['Meta', '/meta-source', { fbclid: 'meta-click' }, 'meta'],
    ['TikTok', '/tiktok-source', { ttclid: 'tiktok-click' }, 'tiktok'],
    ['Google', '/google-source', { gclid: 'google-click' }, 'google'],
  ] as const)('%s 来源只采用服务端验证结果', async (_label, path, query, provider) => {
    api.mockResolvedValueOnce({ provider, resolution: 'matched', expiresInSeconds: 2_592_000 })
    const attribution = useAdAttribution()

    await expect(attribution.resolve({ path, query })).resolves.toBe(provider)
    expect(api).toHaveBeenCalledWith('/api/ad-attribution', {
      method: 'PUT',
      body: expect.objectContaining(query),
    })
    expect(attribution.provider.value).toBe(provider)
    expect(attribution.resolution.value).toBe('matched')
  })

  it('只提交三平台来源信号，不在客户端状态保留 click id', async () => {
    api.mockResolvedValueOnce({ provider: 'google', resolution: 'matched', expiresInSeconds: 2_592_000 })
    const attribution = useAdAttribution()

    await attribution.resolve({
      path: '/google-source',
      query: { gclid: 'sensitive-google-click', gbraid: 'sensitive-gbraid', wbraid: 'sensitive-wbraid', mg_token: 'signed-link' },
    })

    expect(api).toHaveBeenCalledWith('/api/ad-attribution', {
      method: 'PUT',
      body: expect.objectContaining({
        gclid: 'sensitive-google-click',
        gbraid: 'sensitive-gbraid',
        wbraid: 'sensitive-wbraid',
        managedLinkToken: 'signed-link',
      }),
    })
    expect(JSON.stringify({ provider: attribution.provider.value, resolution: attribution.resolution.value }))
      .not.toContain('sensitive-google-click')
  })

  it('冲突结果不选择平台，重复解析也不保留来源信号', async () => {
    api
      .mockResolvedValueOnce({ provider: null, resolution: 'conflict', expiresInSeconds: null })
      .mockResolvedValueOnce({ provider: null, resolution: 'conflict', expiresInSeconds: null })
    const attribution = useAdAttribution()
    const route = {
      path: '/conflict-source',
      query: { fbclid: 'meta-click', ttclid: 'tiktok-click' },
    }

    await expect(attribution.resolve(route)).resolves.toBeNull()
    await expect(attribution.resolve(route)).resolves.toBeNull()

    expect(api).toHaveBeenCalledTimes(2)
    expect(attribution.resolution.value).toBe('conflict')
  })

  it('来源验证失败时本地降级并请求服务端清除旧 receipt', async () => {
    api.mockRejectedValueOnce(new Error('network'))
    api.mockResolvedValueOnce({ provider: null, resolution: 'none', expiresInSeconds: null })
    api.mockResolvedValueOnce({ provider: 'meta', resolution: 'matched', expiresInSeconds: 1_800 })
    const attribution = useAdAttribution()
    const route = {
      path: '/failed-source',
      query: { fbclid: 'meta-click' },
    }

    await expect(attribution.resolve(route)).resolves.toBeNull()

    expect(attribution.resolution.value).toBe('none')
    expect(api).toHaveBeenNthCalledWith(2, '/api/ad-attribution', { method: 'DELETE' })
    await expect(attribution.resolve(route)).resolves.toBe('meta')
    expect(api).toHaveBeenCalledTimes(3)
  })

  it('客户端缓存不超过服务端返回的 receipt 剩余寿命', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'))
    api
      .mockResolvedValueOnce({ provider: 'meta', resolution: 'matched', expiresInSeconds: 1_800 })
      .mockResolvedValueOnce({ provider: 'meta', resolution: 'inherited', expiresInSeconds: 60 })
      .mockResolvedValueOnce({ provider: null, resolution: 'none', expiresInSeconds: null })
    const attribution = useAdAttribution()
    const route = { path: '/expiring-source', query: { fbclid: 'meta-click' } }

    await attribution.resolve(route)
    vi.advanceTimersByTime(29 * 60 * 1_000 + 1)
    await attribution.resolve(route)
    vi.advanceTimersByTime(59 * 1_000)
    await attribution.resolve(route)

    expect(api).toHaveBeenCalledTimes(3)
    expect(attribution.provider.value).toBeNull()
  })

  it('provider 与 resolution 不一致时失败关闭并清除服务端 receipt', async () => {
    api
      .mockResolvedValueOnce({ provider: 'tiktok', resolution: 'conflict', expiresInSeconds: 1_800 })
      .mockResolvedValueOnce({ provider: null, resolution: 'none', expiresInSeconds: null })
    const attribution = useAdAttribution()

    await expect(attribution.resolve({ path: '/invalid-response', query: { ttclid: 'click' } })).resolves.toBeNull()

    expect(attribution.provider.value).toBeNull()
    expect(attribution.resolution.value).toBe('none')
    expect(api).toHaveBeenNthCalledWith(2, '/api/ad-attribution', { method: 'DELETE' })
  })

  it('快速切换平台时串行校验，迟到的旧来源不能覆盖最新来源', async () => {
    let releaseMeta!: (value: { provider: 'meta'; resolution: 'matched'; expiresInSeconds: 1800 }) => void
    const metaResponse = new Promise<{ provider: 'meta'; resolution: 'matched'; expiresInSeconds: 1800 }>(resolve => {
      releaseMeta = resolve
    })
    api.mockImplementation((_path, options?: { body?: Record<string, string> }) => {
      if (options?.body?.fbclid) return metaResponse
      return Promise.resolve({ provider: 'tiktok', resolution: 'matched', expiresInSeconds: 1_800 })
    })
    const attribution = useAdAttribution()

    const meta = attribution.resolve({ path: '/fast-meta', query: { fbclid: 'meta-click' } })
    const tiktok = attribution.resolve({ path: '/fast-tiktok', query: { ttclid: 'tiktok-click' } })
    await Promise.resolve()

    expect(api).toHaveBeenCalledTimes(1)
    releaseMeta({ provider: 'meta', resolution: 'matched', expiresInSeconds: 1_800 })
    await expect(meta).resolves.toBeNull()
    await expect(tiktok).resolves.toBe('tiktok')
    expect(api).toHaveBeenCalledTimes(2)
    expect(attribution.provider.value).toBe('tiktok')
  })

  it('clear 排在进行中的来源校验之后，旧响应不能恢复已清除来源', async () => {
    let releaseMeta!: (value: { provider: 'meta'; resolution: 'matched'; expiresInSeconds: 1800 }) => void
    const metaResponse = new Promise<{ provider: 'meta'; resolution: 'matched'; expiresInSeconds: 1800 }>(resolve => {
      releaseMeta = resolve
    })
    api.mockImplementation((_path, options?: { method?: string }) => (
      options?.method === 'DELETE'
        ? Promise.resolve({ provider: null, resolution: 'none', expiresInSeconds: null })
        : metaResponse
    ))
    const attribution = useAdAttribution()
    const resolving = attribution.resolve({ path: '/pending-meta', query: { fbclid: 'meta-click' } })
    await Promise.resolve()

    const clearing = attribution.clear()
    expect(attribution.provider.value).toBeNull()
    releaseMeta({ provider: 'meta', resolution: 'matched', expiresInSeconds: 1_800 })

    await expect(resolving).resolves.toBeNull()
    await clearing
    expect(api.mock.calls.map(call => call[1]?.method)).toEqual(['PUT', 'DELETE'])
    expect(attribution.provider.value).toBeNull()
    expect(attribution.resolution.value).toBe('none')
  })

  it('超长 click id 不截断成服务端可接受长度', async () => {
    api.mockResolvedValueOnce({ provider: null, resolution: 'none', expiresInSeconds: null })
    const attribution = useAdAttribution()

    await attribution.resolve({
      path: '/oversized-source',
      query: { ttclid: 'x'.repeat(1_500) },
    })

    const requestBody = api.mock.calls[0]?.[1]?.body as { ttclid: string }
    expect(requestBody.ttclid).toHaveLength(1_001)
  })

  it('clear 同时清除本地状态和服务端 receipt', async () => {
    api.mockResolvedValueOnce({ provider: 'meta', resolution: 'matched', expiresInSeconds: 1_800 })
    api.mockResolvedValueOnce({ provider: null, resolution: 'none', expiresInSeconds: null })
    const attribution = useAdAttribution()
    await attribution.resolve({ path: '/clear-source', query: { fbclid: 'meta-click' } })

    await attribution.clear()

    expect(attribution.provider.value).toBeNull()
    expect(attribution.resolution.value).toBe('none')
    expect(api).toHaveBeenLastCalledWith('/api/ad-attribution', { method: 'DELETE' })
  })
})
