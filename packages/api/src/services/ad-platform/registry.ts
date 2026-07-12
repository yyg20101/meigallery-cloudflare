import type {
  ActiveConversionActionType,
  AdDeliveryTransport,
  AdPlatformProvider,
  ActiveAdPlatformEventName,
} from '@meigallery/shared'

export interface AdPlatformAdapterDefinition {
  provider: AdPlatformProvider
  eventNames: Readonly<Record<ActiveConversionActionType, ActiveAdPlatformEventName>>
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

const ADAPTERS: ReadonlyMap<AdPlatformProvider, AdPlatformAdapterDefinition> = new Map([
  [META_ADAPTER.provider, META_ADAPTER],
])

export function getAdPlatformAdapter(provider: AdPlatformProvider) {
  const adapter = ADAPTERS.get(provider)
  if (!adapter) throw new Error(`AD_PLATFORM_ADAPTER_NOT_REGISTERED:${provider}`)
  return adapter
}

export function mapConversionToPlatformEvent(
  provider: AdPlatformProvider,
  actionType: ActiveConversionActionType,
) {
  return getAdPlatformAdapter(provider).eventNames[actionType]
}

export function legacyChannelForTransport(provider: AdPlatformProvider, transport: AdDeliveryTransport) {
  if (provider !== 'meta') throw new Error('AD_PLATFORM_LEGACY_CHANNEL_UNAVAILABLE')
  return transport === 'browser' ? 'meta_pixel' as const : 'meta_capi' as const
}

