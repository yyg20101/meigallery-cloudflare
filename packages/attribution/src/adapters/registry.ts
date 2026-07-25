import type {
  AttributionCredentialType,
  AttributionProvider,
} from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import { googleAdapter } from './google'
import { metaAdapter } from './meta'
import { tiktokAdapter } from './tiktok'
import type {
  AttributionProviderAdapter,
} from './types'

interface AttributionProviderRegistration {
  adapter: AttributionProviderAdapter
  credentialType: AttributionCredentialType
}

const registrations: ReadonlyMap<
  AttributionProvider,
  AttributionProviderRegistration
> = new Map([
  ['meta', {
    adapter: metaAdapter,
    credentialType: 'access_token',
  }],
  ['tiktok', {
    adapter: tiktokAdapter,
    credentialType: 'access_token',
  }],
  ['google', {
    adapter: googleAdapter,
    credentialType: 'service_account_json',
  }],
])

export function getProviderAdapter(
  provider: unknown,
): AttributionProviderAdapter {
  return getProviderRegistration(provider).adapter
}

export function getProviderCredentialType(
  provider: unknown,
): AttributionCredentialType {
  return getProviderRegistration(provider).credentialType
}

function getProviderRegistration(
  provider: unknown,
): AttributionProviderRegistration {
  const registration = typeof provider === 'string'
    ? registrations.get(provider as AttributionProvider)
    : undefined
  if (!registration) {
    throw new AttributionDomainError('ATTRIBUTION_PROVIDER_UNSUPPORTED')
  }
  return registration
}

export function listProviderAdapters(): AttributionProviderAdapter[] {
  return [...registrations.values()].map(item => item.adapter)
}
