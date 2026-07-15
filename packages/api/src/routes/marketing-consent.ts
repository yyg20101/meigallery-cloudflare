import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import {
  createMarketingConsentReceipt,
  MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
  resolveTrustedMarketingConsent,
} from '../utils/marketing-consent-receipt'
import { errorJson } from '../utils/api-error'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import { resolveTrustedAdAttributionContext } from '../utils/ad-attribution-context'
import { revokeAdAttributionContext } from '../services/ad-attribution-consent'

export const MARKETING_CONSENT_RECEIPT_COOKIE = 'mei_marketing_consent_receipt'
const AD_ATTRIBUTION_CONTEXT_COOKIE = 'mei_ad_attribution'

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

  const shouldClearAdAttribution = body.state === 'denied'
    ? await revokeCurrentAdAttribution(c)
    : false
  if (body.state === 'denied' && !shouldClearAdAttribution) {
    return errorJson(c, 503, '广告归因撤回暂时不可用', { code: 'AD_ATTRIBUTION_REVOKE_UNAVAILABLE' })
  }

  const receipt = await createMarketingConsentReceipt(c.env.SESSION_SECRET, body.state)
  setCookie(c, MARKETING_CONSENT_RECEIPT_COOKIE, receipt, {
    httpOnly: true,
    secure: shouldUseSecureCookie(c.req.url, c.env.APP_ENV),
    sameSite: 'Lax',
    path: '/',
    maxAge: MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
  })
  if (shouldClearAdAttribution) clearAdAttributionContextCookie(c)
  return c.json({ state: body.state })
})

async function revokeCurrentAdAttribution(c: Parameters<typeof getCookie>[0]) {
  const encrypted = getCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE)
  if (!encrypted) return true
  try {
    const keys = await loadAttributionCryptoKeys(c.env)
    const context = await resolveTrustedAdAttributionContext(keys, encrypted)
    if (context) await revokeAdAttributionContext(c.env.DB, context.contextId)
    return true
  }
  catch {
    return false
  }
}

function clearAdAttributionContextCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' })
}

function shouldUseSecureCookie(requestUrl: string, appEnv: string) {
  return appEnv === 'production' || new URL(requestUrl).protocol === 'https:'
}
