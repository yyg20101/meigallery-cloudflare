import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { adAttributionRoutes } from './ad-attribution'

const readConnectionSnapshot = vi.hoisted(() => vi.fn())
vi.mock('../services/ad-platform/connections', () => ({
  readAttributionConnectionSnapshot: readConnectionSnapshot,
}))

const MASTER_KEY = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE='

function app() {
  const instance = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  instance.route('/api/ad-attribution', adAttributionRoutes)
  return instance
}

describe('公开广告来源 API', () => {
  beforeEach(() => {
    readConnectionSnapshot.mockReset()
    readConnectionSnapshot.mockResolvedValue({
      state: 'connection_invalid',
      reason: 'not_found',
    })
  })

  it.each([
    ['meta', { fbclid: 'meta-click-id' }],
    ['tiktok', { ttclid: 'tiktok-click-id' }],
    ['google', { gclid: 'google-click-id' }],
  ] as const)('%s 来源签发 HttpOnly 加密 30 天上下文且不回显来源值', async (provider, body) => {
    const response = await request(body)
    const data = await response.json<Record<string, unknown>>()
    const cookie = response.headers.get('set-cookie') || ''

    expect(response.status).toBe(200)
    expect(data).toEqual({
      provider,
      resolution: 'matched',
      expiresInSeconds: 2_592_000,
    })
    expect(cookie).toMatch(/^mei_ad_attribution=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=2592000')
    expect(JSON.stringify(data)).not.toContain(Object.values(body)[0])
  })

  it('普通 UTM 不选择平台，也不创建来源 Cookie', async () => {
    const response = await request({ utmSource: 'facebook' })

    expect(await response.json()).toEqual({
      provider: null,
      resolution: 'none',
      expiresInSeconds: null,
    })
    expectClearsAttributionCookie(response)
  })

  it('Meta 长点击标识仍签发来源上下文', async () => {
    const response = await request({ fbclid: 'x'.repeat(512) })

    expect(await response.json()).toEqual({
      provider: 'meta',
      resolution: 'matched',
      expiresInSeconds: 2_592_000,
    })
    expect(response.headers.get('set-cookie')).toMatch(/^mei_ad_attribution=/)
  })

  it('普通导航继承未过期上下文且不重复签发 Cookie', async () => {
    const initial = await request({ fbclid: 'same-meta-click' })
    const response = await requestWithContext({}, initial)

    const data = await response.json<Record<string, unknown>>()
    expect(data).toMatchObject({ provider: 'meta', resolution: 'inherited' })
    expect(data.expiresInSeconds).toBeGreaterThan(2_591_990)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('新的明确点击覆盖旧上下文', async () => {
    const initial = await request({ fbclid: 'old-meta-click' })
    const response = await requestWithContext({ gclid: 'new-google-click' }, initial)

    expect(await response.json()).toEqual({
      provider: 'google',
      resolution: 'matched',
      expiresInSeconds: 2_592_000,
    })
    expect(cookiePair(response)).not.toBe(cookiePair(initial))
  })

  it('多平台强信号冲突时清除旧来源且不选择任何平台', async () => {
    const initial = await request({ fbclid: 'old-meta-click' })
    const response = await requestWithContext({
      fbclid: 'meta-click',
      ttclid: 'tiktok-click',
    }, initial)

    expect(await response.json()).toEqual({
      provider: null,
      resolution: 'conflict',
      expiresInSeconds: null,
    })
    expectClearsAttributionCookie(response)
  })

  it('客户端直接声明 provider 不会被接受', async () => {
    const response = await request({ provider: 'tiktok' })

    expect(await response.json()).toEqual({
      provider: null,
      resolution: 'none',
      expiresInSeconds: null,
    })
    expectClearsAttributionCookie(response)
  })

  it('非法强信号与非法 JSON 都清除旧来源', async () => {
    const initial = await request({ ttclid: 'old-tiktok-click' })
    const invalidSignal = await requestWithContext({
      fbclid: 'x'.repeat(1_001),
    }, initial)
    const invalidJson = await app().request(
      'https://api.616618.xyz/api/ad-attribution',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: cookiePair(initial),
        },
        body: '{',
      },
      env(),
    )

    expect(await invalidSignal.json()).toMatchObject({
      provider: null,
      resolution: 'conflict',
    })
    expectClearsAttributionCookie(invalidSignal)
    expect(invalidJson.status).toBe(400)
    expectClearsAttributionCookie(invalidJson)
  })

  it('加密密钥不可用时失败关闭并清除来源', async () => {
    const broken = env()
    Object.defineProperty(broken, 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT', {
      get() {
        throw new Error('key unavailable')
      },
    })
    const update = await app().request(
      'https://api.616618.xyz/api/ad-attribution',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fbclid: 'meta-click' }),
      },
      broken,
    )

    expect(update.status).toBe(503)
    expect(await update.json()).toEqual({
      provider: null,
      resolution: 'none',
      expiresInSeconds: null,
    })
    expectClearsAttributionCookie(update)
  })

  it('显式清理删除归因 Cookie', async () => {
    const response = await app().request(
      'https://api.616618.xyz/api/ad-attribution',
      { method: 'DELETE' },
      env(),
    )

    expectClearsAttributionCookie(response)
  })

  it.each([
    ['meta', { fbclid: 'meta-click-id' }, { provider: 'meta', pixelId: '123456789' }],
    ['tiktok', { ttclid: 'tiktok-click-id' }, { provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }],
    ['google', { gclid: 'google-click-id' }, { provider: 'google', tagId: 'AW-123456789' }],
  ] as const)('bootstrap 只返回当前 %s 来源的浏览器公开配置', async (provider, source, publicConfig) => {
    const initial = await request(source)
    readConnectionSnapshot.mockResolvedValueOnce(readySnapshot(provider, publicConfig))

    const response = await app().request(
      'https://api.616618.xyz/api/ad-attribution/bootstrap',
      { headers: { cookie: cookiePair(initial) } },
      env(),
    )
    const data = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(data).toEqual({ provider, publicConfig })
    expect(readConnectionSnapshot).toHaveBeenCalledWith(expect.anything(), provider)
    expect(JSON.stringify(data)).not.toMatch(/click|token|credential|binding|context/i)
  })

  it.each([
    ['没有来源 Cookie', null, readySnapshot('meta', { provider: 'meta', pixelId: '123456789' })],
    ['连接不存在', 'context', { state: 'connection_invalid', reason: 'not_found' }],
    ['连接未启用', 'context', readySnapshot('meta', { provider: 'meta', pixelId: '123456789' }, { enabled: false })],
    ['浏览器未启用', 'context', readySnapshot('meta', { provider: 'meta', pixelId: '123456789' }, { browserEnabled: false })],
  ])('bootstrap 在%s时返回严格空响应', async (_label, contextMode, snapshot) => {
    const initial = contextMode ? await request({ fbclid: 'meta-click-id' }) : null
    readConnectionSnapshot.mockResolvedValueOnce(snapshot)

    const response = await app().request(
      'https://api.616618.xyz/api/ad-attribution/bootstrap',
      initial ? { headers: { cookie: cookiePair(initial) } } : {},
      env(),
    )

    expect(await response.json()).toEqual({ provider: null, publicConfig: null })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('Google bootstrap 不泄露服务端配置', async () => {
    const initial = await request({ gclid: 'google-click-id' })
    readConnectionSnapshot.mockResolvedValueOnce(readySnapshot('google', {
      provider: 'google',
      tagId: 'AW-123456789',
      customerId: '1234567890',
      loginCustomerId: '9998887777',
      cloudProjectId: 'private-project',
    }))

    const response = await app().request(
      'https://api.616618.xyz/api/ad-attribution/bootstrap',
      { headers: { cookie: cookiePair(initial) } },
      env(),
    )

    expect(await response.json()).toEqual({
      provider: 'google',
      publicConfig: { provider: 'google', tagId: 'AW-123456789' },
    })
  })
})

async function request(body: Record<string, string>) {
  return app().request(
    'https://api.616618.xyz/api/ad-attribution',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env(),
  )
}

async function requestWithContext(
  body: Record<string, string>,
  contextResponse: Response,
) {
  return app().request(
    'https://api.616618.xyz/api/ad-attribution',
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: cookiePair(contextResponse),
      },
      body: JSON.stringify(body),
    },
    env(),
  )
}

function env() {
  return {
    APP_ENV: 'production',
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
    DB: {
      prepare() {
        return {
          bind: () => ({ all: async () => ({ results: [] }) }),
        }
      },
    },
  } as unknown as Bindings
}

function cookiePair(response: Response) {
  return (response.headers.get('set-cookie') || '').split(';')[0] || ''
}

function expectClearsAttributionCookie(response: Response) {
  const cookie = response.headers.get('set-cookie') || ''
  expect(cookie).toContain('mei_ad_attribution=')
  expect(cookie).toContain('Max-Age=0')
}

function readySnapshot(
  provider: 'meta' | 'tiktok' | 'google',
  publicConfig: Record<string, string>,
  override: { enabled?: boolean; browserEnabled?: boolean } = {},
) {
  const { provider: _provider, ...storedConfig } = publicConfig
  return {
    state: 'ready',
    connection: {
      id: `connection_${provider}`,
      provider,
      enabled: override.enabled ?? true,
      browserEnabled: override.browserEnabled ?? true,
      serverEnabled: true,
      publicConfig: storedConfig,
      outboxScope: 'outbox_scope_1',
    },
    bindings: new Map(),
    credential: {
      type: provider === 'google' ? 'service_account_json' : 'access_token',
      schemaVersion: 1,
      encryptionContext: 'credential_context_1',
    },
  }
}
