import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { createMarketingConsentChoice } from '../utils/marketing-consent-receipt'
import { marketingConsentRoutes } from './marketing-consent'

const ENV = {
  APP_ENV: 'production',
  SESSION_SECRET: 'marketing-consent-route-secret',
} as unknown as Bindings

function app() {
  const instance = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  instance.route('/api/marketing-consent', marketingConsentRoutes)
  return instance
}

describe('公开营销授权 API', () => {
  it('grant 同时设置长期选择和短期 receipt，且不向响应体泄露 token', async () => {
    const response = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    }, ENV)
    const body = await response.json<Record<string, unknown>>()
    const cookies = response.headers.get('set-cookie') || ''

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ state: 'granted', decisionSource: 'explicit', requiresChoice: false })
    expect(cookies).toContain('mei_marketing_consent_choice=')
    expect(cookies).toContain('Max-Age=15552000')
    expect(cookies).toContain('mei_marketing_consent_receipt=')
    expect(cookies).toContain('Max-Age=1800')
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('Secure')
    expect(cookies).toContain('SameSite=Lax')
    for (const pair of cookiePairs(response).split('; ')) {
      expect(JSON.stringify(body)).not.toContain(pair.split('=')[1])
    }
  })

  it('GET 可从长期选择静默续签短期 receipt', async () => {
    const choice = await createMarketingConsentChoice(ENV.SESSION_SECRET, 'granted')
    const current = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { cookie: `mei_marketing_consent_choice=${choice.token}` },
    }, ENV)

    expect(await current.json()).toMatchObject({ state: 'granted', decisionSource: 'explicit' })
    expect(current.headers.get('set-cookie')).toContain('mei_marketing_consent_receipt=')
    expect(current.headers.get('set-cookie')).toContain('Max-Age=1800')
  })

  it('撤销后长期选择变为 denied，并清理当前广告归因上下文', async () => {
    const granted = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    }, ENV)
    const current = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { cookie: cookiePairs(granted) },
    }, ENV)
    expect(await current.json()).toMatchObject({ state: 'granted', decisionSource: 'explicit' })

    const revoked = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookiePairs(granted) },
      body: JSON.stringify({ state: 'denied' }),
    }, ENV)
    const setCookies = revoked.headers.get('set-cookie') || ''
    expect(setCookies).toContain('mei_marketing_consent_choice=')
    expect(setCookies).toContain('mei_marketing_consent_receipt=')
    expect(setCookies).toContain('mei_ad_attribution=')
    expect(setCookies).toContain('mei_ad_attribution_receipt=')
    expect(setCookies).toContain('Max-Age=0')

    const denied = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { cookie: cookiePairs(revoked) },
    }, ENV)
    expect(await denied.json()).toMatchObject({ state: 'denied', decisionSource: 'explicit' })
  })

  it('local HTTP cookie 保留 HttpOnly/SameSite 但不设置 Secure', async () => {
    const response = await app().request('http://localhost:8787/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    }, { ...ENV, APP_ENV: 'local' })
    const cookies = response.headers.get('set-cookie') || ''

    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('SameSite=Lax')
    expect(cookies).not.toContain('Secure')
  })

  it('非严格地区在明确告知并可退出模式下默认允许营销衡量', async () => {
    const response = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { 'CF-IPCountry': 'US' },
    }, { ...ENV, DB: privacyPolicyDb() })

    expect(await response.json()).toEqual({
      state: 'granted',
      policyMode: 'notice_opt_out',
      decisionSource: 'regional_default',
      requiresChoice: false,
      policyVersion: 7,
    })
  })

  it.each(['GB', 'XX', 'T1', 'A1'])('%s 按严格地区处理，选择前禁止 Pixel 与 Server API', async (countryCode) => {
    const response = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { 'CF-IPCountry': countryCode },
    }, { ...ENV, DB: privacyPolicyDb() })

    expect(await response.json()).toMatchObject({
      state: 'limited',
      policyMode: 'prior_consent',
      decisionSource: 'choice_required',
      requiresChoice: true,
    })
  })

  it('GPC 覆盖地区默认值和历史授权，不允许重新开启营销衡量', async () => {
    const choice = await createMarketingConsentChoice(ENV.SESSION_SECRET, 'granted')
    const response = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'CF-IPCountry': 'US',
        'Sec-GPC': '1',
        cookie: `mei_marketing_consent_choice=${choice.token}`,
      },
      body: JSON.stringify({ state: 'granted' }),
    }, { ...ENV, DB: privacyPolicyDb() })

    expect(await response.json()).toMatchObject({ state: 'denied', decisionSource: 'gpc' })
    expect(response.headers.get('set-cookie') || '').not.toContain('mei_marketing_consent_choice=')
  })

  it('明确拒绝覆盖非严格地区默认启用策略', async () => {
    const denied = await createMarketingConsentChoice(ENV.SESSION_SECRET, 'denied')
    const response = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { 'CF-IPCountry': 'US', cookie: `mei_marketing_consent_choice=${denied.token}` },
    }, { ...ENV, DB: privacyPolicyDb() })

    expect(await response.json()).toMatchObject({ state: 'denied', decisionSource: 'explicit' })
  })
})

function privacyPolicyDb() {
  return {
    prepare() {
      return {
        bind() { return this },
        async first() {
          return {
            default_mode: 'notice_opt_out',
            prior_consent_country_codes_json: JSON.stringify(['GB']),
            policy_version: 7,
            updated_at: '2026-07-16 00:00:00',
          }
        },
      }
    },
  } as unknown as D1Database
}

function cookiePairs(response: Response) {
  return (response.headers.get('set-cookie') || '')
    .split(/,(?=\s*mei_[A-Za-z0-9_]+=)/)
    .map(cookie => cookie.trim().split(';')[0])
    .filter(Boolean)
    .join('; ')
}
