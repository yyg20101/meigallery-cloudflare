import type { ActiveConversionActionType, AdAttributionProvider, AdDeliveryTransport, CanonicalConversionEvent, PlatformEventDescriptor } from '@meigallery/shared'

export interface CanonicalEventInput { canonicalEvent: CanonicalConversionEvent }
export interface AdPlatformCapabilities { transports: readonly AdDeliveryTransport[]; credentialType: 'access_token' | 'service_account_json' }
export interface PlatformConfigSchema { parse(value: unknown): Record<string, string> | null }
export interface PlatformCredentialSchema { version: number; type: 'access_token' | 'service_account_json' }
export interface PlatformMatchSignalsInput {
  contextIdentifiers: Record<string, string>
  contextIssuedAt: number
  browserIdentifiers: { fbp?: string; fbc?: string; ttclid?: string; ttp?: string }
}
export interface AdPlatformDefinition {
  provider: AdAttributionProvider
  capabilities: AdPlatformCapabilities
  publicConfigSchema: PlatformConfigSchema
  credentialSchema: PlatformCredentialSchema
  describeEvent(input: CanonicalEventInput): PlatformEventDescriptor | null
  matchSignals(input: PlatformMatchSignalsInput): Record<string, string>
}

function objectSchema(required: readonly string[], optional: readonly string[] = []): PlatformConfigSchema {
  const allowed = new Set([...required, ...optional])
  return { parse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (!keys.every(key => allowed.has(key)) || !required.every(key => validText(record[key]))) return null
    if (!optional.every(key => record[key] === undefined || validText(record[key]))) return null
    return Object.fromEntries(keys.map(key => [key, String(record[key]).trim()]))
  } }
}

function definition(input: Omit<AdPlatformDefinition, 'describeEvent'> & { events: Readonly<Record<CanonicalConversionEvent, Omit<PlatformEventDescriptor, 'provider' | 'canonicalEvent'>>> }): AdPlatformDefinition {
  return { ...input, describeEvent({ canonicalEvent }) { const event = input.events[canonicalEvent]; return event ? { provider: input.provider, canonicalEvent, ...event } : null } }
}

const DEFINITIONS: ReadonlyMap<AdAttributionProvider, AdPlatformDefinition> = new Map([
  ['meta', definition({
    provider: 'meta', capabilities: { transports: ['browser', 'server'], credentialType: 'access_token' }, publicConfigSchema: objectSchema(['pixelId']), credentialSchema: { version: 1, type: 'access_token' },
    events: { Contact: { browserEventName: 'Contact', browserDestination: 'meta_pixel', serverDestination: 'meta_capi' }, CompleteRegistration: { browserEventName: 'CompleteRegistration', browserDestination: 'meta_pixel', serverDestination: 'meta_capi' } },
    matchSignals({ contextIdentifiers, contextIssuedAt, browserIdentifiers }) {
      const fbclid = contextIdentifiers.fbclid
      return compact({ fbp: browserIdentifiers.fbp, fbc: browserIdentifiers.fbc || (validText(fbclid) ? `fb.1.${contextIssuedAt * 1000}.${fbclid}` : '') })
    },
  })],
  ['tiktok', definition({
    provider: 'tiktok', capabilities: { transports: ['browser', 'server'], credentialType: 'access_token' }, publicConfigSchema: objectSchema(['pixelCode']), credentialSchema: { version: 1, type: 'access_token' },
    events: { Contact: { browserEventName: 'Contact', browserDestination: 'tiktok_pixel', serverDestination: 'tiktok_events_api' }, CompleteRegistration: { browserEventName: 'CompleteRegistration', browserDestination: 'tiktok_pixel', serverDestination: 'tiktok_events_api' } },
    matchSignals({ contextIdentifiers, browserIdentifiers }) { return compact({ ttclid: contextIdentifiers.ttclid || browserIdentifiers.ttclid, ttp: browserIdentifiers.ttp }) },
  })],
  ['google', definition({
    provider: 'google', capabilities: { transports: ['browser', 'server'], credentialType: 'service_account_json' }, publicConfigSchema: objectSchema(['tagId', 'customerId', 'cloudProjectId'], ['loginCustomerId']), credentialSchema: { version: 1, type: 'service_account_json' },
    events: { Contact: { browserEventName: 'conversion', browserDestination: 'contact', serverDestination: 'contact' }, CompleteRegistration: { browserEventName: 'conversion', browserDestination: 'complete_registration', serverDestination: 'complete_registration' } },
    matchSignals({ contextIdentifiers }) { return compact({ gclid: contextIdentifiers.gclid, gbraid: contextIdentifiers.gbraid, wbraid: contextIdentifiers.wbraid }) },
  })],
])

export function getAdPlatformDefinition(provider: unknown): AdPlatformDefinition | null { return typeof provider === 'string' ? DEFINITIONS.get(provider as AdAttributionProvider) ?? null : null }
export function hasAdPlatformAdapter(provider: unknown): provider is AdAttributionProvider { return getAdPlatformDefinition(provider) !== null }
export function listAdPlatformProviders(): AdAttributionProvider[] { return [...DEFINITIONS.keys()] }
export function getAdPlatformAdapter(provider: AdAttributionProvider) { const item = getAdPlatformDefinition(provider); if (!item) throw new Error(`AD_PLATFORM_ADAPTER_NOT_REGISTERED:${provider}`); return { ...item, transports: item.capabilities.transports, eventDescriptors: Object.fromEntries((['contact', 'complete_registration'] as const).map(actionType => [actionType, mapConversionToPlatformEvent(provider, actionType)])) } }
export function mapConversionToPlatformEvent(provider: AdAttributionProvider, actionType: ActiveConversionActionType) { const canonicalEvent: CanonicalConversionEvent = actionType === 'contact' ? 'Contact' : 'CompleteRegistration'; const descriptor = getAdPlatformDefinition(provider)?.describeEvent({ canonicalEvent }); if (!descriptor) throw new Error(`AD_PLATFORM_EVENT_NOT_REGISTERED:${provider}:${actionType}`); return descriptor }
function compact(input: Record<string, string | undefined>): Record<string, string> { return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => validText(entry[1]))) }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_000 && !/\p{Cc}/u.test(value) }
