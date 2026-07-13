import type {
  ActiveConversionActionType,
  AdDeliveryTransport,
  AdPlatformConversionEventName,
  AdPlatformProvider,
} from '@meigallery/shared'

export interface AdPlatformAdapterDefinition {
  provider: AdPlatformProvider
  eventNames: Readonly<Record<ActiveConversionActionType, AdPlatformConversionEventName>>
  transports: readonly AdDeliveryTransport[]
}

const META_ADAPTER: AdPlatformAdapterDefinition = {
  provider: 'meta',
  eventNames: {
    contact: 'Contact',
    complete_registration: 'CompleteRegistration',
  },
  transports: ['browser', 'server'],
}

const TIKTOK_ADAPTER: AdPlatformAdapterDefinition = {
  provider: 'tiktok',
  eventNames: {
    contact: 'Contact',
    complete_registration: 'CompleteRegistration',
  },
  transports: ['browser', 'server'],
}

const ADAPTERS: ReadonlyMap<AdPlatformProvider, AdPlatformAdapterDefinition> = new Map([
  [META_ADAPTER.provider, META_ADAPTER],
  [TIKTOK_ADAPTER.provider, TIKTOK_ADAPTER],
])

export function getAdPlatformAdapter(provider: AdPlatformProvider) {
  const adapter = ADAPTERS.get(provider)
  if (!adapter) throw new Error(`AD_PLATFORM_ADAPTER_NOT_REGISTERED:${provider}`)
  return adapter
}

export function hasAdPlatformAdapter(provider: unknown): provider is AdPlatformProvider {
  return typeof provider === 'string' && ADAPTERS.has(provider as AdPlatformProvider)
}

export function listAdPlatformProviders(): AdPlatformProvider[] {
  return [...ADAPTERS.keys()]
}

export function mapConversionToPlatformEvent(
  provider: AdPlatformProvider,
  actionType: ActiveConversionActionType,
) {
  return getAdPlatformAdapter(provider).eventNames[actionType]
}
