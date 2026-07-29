import type {
  AdAttributionProvider,
  AdBrowserEventTemplate,
  AdBrowserPublicConfig,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { readBrowserAdAttributionSignals } from '~/utils/adAttributionSignals'

export type AdAttributionResolution = 'unresolved' | 'matched' | 'inherited' | 'none' | 'conflict'

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
    if (import.meta.server) return null
    const routeKey = attributionRouteKey(route)
    if (resolvedRouteKey.value === routeKey) {
      return pendingResolution?.routeKey === routeKey
        ? pendingResolution.task
        : provider.value
    }
    resolvedRouteKey.value = routeKey
    const version = ++operationVersion
    const queuedTask = operationQueue.then(async () => {
      try {
        const signals = readBrowserAdAttributionSignals(route.query)
        const response = await api<{ provider?: unknown; resolution?: unknown; expiresInSeconds?: unknown }>('/api/ad-attribution', {
          method: 'PUT',
          body: signals,
        })
        const normalized = normalizeServerResolution(response)
        if (!normalized) throw new Error('广告来源响应不一致')
        if (version !== operationVersion) return null
        if (requiresFullReload(provider.value, normalized.provider)) {
          resetLocalState(provider, resolution, publicConfig, browserEvents)
          resolvedRouteKey.value = ''
          window.location.reload()
          return null
        }
        const providerChanged = provider.value !== normalized.provider
        provider.value = normalized.provider
        resolution.value = normalized.resolution
        if (providerChanged) {
          publicConfig.value = null
          browserEvents.value = []
        }
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

  async function bootstrap(): Promise<AdBrowserPublicConfig | null> {
    if (import.meta.server || !provider.value) return null
    const expectedProvider = provider.value
    const version = operationVersion
    const task = operationQueue.then(async () => {
      if (publicConfig.value?.provider === expectedProvider) return publicConfig.value
      try {
        const response = await api<{ provider?: unknown; publicConfig?: unknown; events?: unknown }>('/api/ad-attribution/bootstrap')
        const config = normalizePublicConfig(response.publicConfig)
        const events = response.events === undefined
          ? []
          : normalizeBrowserEventTemplates(response.events, expectedProvider)
        if (version !== operationVersion
          || response.provider !== expectedProvider
          || config?.provider !== expectedProvider
          || events === null) return null
        publicConfig.value = config
        browserEvents.value = events
        return config
      }
      catch {
        if (version === operationVersion) {
          publicConfig.value = null
          browserEvents.value = []
        }
        return null
      }
    })
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
    browserEvents,
    resolve,
    bootstrap,
    clear,
    isResolvedFor,
    getBrowserEventTemplate,
  }
}

export function requiresFullReload(
  currentProvider: AdAttributionProvider | null,
  nextProvider: AdAttributionProvider | null,
) {
  return Boolean(currentProvider && currentProvider !== nextProvider)
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

function normalizeServerResolution(response: {
  provider?: unknown
  resolution?: unknown
  expiresInSeconds?: unknown
}) {
  const provider = normalizeProvider(response.provider)
  const resolution = normalizeResolution(response.resolution)
  if (!provider) {
    if (response.provider !== null || (resolution !== 'none' && resolution !== 'conflict')) return null
    return { provider: null, resolution }
  }
  if (resolution !== 'matched' && resolution !== 'inherited') return null
  if (!Number.isInteger(response.expiresInSeconds)) return null
  const expiresInSeconds = Number(response.expiresInSeconds)
  if (expiresInSeconds <= 1 || expiresInSeconds > SERVER_CONTEXT_TTL_SECONDS) return null
  return {
    provider,
    resolution,
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
  if (!Array.isArray(value)) return null
  const normalized: AdBrowserEventTemplate[] = []
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
