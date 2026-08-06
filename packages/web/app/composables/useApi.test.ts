import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchViaApiServiceBinding, useApi } from './useApi'

const h3Mocks = vi.hoisted(() => ({ appendResponseHeader: vi.fn() }))
vi.mock('h3', () => h3Mocks)

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  h3Mocks.appendResponseHeader.mockReset()
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

    await api('/api/conversions/events', { method: 'POST', body: {} })
    await api('/api/settings/public')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/conversions/events', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings/public', expect.objectContaining({
      credentials: 'include',
    }))
  })

  it('真实 dev Wrangler 配置中的转化请求不会直连 API workers.dev', async () => {
    const wrangler = readFileSync('wrangler.toml', 'utf8')
    const configuredApi = wrangler.match(/NUXT_PUBLIC_API_BASE_URL\s*=\s*"(https:\/\/meigallery-api-dev[^"]+)"/)?.[1]
    expect(configuredApi).toBe('https://meigallery-api-dev.wajie.workers.dev')

    await useApi().api('/api/conversions/events', { method: 'POST', body: {} })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/conversions/events')
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(configuredApi)
  })

  it('JSON 请求保留调用方提供的幂等头', async () => {
    await useApi().api('/api/conversions/events', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'membership:test:0001' },
      body: { event: 'test' },
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/conversions/events', expect.objectContaining({
      headers: {
        'Idempotency-Key': 'membership:test:0001',
        'Content-Type': 'application/json',
      },
    }))
  })
})

describe('useApi SSR Service Binding', () => {
  it('转发多个 Set-Cookie 并解析成功响应', async () => {
    const headers = new Headers()
    Object.defineProperty(headers, 'getSetCookie', {
      value: () => [
        'mei_session=renewed; Path=/; HttpOnly',
        'mei_ad_attribution=context; Path=/; HttpOnly',
      ],
    })
    const binding = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers,
        json: async () => ({ id: 'usr_1' }),
      } as Response),
    }
    const event = { context: {} } as ReturnType<typeof useRequestEvent>

    const result = await fetchViaApiServiceBinding<{ id: string }>(
      event,
      binding,
      '/api/me',
      { method: 'GET', headers: { cookie: 'mei_session=old' } },
    )

    expect(result).toEqual({ id: 'usr_1' })
    expect(binding.fetch).toHaveBeenCalledWith('https://api.internal/api/me', expect.objectContaining({
      method: 'GET',
      headers: { cookie: 'mei_session=old' },
    }))
    expect(h3Mocks.appendResponseHeader.mock.calls).toEqual([
      [event, 'set-cookie', 'mei_session=renewed; Path=/; HttpOnly'],
      [event, 'set-cookie', 'mei_ad_attribution=context; Path=/; HttpOnly'],
    ])
  })

  it('非 2xx 仍先转发续期 Cookie，并保留状态与响应体', async () => {
    const headers = new Headers()
    Object.defineProperty(headers, 'getSetCookie', {
      value: () => ['mei_session=renewed; Path=/; HttpOnly'],
    })
    const binding = {
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers,
        text: async () => '{"error":"expired"}',
      } as Response),
    }
    const event = { context: {} } as ReturnType<typeof useRequestEvent>

    await expect(fetchViaApiServiceBinding(
      event,
      binding,
      '/api/me',
      { method: 'GET' },
    )).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: '{"error":"expired"}',
    })
    expect(h3Mocks.appendResponseHeader).toHaveBeenCalledWith(event, 'set-cookie', 'mei_session=renewed; Path=/; HttpOnly')
  })

  it('调用 Service Binding 前标准化 Unicode 路径', async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'gallery-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    }

    await fetchViaApiServiceBinding(
      { context: {} } as ReturnType<typeof useRequestEvent>,
      binding,
      '/api/galleries/%E4%B8%AD%E6%96%87%E5%9B%BE%E5%BA%93',
      { method: 'GET' },
    )

    expect(binding.fetch).toHaveBeenCalledWith(
      'https://api.internal/api/galleries/%E4%B8%AD%E6%96%87%E5%9B%BE%E5%BA%93',
      { method: 'GET' },
    )
  })
})
