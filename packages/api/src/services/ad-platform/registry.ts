import type {
  ActiveConversionActionType,
  AdAttributionProvider,
  AdDeliveryTransport,
  CanonicalConversionEvent,
  PlatformEventDescriptor,
} from '@meigallery/shared'

export interface CanonicalEventInput {
  canonicalEvent: CanonicalConversionEvent
}

export interface AdPlatformCapabilities {
  transports: readonly AdDeliveryTransport[]
  credentialType: 'access_token' | 'service_account_json'
}

export interface PlatformConfigSchema {
  parse(value: unknown): Record<string, unknown> | null
}

export interface PlatformCredentialSchema {
  version: number
  type: 'access_token' | 'service_account_json'
}

export interface AdPlatformDefinition {
  provider: AdAttributionProvider
  capabilities: AdPlatformCapabilities
  publicConfigSchema: PlatformConfigSchema
  credentialSchema: PlatformCredentialSchema
  describeEvent(input: CanonicalEventInput): PlatformEventDescriptor | null
}

function objectSchema(required: readonly string[]): PlatformConfigSchema {
  return {
    parse(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const record = value as Record<string, unknown>
      return required.every(key => typeof record[key] === 'string' && String(record[key]).trim()) ? record : null
    },
  }
}

function definition(input: Omit<AdPlatformDefinition, 'describeEvent'> & {
  events: Readonly<Record<CanonicalConversionEvent, Omit<PlatformEventDescriptor, 'provider' | 'canonicalEvent'>>>
}): AdPlatformDefinition {
  return {
    provider: input.provider,
    capabilities: input.capabilities,
    publicConfigSchema: input.publicConfigSchema,
    credentialSchema: input.credentialSchema,
    describeEvent({ canonicalEvent }) {
      const event = input.events[canonicalEvent]
      return event ? { provider: input.provider, canonicalEvent, ...event } : null
    },
  }
}

const DEFINITIONS: ReadonlyMap<AdAttributionProvider, AdPlatformDefinition> = new Map([
  ['meta', definition({
    provider: 'meta', capabilities: { transports: ['browser', 'server'], credentialType: 'access_token' },
    publicConfigSchema: objectSchema(['pixelId']), credentialSchema: { version: 1, type: 'access_token' },
    events: {
      Contact: { browserEventName: 'Contact', browserDestination: 'meta_pixel', serverDestination: 'meta_capi' },
      CompleteRegistration: { browserEventName: 'CompleteRegistration', browserDestination: 'meta_pixel', serverDestination: 'meta_capi' },
    },
  })],
  ['tiktok', definition({
    provider: 'tiktok', capabilities: { transports: ['browser', 'server'], credentialType: 'access_token' },
    publicConfigSchema: objectSchema(['pixelCode']), credentialSchema: { version: 1, type: 'access_token' },
    events: {
      Contact: { browserEventName: 'Contact', browserDestination: 'tiktok_pixel', serverDestination: 'tiktok_events_api' },
      CompleteRegistration: { browserEventName: 'CompleteRegistration', browserDestination: 'tiktok_pixel', serverDestination: 'tiktok_events_api' },
    },
  })],
  ['google', definition({
    provider: 'google', capabilities: { transports: ['browser', 'server'], credentialType: 'service_account_json' },
    publicConfigSchema: objectSchema(['tagId', 'customerId', 'cloudProjectId']), credentialSchema: { version: 1, type: 'service_account_json' },
    events: {
      Contact: { browserEventName: 'conversion', browserDestination: 'contact', serverDestination: 'contact' },
      CompleteRegistration: { browserEventName: 'conversion', browserDestination: 'complete_registration', serverDestination: 'complete_registration' },
    },
  })],
])

export function getAdPlatformDefinition(provider: unknown): AdPlatformDefinition | null {
  return typeof provider === 'string' ? DEFINITIONS.get(provider as AdAttributionProvider) ?? null : null
}

export function hasAdPlatformAdapter(provider: unknown): provider is AdAttributionProvider {
  return getAdPlatformDefinition(provider) !== null
}

export function listAdPlatformProviders(): AdAttributionProvider[] {
  return [...DEFINITIONS.keys()]
}

export function getAdPlatformAdapter(provider: AdAttributionProvider) {
  const definition = getAdPlatformDefinition(provider)
  if (!definition) throw new Error(`AD_PLATFORM_ADAPTER_NOT_REGISTERED:${provider}`)
  return {
    ...definition,
    transports: definition.capabilities.transports,
    eventDescriptors: Object.fromEntries((['contact', 'complete_registration'] as const).map(actionType => [
      actionType,
      mapConversionToPlatformEvent(provider, actionType),
    ])),
  }
}

export function mapConversionToPlatformEvent(provider: AdAttributionProvider, actionType: ActiveConversionActionType) {
  const event: CanonicalConversionEvent = actionType === 'contact' ? 'Contact' : 'CompleteRegistration'
  const descriptor = getAdPlatformDefinition(provider)?.describeEvent({ canonicalEvent: event })
  if (!descriptor) throw new Error(`AD_PLATFORM_EVENT_NOT_REGISTERED:${provider}:${actionType}`)
  return descriptor
}
