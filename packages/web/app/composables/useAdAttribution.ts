import type {
  AdAttributionBrowserContextResponse,
  AdAttributionProvider,
  AdAttributionResolution as ServerAdAttributionResolution,
  AdBrowserEventTemplate,
  AdBrowserPublicConfig,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { readBrowserAdAttributionSignals } from '~/utils/adAttributionSignals'

export type AdAttributionResolution = 'unresolved' | ServerAdAttributionResolution

type AttributionRoute = {
  path: string
  query: Record<string, unknown>
}

let operationQueue: Promise<void> = Promise.resolve()
let operationVersion = 0
let pendingResolution: {
  routeKey: string
  task: Promise<AdAttributionProvider | null>
} | null = null
const SERVER_CONTEXT_TTL_SECONDS = 30 * 24 * 60 * 60

export function useAdAttribution() {
  const { api } = useApi()
  const provider = useState<AdAttributionProvider | null>('ad-attribution-provider', () => null)
  const resolution = useState<AdAttributionResolution>('ad-attribution-resolution', () => 'unresolved')
  const publicConfig = useState<AdBrowserPublicConfig | null>('ad-attribution-public-config', () => null)
  const browserEvents = useState<AdBrowserEventTemplate[]>('ad-attribution-browser-events', () => [])
  const resolvedRouteKey = useState<string>('ad-attribution-route-key', () => '')

  async function resolve(route: AttributionRoute): Promise<AdAttributionProvider | null> {
    const routeKey = attributionRouteKey(route)
    if (resolvedRouteKey.value === routeKey) {
      return pendingResolution?.routeKey === routeKey
        ? pendingResolution.task
        : provider.value
    }
    if (import.meta.server) {
      try {
        const normalized = await requestResolution(api, route)
        applyResolvedState(normalized, provider, resolution, publicConfig, browserEvents)
        resolvedRouteKey.value = routeKey
        return normalized.provider
      }
      catch {
        resetLocalState(provider, resolution, publicConfig, browserEvents)
        resolvedRouteKey.value = ''
        return null
      }
    }

    const previousRouteKey = resolvedRouteKey.value
    const hadResolvedRoute = Boolean(previousRouteKey) && resolution.value !== 'unresolved'
    resolvedRouteKey.value = routeKey
    const version = ++operationVersion
    const queuedTask = operationQueue.then(async () => {
      try {
        const normalized = await requestResolution(api, route)
        if (version !== operationVersion) return null
        if (hadResolvedRoute && requiresFullReload(provider.value, normalized.provider)) {
          resetLocalState(provider, resolution, publicConfig, browserEvents)
          resolvedRouteKey.value = ''
          window.location.reload()
          return null
        }
        applyResolvedState(normalized, provider, resolution, publicConfig, browserEvents)
        return normalized.provider
      }
      catch {
        if (version === operationVersion) {
          resetLocalState(provider, resolution, publicConfig, browserEvents)
          resolvedRouteKey.value = ''
        }
        try {
          await api('/api/ad-attribution', { method: 'DELETE' })
        }
        catch {
          // 本地已关闭来源；后续服务端投递仍只接受加密来源上下文。
        }
        return null
      }
    })
    const task = queuedTask.finally(() => {
      if (pendingResolution?.task === task) pendingResolution = null
    })
    pendingResolution = { routeKey, task }
    operationQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async function clear() {
    const version = ++operationVersion
    resetLocalState(provider, resolution, publicConfig, browserEvents)
    resolvedRouteKey.value = ''
    if (import.meta.server) return
    const task = operationQueue.then(async () => {
      try {
        await api('/api/ad-attribution', { method: 'DELETE' })
      }
      catch {
        // 本地 Pixel 已关闭；服务端不可用不能阻断页面操作。
      }
      if (version === operationVersion) resetLocalState(provider, resolution, publicConfig, browserEvents)
    })
    operationQueue = task.then(() => undefined, () => undefined)
    await task
  }

  function isResolvedFor(route: AttributionRoute) {
    const routeKey = attributionRouteKey(route)
    return resolvedRouteKey.value === routeKey
      && pendingResolution?.routeKey !== routeKey
      && provider.value !== null
      && (resolution.value === 'matched' || resolution.value === 'inherited')
  }

  function getBrowserEventTemplate(
    route: AttributionRoute,
    canonicalEvent: CanonicalConversionEvent,
  ) {
    if (!isResolvedFor(route)) return null
    return browserEvents.value.find(event => (
      event.provider === provider.value
      && event.canonicalEvent === canonicalEvent
    )) ?? null
  }

  return {
    provider,
    resolution,
    publicConfig,
    resolve,
    clear,
    getBrowserEventTemplate,
  }
}

export function requiresFullReload(
  currentProvider: AdAttributionProvider | null,
  nextProvider: AdAttributionProvider | null,
) {
  return currentProvider !== nextProvider
}

async function requestResolution(
  api: ReturnType<typeof useApi>['api'],
  route: AttributionRoute,
) {
  const response = await api<AdAttributionBrowserContextResponse>('/api/ad-attribution', {
    method: 'PUT',
    body: readBrowserAdAttributionSignals(route.query),
  })
  const normalized = normalizeServerResolution(response)
  if (!normalized) throw new Error('广告来源响应不一致')
  return normalized
}

function applyResolvedState(
  next: AdAttributionBrowserContextResponse,
  provider: ReturnType<typeof useState<AdAttributionProvider | null>>,
  resolution: ReturnType<typeof useState<AdAttributionResolution>>,
  publicConfig: ReturnType<typeof useState<AdBrowserPublicConfig | null>>,
  browserEvents: ReturnType<typeof useState<AdBrowserEventTemplate[]>>,
) {
  provider.value = next.provider
  resolution.value = next.resolution
  publicConfig.value = next.publicConfig
  browserEvents.value = next.events
}

function resetLocalState(
  provider: ReturnType<typeof useState<AdAttributionProvider | null>>,
  resolution: ReturnType<typeof useState<AdAttributionResolution>>,
  publicConfig: ReturnType<typeof useState<AdBrowserPublicConfig | null>>,
  browserEvents: ReturnType<typeof useState<AdBrowserEventTemplate[]>>,
) {
  provider.value = null
  resolution.value = 'none'
  publicConfig.value = null
  browserEvents.value = []
}

function attributionRouteKey(route: AttributionRoute) {
  const signals = readBrowserAdAttributionSignals(route.query)
  const value = [
    route.path,
    signals.fbclid,
    signals.ttclid,
    signals.gclid,
    signals.gbraid,
    signals.wbraid,
    signals.trackingSourceSlug,
  ].join('\u001f')
  return stableHash(value)
}

function stableHash(value: string) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function normalizeProvider(value: unknown): AdAttributionProvider | null {
  return value === 'meta' || value === 'tiktok' || value === 'google' ? value : null
}

function normalizeResolution(value: unknown): AdAttributionResolution {
  return value === 'matched' || value === 'inherited' || value === 'conflict' ? value : 'none'
}

function normalizeServerResolution(response: unknown): AdAttributionBrowserContextResponse | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null
  const value = response as Record<string, unknown>
  if (!exactKeys(value, ['provider', 'resolution', 'expiresInSeconds', 'publicConfig', 'events'])) return null
  const provider = normalizeProvider(value.provider)
  const resolution = normalizeResolution(value.resolution)
  if (!provider) {
    if (value.provider !== null
      || value.expiresInSeconds !== null
      || value.publicConfig !== null
      || !Array.isArray(value.events)
      || value.events.length !== 0
      || (resolution !== 'none' && resolution !== 'conflict')) return null
    return {
      provider: null,
      resolution,
      expiresInSeconds: null,
      publicConfig: null,
      events: [],
    }
  }
  if (resolution !== 'matched' && resolution !== 'inherited') return null
  if (!Number.isInteger(value.expiresInSeconds)) return null
  const expiresInSeconds = Number(value.expiresInSeconds)
  if (expiresInSeconds <= 1 || expiresInSeconds > SERVER_CONTEXT_TTL_SECONDS) return null
  const publicConfig = value.publicConfig === null ? null : normalizePublicConfig(value.publicConfig)
  if (publicConfig?.provider !== provider && publicConfig !== null) return null
  const events = normalizeBrowserEventTemplates(value.events, provider)
  if (events === null || (!publicConfig && events.length > 0)) return null
  return {
    provider,
    resolution,
    expiresInSeconds,
    publicConfig,
    events,
  }
}

function normalizePublicConfig(value: unknown): AdBrowserPublicConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as Record<string, unknown>
  if (config.provider === 'meta'
    && exactKeys(config, ['provider', 'pixelId'])
    && typeof config.pixelId === 'string'
    && /^\d{5,30}$/.test(config.pixelId)) return { provider: 'meta', pixelId: config.pixelId }
  if (config.provider === 'tiktok'
    && exactKeys(config, ['provider', 'pixelCode'])
    && typeof config.pixelCode === 'string'
    && /^[A-Z0-9]{10,30}$/.test(config.pixelCode)) return { provider: 'tiktok', pixelCode: config.pixelCode }
  if (config.provider === 'google'
    && exactKeys(config, ['provider', 'tagId'])
    && typeof config.tagId === 'string'
    && /^AW-\d{5,20}$/.test(config.tagId)) {
    return { provider: 'google', tagId: config.tagId }
  }
  return null
}

function normalizeBrowserEventTemplates(
  value: unknown,
  provider: AdAttributionProvider,
): AdBrowserEventTemplate[] | null {
  if (!Array.isArray(value) || value.length > 2) return null
  const normalized: AdBrowserEventTemplate[] = []
  const canonicalEvents = new Set<CanonicalConversionEvent>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const event = item as Record<string, unknown>
    if (!exactKeys(event, ['provider', 'canonicalEvent', 'browserEventName', 'browserDestination'])
      || event.provider !== provider
      || (event.canonicalEvent !== 'Contact' && event.canonicalEvent !== 'CompleteRegistration')
      || !safeTemplateText(event.browserDestination)
      || (provider === 'google'
        ? event.browserEventName !== 'conversion'
        : event.browserEventName !== event.canonicalEvent)) return null
    if (canonicalEvents.has(event.canonicalEvent as CanonicalConversionEvent)) return null
    canonicalEvents.add(event.canonicalEvent as CanonicalConversionEvent)
    normalized.push(event as unknown as AdBrowserEventTemplate)
  }
  return normalized
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

function safeTemplateText(value: unknown) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/\p{Cc}/u.test(value)
}
