export const AD_ATTRIBUTION_PROVIDERS = [
  'meta',
  'tiktok',
  'google',
] as const

export type AdAttributionProvider = typeof AD_ATTRIBUTION_PROVIDERS[number]

export const AD_ATTRIBUTION_IDENTIFIER_KEYS: Readonly<
  Record<AdAttributionProvider, readonly string[]>
> = {
  meta: ['fbclid'],
  tiktok: ['ttclid'],
  google: ['gclid', 'gbraid', 'wbraid'],
}

export function isAdAttributionProvider(
  value: unknown,
): value is AdAttributionProvider {
  return typeof value === 'string'
    && AD_ATTRIBUTION_PROVIDERS.some(provider => provider === value)
}

export type CanonicalConversionEvent = 'Contact' | 'CompleteRegistration'

export type AdBrowserSignal = 'PageView' | 'ViewContent' | 'Search'

export type PlatformPublicConfig =
  | { provider: 'meta'; pixelId: string }
  | { provider: 'tiktok'; pixelCode: string }
  | {
      provider: 'google'
      tagId: string
      customerId: string
      loginCustomerId?: string
      cloudProjectId: string
    }

export type AdBrowserPublicConfig =
  | { provider: 'meta'; pixelId: string }
  | { provider: 'tiktok'; pixelCode: string }
  | { provider: 'google'; tagId: string }

export interface PlatformEventDescriptor {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  browserEventName: string
  browserDestination: string
  serverDestination: string
}

export interface AdBrowserEventTemplate {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  browserEventName: string
  browserDestination: string
}

export interface AdBrowserEvent extends AdBrowserEventTemplate {
  externalEventId: string
  payload: Record<string, string | number | boolean>
}

export interface AdBrowserInstruction {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  descriptor: PlatformEventDescriptor
  payload: Record<string, string | number | boolean>
}
