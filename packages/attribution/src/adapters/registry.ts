import type {
  AttributionProvider,
} from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import { googleAdapter } from './google'
import { metaAdapter } from './meta'
import { tiktokAdapter } from './tiktok'
import type {
  AttributionProviderAdapter,
} from './types'

const adapters: ReadonlyMap<
  AttributionProvider,
  AttributionProviderAdapter
> = new Map([
  ['meta', metaAdapter],
  ['tiktok', tiktokAdapter],
  ['google', googleAdapter],
])

export function getProviderAdapter(
  provider: unknown,
): AttributionProviderAdapter {
  const adapter = typeof provider === 'string'
    ? adapters.get(provider as AttributionProvider)
    : undefined
  if (!adapter) {
    throw new AttributionDomainError('ATTRIBUTION_PROVIDER_UNSUPPORTED')
  }
  return adapter
}

export function listProviderAdapters(): AttributionProviderAdapter[] {
  return [...adapters.values()]
}
