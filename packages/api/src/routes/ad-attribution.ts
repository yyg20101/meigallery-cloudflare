import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import { resolveAdAttributionRouting, type AdAttributionSignals } from '../services/ad-attribution-routing'
import {
  AD_ATTRIBUTION_RECEIPT_TTL_SECONDS,
  createAdAttributionReceipt,
  resolveTrustedAdAttributionReceipt,
} from '../utils/ad-attribution-receipt'
import { resolveTrustedMarketingConsent } from '../utils/marketing-consent-receipt'
import { MARKETING_CONSENT_RECEIPT_COOKIE } from './marketing-consent'

export const AD_ATTRIBUTION_RECEIPT_COOKIE = 'mei_ad_attribution_receipt'

export const adAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adAttributionRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

adAttributionRoutes.put('/', async (c) => {
  const consentState = await resolveTrustedMarketingConsent(
    c.env.SESSION_SECRET,
    getCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE),
    undefined,
  )
  if (consentState !== 'granted') {
    clearReceiptCookie(c)
    return c.json({ provider: null, resolution: 'none' as const, expiresInSeconds: null })
  }

  let body: AdAttributionSignals
  try {
    body = await c.req.json<AdAttributionSignals>()
  }
  catch {
    clearReceiptCookie(c)
    return c.json({ provider: null, resolution: 'none' as const, expiresInSeconds: null }, 400)
  }
  const nowSeconds = Math.floor(Date.now() / 1_000)
  const currentReceipt = await resolveTrustedAdAttributionReceipt(
    c.env.SESSION_SECRET,
    getCookie(c, AD_ATTRIBUTION_RECEIPT_COOKIE),
    nowSeconds,
  )
  const currentProvider = currentReceipt?.provider ?? null
  let result
  try {
    result = await resolveAdAttributionRouting(c.env.DB, body, currentProvider)
  }
  catch {
    clearReceiptCookie(c)
    return c.json({ provider: null, resolution: 'none' as const, expiresInSeconds: null }, 503)
  }

  if (!result.provider) {
    clearReceiptCookie(c)
    return c.json({ ...result, expiresInSeconds: null })
  }
  let expiresAt = currentReceipt?.expiresAt ?? null
  if (result.provider !== currentProvider) {
    const receipt = await createAdAttributionReceipt(c.env.SESSION_SECRET, result.provider, nowSeconds)
    expiresAt = nowSeconds + AD_ATTRIBUTION_RECEIPT_TTL_SECONDS
    setCookie(c, AD_ATTRIBUTION_RECEIPT_COOKIE, receipt, {
      httpOnly: true,
      secure: shouldUseSecureCookie(c.req.url, c.env.APP_ENV),
      sameSite: 'Lax',
      path: '/',
      maxAge: AD_ATTRIBUTION_RECEIPT_TTL_SECONDS,
    })
  }
  if (expiresAt === null) {
    clearReceiptCookie(c)
    return c.json({ provider: null, resolution: 'none' as const, expiresInSeconds: null }, 503)
  }
  return c.json({ ...result, expiresInSeconds: expiresAt - nowSeconds })
})

adAttributionRoutes.delete('/', (c) => {
  clearReceiptCookie(c)
  return c.json({ provider: null, resolution: 'none' as const, expiresInSeconds: null })
})

function clearReceiptCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, AD_ATTRIBUTION_RECEIPT_COOKIE, { path: '/' })
}

function shouldUseSecureCookie(requestUrl: string, appEnv: string) {
  return appEnv === 'production' || new URL(requestUrl).protocol === 'https:'
}
