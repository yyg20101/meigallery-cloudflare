import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { createMarketingConsentChoice, createMarketingConsentReceipt } from '../utils/marketing-consent-receipt'
import { adAttributionRoutes } from './ad-attribution'

const readConnectionSnapshot = vi.hoisted(() => vi.fn())
vi.mock('../services/ad-platform/connections', () => ({
  readAttributionConnectionSnapshot: readConnectionSnapshot,
}))

const SECRET = 'ad-attribution-route-secret'

function app() {
  const instance = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  instance.route('/api/ad-attribution', adAttributionRoutes)
  return instance
}

describe('公开广告来源 API', () => {
  beforeEach(() => {
    readConnectionSnapshot.mockReset()
    readConnectionSnapshot.mockResolvedValue({ state: 'connection_invalid', reason: 'not_found' })
  })

  it.each([
    ['meta', { fbclid: 'meta-click-id' }],
    ['tiktok', { ttclid: 'tiktok-click-id' }],
    ['google', { gclid: 'google-click-id' }],
  ] as const)('%s 来源签发 HttpOnly 加密 30 天上下文且不回显密文', async (provider, body) => {
    const response = await request(body)
    const data = await response.json<Record<string, unknown>>()
    const cookie = response.headers.get('set-cookie') || ''

    expect(response.status).toBe(200)
    expect(data).toEqual({ provider, resolution: 'matched', expiresInSeconds: 2_592_000 })
    expect(cookie).toMatch(/^mei_ad_attribution=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=2592000')
    expect(JSON.stringify(data)).not.toContain(cookiePair(response).split('=')[1])
  })

  it('短期授权过期时可由长期选择续签，并继续建立单一平台上下文', async () => {
    const choice = await createMarketingConsentChoice(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `mei_marketing_consent_choice=${choice.token}`,
      },
      body: JSON.stringify({ ttclid: 'renewed-tiktok-click' }),
    }, env())
    const cookies = response.headers.get('set-cookie') || ''

    expect(await response.json()).toEqual({ provider: 'tiktok', resolution: 'matched', expiresInSeconds: 2_592_000 })
    expect(cookies).toContain('mei_marketing_consent_receipt=')
    expect(cookies).toContain('Max-Age=1800')
    expect(cookies).toContain('mei_ad_attribution=')
    expect(cookies).toContain('Max-Age=2592000')
  })

  it('普通导航继承未过期上下文且不重复签发 Cookie', async () => {
    const initial = await request({ fbclid: 'same-meta-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: trustedCookie(consent, initial),
      },
      body: JSON.stringify({}),
    }, env())

    const data = await response.json<Record<string, unknown>>()
    expect(data).toMatchObject({ provider: 'meta', resolution: 'inherited' })
    expect(data.expiresInSeconds).toBeGreaterThan(2_591_990)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it.each([
    ['自然 Google 来源', { utmSource: 'google' }],
    ['超长 Click ID', { fbclid: 'x'.repeat(129) }],
    ['含控制字符的 Click ID', { ttclid: 'invalid\nclick' }],
    ['不存在的来源 code', { trackingSourceSlug: 'missing-source' }],
  ])('%s 不替换可信上下文也不清 Cookie', async (_label, body) => {
    const initial = await request({ fbclid: 'same-meta-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: trustedCookie(consent, initial) },
      body: JSON.stringify(body),
    }, env())

    expect(await response.json()).toMatchObject({ provider: 'meta', resolution: 'inherited' })
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('新的明确点击替换旧上下文', async () => {
    const initial = await request({ fbclid: 'old-meta-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: trustedCookie(consent, initial),
      },
      body: JSON.stringify({ gclid: 'new-google-click' }),
    }, env())

    expect(await response.json()).toEqual({ provider: 'google', resolution: 'matched', expiresInSeconds: 2_592_000 })
    expect(cookiePair(response)).not.toBe(cookiePair(initial))
  })

  it('多平台强信号冲突时清除旧来源且不选择任何平台', async () => {
    const initial = await request({ fbclid: 'old-meta-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: trustedCookie(consent, initial),
      },
      body: JSON.stringify({ fbclid: 'meta-click', ttclid: 'tiktok-click' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'conflict', expiresInSeconds: null })
    expectClearsAttributionCookie(response)
  })

  it('没有可信营销授权时不签发广告来源', async () => {
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fbclid: 'meta-click' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'none', expiresInSeconds: null })
    expectClearsAttributionCookie(response)
  })

  it('营销授权解析异常时 bootstrap 与来源写入都失败关闭', async () => {
    const throwingEnv = env() as Bindings
    Object.defineProperty(throwingEnv, 'SESSION_SECRET', {
      get() { throw new Error('secret unavailable') },
    })
    const bootstrap = await app().request('https://api.616618.xyz/api/ad-attribution/bootstrap', {}, throwingEnv)
    const update = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fbclid: 'meta-click' }),
    }, throwingEnv)

    expect(bootstrap.status).toBe(200)
    expect(await bootstrap.json()).toEqual({ provider: null, publicConfig: null })
    expect(update.status).toBe(503)
    expect(await update.json()).toEqual({ provider: null, resolution: 'none', expiresInSeconds: null })
    expectClearsAttributionCookie(update)
  })

  it('客户端直接声明 provider 不会被接受', async () => {
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `mei_marketing_consent_receipt=${consent}` },
      body: JSON.stringify({ provider: 'tiktok' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'none', expiresInSeconds: null })
    expectClearsAttributionCookie(response)
  })

  it('非法 JSON 清除归因 Cookie，未签名来源继承当前上下文', async () => {
    const initial = await request({ ttclid: 'old-tiktok-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const cookie = trustedCookie(consent, initial)
    const invalid = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: '{',
    }, env())
    const unavailable = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ utmSource: 'managed-source' }),
    }, env(true))

    expect(invalid.status).toBe(400)
    expectClearsAttributionCookie(invalid)
    expect(unavailable.status).toBe(200)
    expect(await unavailable.json()).toMatchObject({ provider: 'tiktok', resolution: 'inherited' })
    expect(unavailable.headers.get('set-cookie')).toBeNull()
  })

  it('显式清理删除归因上下文 Cookie', async () => {
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'DELETE',
    }, env())

    expectClearsAttributionCookie(response)
  })

  it.each([
    ['meta', { fbclid: 'meta-click-id' }, { provider: 'meta', pixelId: '123456789' }],
    ['tiktok', { ttclid: 'tiktok-click-id' }, { provider: 'tiktok', pixelCode: 'C123456789ABCDEF' }],
    ['google', { gclid: 'google-click-id' }, { provider: 'google', tagId: 'AW-123456789' }],
  ] as const)('bootstrap 只返回当前 %s 来源的 discriminated public config', async (provider, source, publicConfig) => {
    const initial = await request(source)
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    readConnectionSnapshot.mockResolvedValueOnce(readySnapshot(provider, publicConfig))

    const response = await app().request('https://api.616618.xyz/api/ad-attribution/bootstrap', {
      headers: { cookie: trustedCookie(consent, initial) },
    }, env())
    const data = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(data).toEqual({ provider, publicConfig })
    expect(readConnectionSnapshot).toHaveBeenCalledWith(expect.anything(), provider)
    expect(JSON.stringify(data)).not.toMatch(/click|token|credential|binding|receipt|context/i)
  })

  it.each([
    ['未授权', false, readySnapshot('meta', { provider: 'meta', pixelId: '123456789' })],
    ['连接不存在', true, { state: 'connection_invalid', reason: 'not_found' }],
    ['连接未启用', true, readySnapshot('meta', { provider: 'meta', pixelId: '123456789' }, { enabled: false })],
    ['浏览器未启用', true, readySnapshot('meta', { provider: 'meta', pixelId: '123456789' }, { browserEnabled: false })],
    ['连接 disabled', true, readySnapshot('meta', { provider: 'meta', pixelId: '123456789' }, { mode: 'disabled' })],
  ])('bootstrap 在%s时返回严格空响应', async (_label, withConsent, snapshot) => {
    const initial = await request({ fbclid: 'meta-click-id' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    readConnectionSnapshot.mockResolvedValueOnce(snapshot)

    const response = await app().request('https://api.616618.xyz/api/ad-attribution/bootstrap', {
      headers: withConsent ? { cookie: trustedCookie(consent, initial) } : undefined,
    }, env())

    expect(await response.json()).toEqual({ provider: null, publicConfig: null })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('bootstrap 即使上游快照异常也不透传额外字段', async () => {
    const initial = await request({ fbclid: 'meta-click-id' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    readConnectionSnapshot.mockResolvedValueOnce(readySnapshot('meta', {
      provider: 'meta',
      pixelId: '123456789',
      token: 'must-not-leak',
    }))

    const response = await app().request('https://api.616618.xyz/api/ad-attribution/bootstrap', {
      headers: { cookie: trustedCookie(consent, initial) },
    }, env())

    expect(await response.json()).toEqual({
      provider: 'meta',
      publicConfig: { provider: 'meta', pixelId: '123456789' },
    })
  })

  it('Google bootstrap 只投影浏览器必需的 Tag ID', async () => {
    const initial = await request({ gclid: 'google-click-id' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    readConnectionSnapshot.mockResolvedValueOnce(readySnapshot('google', {
      provider: 'google',
      tagId: 'AW-123456789',
      customerId: '123-456-7890',
      loginCustomerId: '999-888-7777',
      cloudProjectId: 'private-project-name',
    }))

    const response = await app().request('https://api.616618.xyz/api/ad-attribution/bootstrap', {
      headers: { cookie: trustedCookie(consent, initial) },
    }, env())

    expect(await response.json()).toEqual({
      provider: 'google',
      publicConfig: { provider: 'google', tagId: 'AW-123456789' },
    })
  })
})

async function request(body: Record<string, string>) {
  const consent = await createMarketingConsentReceipt(SECRET, 'granted')
  return app().request('https://api.616618.xyz/api/ad-attribution', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: `mei_marketing_consent_receipt=${consent}` },
    body: JSON.stringify(body),
  }, env())
}

function env(fail = false) {
  return {
    APP_ENV: 'production',
    SESSION_SECRET: SECRET,
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
    DB: {
      prepare() {
        if (fail) throw new Error('D1 unavailable')
        return { bind: () => ({ all: async () => ({ results: [] }) }) }
      },
    },
  } as unknown as Bindings
}

function cookiePair(response: Response) {
  return (response.headers.get('set-cookie') || '').split(';')[0] || ''
}

function trustedCookie(consent: string, response: Response) {
  return `mei_marketing_consent_receipt=${consent}; ${cookiePair(response)}`
}

function expectClearsAttributionCookie(response: Response) {
  const cookie = response.headers.get('set-cookie') || ''
  expect(cookie).toContain('mei_ad_attribution=')
  expect(cookie).toContain('Max-Age=0')
}

function readySnapshot(
  provider: 'meta' | 'tiktok' | 'google',
  publicConfig: Record<string, string>,
  override: { enabled?: boolean; browserEnabled?: boolean; mode?: 'disabled' | 'test' | 'production' } = {},
) {
  const { provider: _provider, ...storedConfig } = publicConfig
  return {
    state: 'ready',
    connection: {
      id: `connection_${provider}`,
      provider,
      enabled: override.enabled ?? true,
      mode: override.mode ?? 'production',
      browserEnabled: override.browserEnabled ?? true,
      serverEnabled: true,
      publicConfig: storedConfig,
      connectionRevision: 'revision_1',
      credentialRevision: 'credential_1',
      rolloutTargetPercentage: 100,
      rolloutEffectivePercentage: 100,
    },
    bindings: new Map(),
    credential: { type: provider === 'google' ? 'service_account_json' : 'access_token', schemaVersion: 1, credentialRevision: 'credential_1' },
  }
}
