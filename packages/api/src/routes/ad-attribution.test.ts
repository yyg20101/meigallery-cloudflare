import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { createMarketingConsentReceipt } from '../utils/marketing-consent-receipt'
import { adAttributionRoutes } from './ad-attribution'

const SECRET = 'ad-attribution-route-secret'

function app() {
  const instance = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  instance.route('/api/ad-attribution', adAttributionRoutes)
  return instance
}

describe('公开广告来源 API', () => {
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

  it('普通导航继承未过期上下文且不重复签发 Cookie', async () => {
    const initial = await request({ fbclid: 'same-meta-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `mei_marketing_consent_receipt=${consent}; ${cookiePair(initial)}`,
      },
      body: JSON.stringify({}),
    }, env())

    const data = await response.json<Record<string, unknown>>()
    expect(data).toMatchObject({ provider: 'meta', resolution: 'inherited' })
    expect(data.expiresInSeconds).toBeGreaterThan(2_591_990)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('新的明确点击替换旧上下文', async () => {
    const initial = await request({ fbclid: 'old-meta-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `mei_marketing_consent_receipt=${consent}; ${cookiePair(initial)}`,
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
        cookie: `mei_marketing_consent_receipt=${consent}; ${cookiePair(initial)}`,
      },
      body: JSON.stringify({ fbclid: 'meta-click', ttclid: 'tiktok-click' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'conflict', expiresInSeconds: null })
    expect(response.headers.get('set-cookie')).toContain('mei_ad_attribution=')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('没有可信营销授权时不签发广告来源', async () => {
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fbclid: 'meta-click' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'none', expiresInSeconds: null })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('客户端直接声明 provider 不会被接受', async () => {
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `mei_marketing_consent_receipt=${consent}` },
      body: JSON.stringify({ provider: 'tiktok' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'none', expiresInSeconds: null })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('非法 JSON 与未签名来源均清除旧来源', async () => {
    const initial = await request({ ttclid: 'old-tiktok-click' })
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const cookie = `mei_marketing_consent_receipt=${consent}; ${cookiePair(initial)}`
    const invalid = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: '{',
    }, env())
    const unavailable = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ utmSource: 'managed-source' }),
    }, env(true))

    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(unavailable.status).toBe(200)
    expect(unavailable.headers.get('set-cookie')).toContain('Max-Age=0')
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
