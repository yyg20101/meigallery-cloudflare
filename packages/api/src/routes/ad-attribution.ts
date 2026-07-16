import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AdAttributionProvider, AdBrowserPublicConfig } from '@meigallery/shared'
import type { Bindings, Variables } from '../index'
import { resolveAdAttributionRouting, type AdAttributionSignals } from '../services/ad-attribution-routing'
import { readAttributionConnectionSnapshot } from '../services/ad-platform/connections'
import {
  AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
  createAdAttributionContext,
  resolveTrustedAdAttributionContext,
  sealAdAttributionContext,
} from '../utils/ad-attribution-context'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import { resolveRequestMarketingConsent } from '../utils/marketing-consent-request'

export const AD_ATTRIBUTION_CONTEXT_COOKIE = 'mei_ad_attribution'
/** 旧 receipt 仅为过渡期导出；任务 4 不再签发或读取。 */
export const AD_ATTRIBUTION_RECEIPT_COOKIE = 'mei_ad_attribution_receipt'

export const adAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adAttributionRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

adAttributionRoutes.get('/bootstrap', async (c) => {
  const { state: consentState } = await resolveRequestMarketingConsent(c)
  if (consentState !== 'granted') return c.json(emptyBootstrapResponse())

  try {
    const keys = await loadAttributionCryptoKeys(c.env)
    const context = await resolveTrustedAdAttributionContext(
      keys,
      getCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE),
    )
    if (!context) return c.json(emptyBootstrapResponse())

    const snapshot = await readAttributionConnectionSnapshot(c.env.DB, context.provider)
    if (snapshot.state !== 'ready'
      || !snapshot.connection.enabled
      || !snapshot.connection.browserEnabled
      || snapshot.connection.mode === 'disabled') return c.json(emptyBootstrapResponse())
    const publicConfig = serializePublicConfig(snapshot.connection.provider, snapshot.connection.publicConfig)
    if (!publicConfig) return c.json(emptyBootstrapResponse())

    return c.json({
      provider: snapshot.connection.provider,
      publicConfig,
    })
  }
  catch {
    return c.json(emptyBootstrapResponse())
  }
})

adAttributionRoutes.put('/', async (c) => {
  const { state: consentState } = await resolveRequestMarketingConsent(c)
  if (consentState !== 'granted') {
    clearContextCookie(c)
    return c.json(emptyResponse())
  }

  let body: AdAttributionSignals
  try {
    body = await c.req.json<AdAttributionSignals>()
  }
  catch {
    clearContextCookie(c)
    return c.json(emptyResponse(), 400)
  }

  const nowSeconds = Math.floor(Date.now() / 1_000)
  let keys
  let currentContext
  try {
    keys = await loadAttributionCryptoKeys(c.env)
    currentContext = await resolveTrustedAdAttributionContext(
      keys,
      getCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE),
      nowSeconds,
    )
  }
  catch {
    clearContextCookie(c)
    return c.json(emptyResponse(), 503)
  }

  let result
  try {
    result = await resolveAdAttributionRouting(c.env.DB, body, currentContext?.provider ?? null, {
      managedLinkSecret: c.env.SESSION_SECRET,
      nowSeconds,
    })
  }
  catch {
    clearContextCookie(c)
    return c.json(emptyResponse(), 503)
  }

  if (!result.provider) {
    clearContextCookie(c)
    return c.json({ provider: null, resolution: result.resolution, expiresInSeconds: null })
  }
  if (result.resolution === 'inherited' && currentContext) {
    return c.json({
      provider: currentContext.provider,
      resolution: 'inherited' as const,
      expiresInSeconds: currentContext.expiresAt - nowSeconds,
    })
  }

  try {
    const context = createAdAttributionContext({
      provider: result.provider,
      source: result.source!,
      identifiers: result.identifiers,
      nowSeconds,
    })
    const encrypted = await sealAdAttributionContext(keys, context)
    setCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE, encrypted, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
    })
    return c.json({
      provider: context.provider,
      resolution: result.resolution,
      expiresInSeconds: AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
    })
  }
  catch {
    clearContextCookie(c)
    return c.json(emptyResponse(), 503)
  }
})

adAttributionRoutes.delete('/', (c) => {
  clearContextCookie(c)
  return c.json(emptyResponse())
})

export function clearContextCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, AD_ATTRIBUTION_CONTEXT_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' })
  deleteCookie(c, AD_ATTRIBUTION_RECEIPT_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' })
}

function emptyResponse() {
  return { provider: null, resolution: 'none' as const, expiresInSeconds: null }
}

function emptyBootstrapResponse() {
  return { provider: null, publicConfig: null }
}

function serializePublicConfig(
  provider: AdAttributionProvider,
  config: Record<string, string>,
): AdBrowserPublicConfig | null {
  if (provider === 'meta' && config.pixelId) return { provider, pixelId: config.pixelId }
  if (provider === 'tiktok' && config.pixelCode) return { provider, pixelCode: config.pixelCode }
  if (provider === 'google' && config.tagId) return { provider, tagId: config.tagId }
  return null
}
