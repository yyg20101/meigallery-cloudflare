import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { createAdAttributionReceipt } from '../utils/ad-attribution-receipt'
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
  ] as const)('%s 来源签发 HttpOnly 短期 receipt 且不回显 token', async (provider, body) => {
    const response = await request(body)
    const data = await response.json<Record<string, unknown>>()
    const cookie = response.headers.get('set-cookie') || ''

    expect(response.status).toBe(200)
    expect(data).toEqual({ provider, resolution: 'matched', expiresInSeconds: 1_800 })
    expect(cookie).toMatch(/^mei_ad_attribution_receipt=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=1800')
    expect(JSON.stringify(data)).not.toContain(cookiePair(response).split('=')[1])
  })

  it('同一平台重复验证为幂等操作，不重复签发 receipt', async () => {
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const attribution = await createAdAttributionReceipt(SECRET, 'meta')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `mei_marketing_consent_receipt=${consent}; mei_ad_attribution_receipt=${attribution}`,
      },
      body: JSON.stringify({ fbclid: 'same-meta-click' }),
    }, env())

    const data = await response.json<Record<string, unknown>>()
    expect(data).toMatchObject({ provider: 'meta', resolution: 'matched' })
    expect([1_799, 1_800]).toContain(data.expiresInSeconds)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('Meta 与 TikTok 信号冲突时清除旧来源且不选择任何平台', async () => {
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const attribution = await createAdAttributionReceipt(SECRET, 'meta')
    const response = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `mei_marketing_consent_receipt=${consent}; mei_ad_attribution_receipt=${attribution}`,
      },
      body: JSON.stringify({ fbclid: 'meta-click', ttclid: 'tiktok-click' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'conflict', expiresInSeconds: null })
    expect(response.headers.get('set-cookie')).toContain('mei_ad_attribution_receipt=')
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
      headers: {
        'content-type': 'application/json',
        cookie: `mei_marketing_consent_receipt=${consent}`,
      },
      body: JSON.stringify({ provider: 'tiktok' }),
    }, env())

    expect(await response.json()).toEqual({ provider: null, resolution: 'none', expiresInSeconds: null })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('非法 JSON 与来源数据库故障均清除旧来源', async () => {
    const consent = await createMarketingConsentReceipt(SECRET, 'granted')
    const attribution = await createAdAttributionReceipt(SECRET, 'tiktok')
    const cookie = `mei_marketing_consent_receipt=${consent}; mei_ad_attribution_receipt=${attribution}`
    const invalid = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: '{',
    }, env())
    const unavailable = await app().request('https://api.616618.xyz/api/ad-attribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ utmSource: 'managed-source' }),
    }, env(true))

    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

async function request(body: Record<string, string>) {
  const consent = await createMarketingConsentReceipt(SECRET, 'granted')
  return app().request('https://api.616618.xyz/api/ad-attribution', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: `mei_marketing_consent_receipt=${consent}`,
    },
    body: JSON.stringify(body),
  }, env())
}

function env(fail = false) {
  return {
    APP_ENV: 'production',
    SESSION_SECRET: SECRET,
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
