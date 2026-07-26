import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import { errorJson } from '../utils/api-error'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import { resolveTrustedAdAttributionContext } from '../utils/ad-attribution-context'
import { revokeAdAttributionContext } from '../services/ad-attribution-consent'
import {
  persistMarketingConsentChoice,
  resolveRequestMarketingConsent,
} from '../utils/marketing-consent-request'

const AD_ATTRIBUTION_CONTEXT_COOKIE = 'mei_ad_attribution'

export const marketingConsentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

marketingConsentRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

marketingConsentRoutes.get('/', async (c) => {
  const resolution = await resolveRequestMarketingConsent(c)
  return c.json(publicConsentResolution(resolution))
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

  const resolution = await resolveRequestMarketingConsent(c, undefined, undefined, body.state)
  if (body.state === 'granted' && resolution.state !== 'granted') {
    return c.json(publicConsentResolution(resolution))
  }
  await persistMarketingConsentChoice(c, body.state)
  if (shouldClearAdAttribution) clearAdAttributionContextCookie(c)
  return c.json(publicConsentResolution({
    ...resolution,
    state: body.state,
    decisionSource: 'explicit',
    requiresChoice: false,
  }))
})

function publicConsentResolution(resolution: Awaited<ReturnType<typeof resolveRequestMarketingConsent>>) {
  return {
    state: resolution.state,
    policyMode: resolution.policyMode,
    decisionSource: resolution.decisionSource,
    requiresChoice: resolution.requiresChoice,
    policyVersion: resolution.policyVersion,
  }
}

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
