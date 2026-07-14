import type { AdAttributionProvider } from '@meigallery/shared'

export type AdAttributionResolution = 'unresolved' | 'matched' | 'inherited' | 'none' | 'conflict'

type AttributionRoute = {
  path: string
  query: Record<string, unknown>
}

let pendingResolution: Promise<AdAttributionProvider | null> | null = null
let pendingKey = ''
let operationQueue: Promise<void> = Promise.resolve()
let operationVersion = 0
let lastResolvedKey = ''
let lastResolvedUntil = 0
const CLIENT_RESOLUTION_TTL_MS = 29 * 60 * 1_000
const SERVER_RECEIPT_TTL_SECONDS = 30 * 60

export function useAdAttribution() {
  const { api } = useApi()
  const provider = useState<AdAttributionProvider | null>('ad-attribution-provider', () => null)
  const resolution = useState<AdAttributionResolution>('ad-attribution-resolution', () => 'unresolved')

  async function resolve(route: AttributionRoute): Promise<AdAttributionProvider | null> {
    if (import.meta.server) return null
    const key = resolutionKey(route)
    if (!pendingResolution
      && lastResolvedKey === key
      && resolution.value !== 'unresolved'
      && Date.now() < lastResolvedUntil) return provider.value
    if (pendingResolution && pendingKey === key) return pendingResolution

    const version = ++operationVersion
    pendingKey = key
    const task = operationQueue.then(async () => {
      try {
        const response = await api<{ provider?: unknown; resolution?: unknown; expiresInSeconds?: unknown }>('/api/ad-attribution', {
          method: 'PUT',
          body: {
            fbclid: queryValue(route.query.fbclid),
            ttclid: queryValue(route.query.ttclid),
            utmSource: queryValue(route.query.utm_source),
            trackingSourceSlug: queryValue(route.query.mg_source),
          },
        })
        const normalized = normalizeServerResolution(response)
        if (!normalized) throw new Error('广告来源响应不一致')
        if (version !== operationVersion) return null
        provider.value = normalized.provider
        resolution.value = normalized.resolution
        lastResolvedKey = key
        lastResolvedUntil = Date.now() + normalized.cacheTtlMs
        return normalized.provider
      }
      catch {
        if (version === operationVersion) resetLocalState(provider, resolution)
        try {
          await api('/api/ad-attribution', { method: 'DELETE' })
        }
        catch {
          // 转化请求同时携带 suppress，只能关闭广告投递，不能凭客户端状态开启投递。
        }
        return null
      }
    })
    pendingResolution = task
    operationQueue = task.then(() => undefined, () => undefined)

    try {
      return await task
    }
    finally {
      if (pendingResolution === task) {
        pendingResolution = null
        pendingKey = ''
      }
    }
  }

  async function clear() {
    const version = ++operationVersion
    resetLocalState(provider, resolution)
    pendingResolution = null
    pendingKey = ''
    if (import.meta.server) return
    const task = operationQueue.then(async () => {
      try {
        await api('/api/ad-attribution', { method: 'DELETE' })
      }
      catch {
        // 本地 Pixel 已关闭；后续转化请求还会携带 suppress，旧 receipt 不能重新开启投递。
      }
      if (version === operationVersion) resetLocalState(provider, resolution)
    })
    operationQueue = task.then(() => undefined, () => undefined)
    await task
  }

  return { provider, resolution, resolve, clear }
}

function resetLocalState(
  provider: ReturnType<typeof useState<AdAttributionProvider | null>>,
  resolution: ReturnType<typeof useState<AdAttributionResolution>>,
) {
  provider.value = null
  resolution.value = 'none'
  lastResolvedKey = ''
  lastResolvedUntil = 0
}

function resolutionKey(route: AttributionRoute) {
  return JSON.stringify([
    route.path,
    queryValue(route.query.fbclid),
    queryValue(route.query.ttclid),
    queryValue(route.query.utm_source),
    queryValue(route.query.mg_source),
  ])
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return ''
  const normalized = raw.trim()
  return normalized.length > 1_000 ? normalized.slice(0, 1_001) : normalized
}

function normalizeProvider(value: unknown): AdAttributionProvider | null {
  return value === 'meta' || value === 'tiktok' ? value : null
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
    return { provider: null, resolution, cacheTtlMs: CLIENT_RESOLUTION_TTL_MS }
  }
  if (resolution !== 'matched' && resolution !== 'inherited') return null
  if (!Number.isInteger(response.expiresInSeconds)) return null
  const expiresInSeconds = Number(response.expiresInSeconds)
  if (expiresInSeconds <= 1 || expiresInSeconds > SERVER_RECEIPT_TTL_SECONDS) return null
  return {
    provider,
    resolution,
    cacheTtlMs: Math.min(CLIENT_RESOLUTION_TTL_MS, (expiresInSeconds - 1) * 1_000),
  }
}
