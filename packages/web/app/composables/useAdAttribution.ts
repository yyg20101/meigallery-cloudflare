import type { AdAttributionProvider } from '@meigallery/shared'

export type AdAttributionResolution = 'unresolved' | 'matched' | 'inherited' | 'none' | 'conflict'

type AttributionRoute = {
  path: string
  query: Record<string, unknown>
}

let operationQueue: Promise<void> = Promise.resolve()
let operationVersion = 0
const SERVER_CONTEXT_TTL_SECONDS = 30 * 24 * 60 * 60

export function useAdAttribution() {
  const { api } = useApi()
  const provider = useState<AdAttributionProvider | null>('ad-attribution-provider', () => null)
  const resolution = useState<AdAttributionResolution>('ad-attribution-resolution', () => 'unresolved')

  async function resolve(route: AttributionRoute): Promise<AdAttributionProvider | null> {
    if (import.meta.server) return null
    const version = ++operationVersion
    const task = operationQueue.then(async () => {
      try {
        const response = await api<{ provider?: unknown; resolution?: unknown; expiresInSeconds?: unknown }>('/api/ad-attribution', {
          method: 'PUT',
          body: {
            fbclid: queryValue(route.query.fbclid),
            ttclid: queryValue(route.query.ttclid),
            gclid: queryValue(route.query.gclid),
            gbraid: queryValue(route.query.gbraid),
            wbraid: queryValue(route.query.wbraid),
            utmSource: queryValue(route.query.utm_source),
            trackingSourceSlug: queryValue(route.query.mg_source),
            managedLinkToken: queryValue(route.query.mg_token),
          },
        })
        const normalized = normalizeServerResolution(response)
        if (!normalized) throw new Error('广告来源响应不一致')
        if (version !== operationVersion) return null
        provider.value = normalized.provider
        resolution.value = normalized.resolution
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
    operationQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async function clear() {
    const version = ++operationVersion
    resetLocalState(provider, resolution)
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
}

function queryValue(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return ''
  const normalized = raw.trim()
  return normalized.length > 1_000 ? normalized.slice(0, 1_001) : normalized
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
