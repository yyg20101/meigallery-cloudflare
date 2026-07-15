import type {
  ActiveConversionActionType,
  AdDeliveryTransport,
  AdAttributionProvider,
  PlatformEventDescriptor,
} from '@meigallery/shared'

export interface AdPlatformAdapterDefinition {
  provider: AdAttributionProvider
  eventDescriptors: Readonly<Record<ActiveConversionActionType, PlatformEventDescriptor>>
  transports: readonly AdDeliveryTransport[]
}

const META_ADAPTER: AdPlatformAdapterDefinition = {
  provider: 'meta',
  eventDescriptors: {
    contact: {
      provider: 'meta',
      canonicalEvent: 'Contact',
      browserEventName: 'Contact',
      browserDestination: 'meta_pixel',
      serverDestination: 'meta_capi',
    },
    complete_registration: {
      provider: 'meta',
      canonicalEvent: 'CompleteRegistration',
      browserEventName: 'CompleteRegistration',
      browserDestination: 'meta_pixel',
      serverDestination: 'meta_capi',
    },
  },
  transports: ['browser', 'server'],
}

const TIKTOK_ADAPTER: AdPlatformAdapterDefinition = {
  provider: 'tiktok',
  eventDescriptors: {
    contact: {
      provider: 'tiktok',
      canonicalEvent: 'Contact',
      browserEventName: 'Contact',
      browserDestination: 'tiktok_pixel',
      serverDestination: 'tiktok_events_api',
    },
    complete_registration: {
      provider: 'tiktok',
      canonicalEvent: 'CompleteRegistration',
      browserEventName: 'CompleteRegistration',
      browserDestination: 'tiktok_pixel',
      serverDestination: 'tiktok_events_api',
    },
  },
  transports: ['browser', 'server'],
}

const GOOGLE_ADAPTER: AdPlatformAdapterDefinition = {
  provider: 'google',
  eventDescriptors: {
    contact: {
      provider: 'google',
      canonicalEvent: 'Contact',
      browserEventName: 'conversion',
      browserDestination: 'contact',
      serverDestination: 'contact',
    },
    complete_registration: {
      provider: 'google',
      canonicalEvent: 'CompleteRegistration',
      browserEventName: 'conversion',
      browserDestination: 'complete_registration',
      serverDestination: 'complete_registration',
    },
  },
  transports: ['browser', 'server'],
}

const ADAPTERS: ReadonlyMap<AdAttributionProvider, AdPlatformAdapterDefinition> = new Map([
  [META_ADAPTER.provider, META_ADAPTER],
  [TIKTOK_ADAPTER.provider, TIKTOK_ADAPTER],
  [GOOGLE_ADAPTER.provider, GOOGLE_ADAPTER],
])

export function getAdPlatformAdapter(provider: AdAttributionProvider) {
  const adapter = ADAPTERS.get(provider)
  if (!adapter) throw new Error(`AD_PLATFORM_ADAPTER_NOT_REGISTERED:${provider}`)
  return adapter
}

export function hasAdPlatformAdapter(provider: unknown): provider is AdAttributionProvider {
  return typeof provider === 'string' && ADAPTERS.has(provider as AdAttributionProvider)
}

export function listAdPlatformProviders(): AdAttributionProvider[] {
  return [...ADAPTERS.keys()]
}

export function mapConversionToPlatformEvent(
  provider: AdAttributionProvider,
  actionType: ActiveConversionActionType,
) {
  return getAdPlatformAdapter(provider).eventDescriptors[actionType]
}
