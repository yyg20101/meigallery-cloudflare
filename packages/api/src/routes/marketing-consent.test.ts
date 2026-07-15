import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
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
  it('grant 设置短期 HttpOnly、Secure、SameSite receipt 且不回显 token', async () => {
    const response = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    }, ENV)
    const body = await response.json<Record<string, unknown>>()
    const cookie = response.headers.get('set-cookie') || ''

    expect(response.status).toBe(200)
    expect(body).toEqual({ state: 'granted' })
    expect(cookie).toMatch(/^mei_marketing_consent_receipt=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=1800')
    expect(JSON.stringify(body)).not.toContain(cookie.split(';')[0]?.split('=')[1])
  })

  it('GET 只返回服务端验证状态，撤销后同一浏览器变为 denied', async () => {
    const granted = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    }, ENV)
    const grantedCookie = cookiePair(granted)
    const current = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { cookie: grantedCookie },
    }, ENV)
    expect(await current.json()).toEqual({ state: 'granted' })

    const revoked = await app().request('https://api.616618.xyz/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: grantedCookie },
      body: JSON.stringify({ state: 'denied' }),
    }, ENV)
    expect(revoked.headers.get('set-cookie')).toContain('mei_ad_attribution=')
    expect(revoked.headers.get('set-cookie')).toContain('mei_ad_attribution_receipt=')
    expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0')
    const revokedCookie = cookiePair(revoked)
    const denied = await app().request('https://api.616618.xyz/api/marketing-consent', {
      headers: { cookie: revokedCookie },
    }, ENV)
    expect(await denied.json()).toEqual({ state: 'denied' })
  })

  it('local HTTP cookie 保留 HttpOnly/SameSite 但不设置 Secure', async () => {
    const response = await app().request('http://localhost:8787/api/marketing-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'granted' }),
    }, { ...ENV, APP_ENV: 'local' })
    const cookie = response.headers.get('set-cookie') || ''

    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('Secure')
  })
})

function cookiePair(response: Response) {
  return (response.headers.get('set-cookie') || '').split(';')[0] || ''
}
