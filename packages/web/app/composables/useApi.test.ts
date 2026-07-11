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
  it('所有浏览器请求统一通过当前 Web /api 代理', async () => {
    const { api } = useApi()

    await api('/api/marketing-consent', { method: 'PUT', body: { state: 'granted' } })
    await api('/api/settings/public')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/marketing-consent', expect.objectContaining({
      method: 'PUT',
      credentials: 'include',
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings/public', expect.objectContaining({
      credentials: 'include',
    }))
  })

  it('真实 dev Wrangler 配置中的 receipt 请求不会直连 API workers.dev', async () => {
    const wrangler = readFileSync('wrangler.toml', 'utf8')
    const configuredApi = wrangler.match(/NUXT_PUBLIC_API_BASE_URL\s*=\s*"(https:\/\/meigallery-api-dev[^"]+)"/)?.[1]
    expect(configuredApi).toBe('https://meigallery-api-dev.wajie.workers.dev')

    await useApi().api('/api/conversions/events', { method: 'POST', body: {} })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/conversions/events')
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(configuredApi)
  })
})
