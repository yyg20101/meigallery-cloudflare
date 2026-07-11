import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import {
  createMarketingConsentReceipt,
  MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
  resolveTrustedMarketingConsent,
} from '../utils/marketing-consent-receipt'
import { errorJson } from '../utils/api-error'

export const MARKETING_CONSENT_RECEIPT_COOKIE = 'mei_marketing_consent_receipt'

export const marketingConsentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

marketingConsentRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

marketingConsentRoutes.get('/', async (c) => {
  const state = await resolveTrustedMarketingConsent(
    c.env.SESSION_SECRET,
    getCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE),
    undefined,
  )
  return c.json({ state })
})

marketingConsentRoutes.put('/', async (c) => {
  let body: { state?: unknown }
  try {
    body = await c.req.json<{ state?: unknown }>()
  }
  catch {
    return errorJson(c, 400, '营销授权请求无效', { code: 'MARKETING_CONSENT_INVALID' })
  }
  if (body.state !== 'granted' && body.state !== 'denied') {
    return errorJson(c, 400, '营销授权状态无效', { code: 'MARKETING_CONSENT_INVALID' })
  }

  const receipt = await createMarketingConsentReceipt(c.env.SESSION_SECRET, body.state)
  setCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE, receipt, {
    httpOnly: true,
    secure: shouldUseSecureCookie(c.req.url, c.env.APP_ENV),
    sameSite: 'Lax',
    path: '/',
    maxAge: MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
  })
  return c.json({ state: body.state })
})

function shouldUseSecureCookie(requestUrl: string, appEnv: string) {
  return appEnv === 'production' || new URL(requestUrl).protocol === 'https:'
}
