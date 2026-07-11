import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApi } from './useApi'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true })
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('useRuntimeConfig', () => ({
    public: {
      apiBaseUrl: 'https://meigallery-api-dev.wajie.workers.dev',
      appEnv: 'dev',
    },
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('useApi 浏览器请求目标', () => {
  it('显式 sameOrigin 通过当前 Web /api 代理且默认请求仍保持 API Worker 直连', async () => {
    const { api } = useApi()

    await api('/api/marketing-consent', { method: 'PUT', body: { state: 'granted' }, sameOrigin: true })
    await api('/api/settings/public')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/marketing-consent', expect.objectContaining({
      method: 'PUT',
      credentials: 'include',
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://meigallery-api-dev.wajie.workers.dev/api/settings/public', expect.anything())
  })

  it('真实 dev Wrangler 配置中的 receipt 请求不会直连 API workers.dev', async () => {
    const wrangler = readFileSync('wrangler.toml', 'utf8')
    const configuredApi = wrangler.match(/NUXT_PUBLIC_API_BASE_URL\s*=\s*"(https:\/\/meigallery-api-dev[^"]+)"/)?.[1]
    expect(configuredApi).toBe('https://meigallery-api-dev.wajie.workers.dev')

    await useApi().api('/api/conversions/events', { method: 'POST', body: {}, sameOrigin: true })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/conversions/events')
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(configuredApi)
  })
})
