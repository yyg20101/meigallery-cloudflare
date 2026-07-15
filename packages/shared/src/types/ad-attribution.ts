export type AdAttributionProvider = 'meta' | 'tiktok' | 'google'

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

export interface PlatformEventDescriptor {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  browserEventName: string
  browserDestination: string
  serverDestination: string
}

export interface AdBrowserInstruction {
  provider: AdAttributionProvider
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  descriptor: PlatformEventDescriptor
  payload: Record<string, string | number | boolean>
}
