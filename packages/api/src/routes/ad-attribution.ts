import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type {
  AdAttributionBrowserContextResponse,
  AdAttributionProvider,
  AdBrowserEventTemplate,
  AdBrowserPublicConfig,
} from '@meigallery/shared'
import { CANONICAL_CONVERSION_EVENTS } from '@meigallery/shared/constants'
import type { Bindings, Variables } from '../index'
import { resolveAdAttributionRouting, type AdAttributionSignals } from '../services/ad-attribution-routing'
import {
  readAttributionConnectionSnapshot,
  type AttributionConnectionSnapshotReady,
} from '../services/ad-platform/connections'
import { getAdPlatformDefinition } from '../services/ad-platform/registry'
import {
  AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
  createAdAttributionContext,
  resolveTrustedAdAttributionContext,
  sealAdAttributionContext,
} from '../utils/ad-attribution-context'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'

export const AD_ATTRIBUTION_CONTEXT_COOKIE = 'mei_ad_attribution'

export const adAttributionRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adAttributionRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

adAttributionRoutes.put('/', async (c) => {
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
    result = await resolveAdAttributionRouting(c.env.DB, body, currentContext?.provider ?? null)
  }
  catch {
    clearContextCookie(c)
    return c.json(emptyResponse(), 503)
  }

  if (!result.provider) {
    clearContextCookie(c)
    return c.json(emptyResponse(result.resolution))
  }
  if (result.resolution === 'inherited' && currentContext) {
    return c.json(await resolvedResponse(c.env.DB, {
      provider: currentContext.provider,
      resolution: 'inherited' as const,
      expiresInSeconds: currentContext.expiresAt - nowSeconds,
    }))
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
    return c.json(await resolvedResponse(c.env.DB, {
      provider: context.provider,
      resolution: result.resolution,
      expiresInSeconds: AD_ATTRIBUTION_CONTEXT_TTL_SECONDS,
    }))
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
}

function emptyResponse(
  resolution: AdAttributionBrowserContextResponse['resolution'] = 'none',
): AdAttributionBrowserContextResponse {
  return {
    provider: null,
    resolution,
    expiresInSeconds: null,
    publicConfig: null,
    events: [],
  }
}

function emptyBrowserContext() {
  return { provider: null, publicConfig: null, events: [] }
}

async function resolvedResponse(
  db: D1Database,
  response: Pick<
    AdAttributionBrowserContextResponse,
    'provider' | 'resolution' | 'expiresInSeconds'
  > & { provider: AdAttributionProvider },
): Promise<AdAttributionBrowserContextResponse> {
  const browserContext = await readBrowserContext(db, response.provider)
  return {
    ...response,
    publicConfig: browserContext.publicConfig,
    events: browserContext.events,
  }
}

async function readBrowserContext(
  db: D1Database,
  provider: AdAttributionProvider,
) {
  try {
    const snapshot = await readAttributionConnectionSnapshot(db, provider)
    if (snapshot.state !== 'ready'
      || !snapshot.connection.enabled
      || !snapshot.connection.browserEnabled) return emptyBrowserContext()
    const publicConfig = serializePublicConfig(snapshot.connection.provider, snapshot.connection.publicConfig)
    if (!publicConfig) return emptyBrowserContext()
    return {
      provider: snapshot.connection.provider,
      publicConfig,
      events: serializeBrowserEventTemplates(snapshot),
    }
  }
  catch {
    return emptyBrowserContext()
  }
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

function serializeBrowserEventTemplates(
  snapshot: AttributionConnectionSnapshotReady,
): AdBrowserEventTemplate[] {
  const definition = getAdPlatformDefinition(snapshot.connection.provider)
  if (!definition) return []
  return CANONICAL_CONVERSION_EVENTS.flatMap((canonicalEvent) => {
    const binding = snapshot.bindings.get(canonicalEvent)
    const descriptor = definition.describeEvent({ canonicalEvent })
    if (!binding?.enabled || !descriptor) return []
    return [{
      provider: snapshot.connection.provider,
      canonicalEvent,
      browserEventName: descriptor.browserEventName,
      browserDestination: binding.browserDestination,
    }]
  })
}
