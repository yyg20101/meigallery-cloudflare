import type { AdBrowserInstruction } from '@meigallery/shared'
import { metaPixelAdapter } from './metaPixel.client'
import { tiktokPixelAdapter } from './tiktokPixel.client'

type BrowserEventPayload = Record<string, string | number | boolean>

type BrowserAdapter = {
  initialize: (destinationId: string) => boolean
  pageView: () => boolean
  teardown: () => void
  standardEvent: (eventName: string, payload?: BrowserEventPayload, eventId?: string) => boolean
  execute: (instruction: AdBrowserInstruction) => boolean
}

const adapters = {
  meta: {
    initialize: destinationId => metaPixelAdapter.initialize(destinationId),
    pageView: () => metaPixelAdapter.pageView(),
    teardown: () => metaPixelAdapter.teardown(),
    standardEvent: (eventName, payload, eventId) => eventId
      ? metaPixelAdapter.standardEvent(
          eventName as 'Contact' | 'CompleteRegistration',
          payload,
          { eventID: eventId },
        )
      : metaPixelAdapter.standardEvent(eventName as 'Contact' | 'CompleteRegistration', payload),
    execute: instruction => metaPixelAdapter.standardEvent(
      instruction.eventName as 'Contact' | 'CompleteRegistration',
      instruction.payload,
      { eventID: instruction.eventId },
    ),
  },
  tiktok: {
    initialize: destinationId => tiktokPixelAdapter.initialize(destinationId),
    pageView: () => tiktokPixelAdapter.pageView(),
    teardown: () => tiktokPixelAdapter.teardown(),
    standardEvent: (eventName, payload, eventId) => tiktokPixelAdapter.standardEvent(eventName, payload, eventId),
    execute: instruction => tiktokPixelAdapter.standardEvent(
      instruction.eventName,
      instruction.payload,
      instruction.eventId,
    ),
  },
} satisfies Partial<Record<AdBrowserInstruction['provider'], BrowserAdapter>>

type RegisteredBrowserProvider = keyof typeof adapters

export function executeAdBrowserInstruction(instruction: AdBrowserInstruction) {
  return browserAdapter(instruction.provider)?.execute(instruction) ?? false
}

export function initializeAdBrowserProvider(provider: AdBrowserInstruction['provider'], destinationId: string) {
  return browserAdapter(provider)?.initialize(destinationId) ?? false
}

export function trackAdBrowserPageView(provider: AdBrowserInstruction['provider']) {
  return browserAdapter(provider)?.pageView() ?? false
}

export function trackAdBrowserStandardEvent(
  provider: AdBrowserInstruction['provider'],
  eventName: string,
  payload?: BrowserEventPayload,
  eventId?: string,
) {
  return browserAdapter(provider)?.standardEvent(eventName, payload, eventId) ?? false
}

export function teardownAllAdBrowserProviders() {
  for (const adapter of Object.values(adapters)) adapter.teardown()
}

export function isRegisteredAdBrowserProvider(value: unknown): value is RegisteredBrowserProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(adapters, value)
}

function browserAdapter(provider: AdBrowserInstruction['provider']): BrowserAdapter | undefined {
  return isRegisteredAdBrowserProvider(provider) ? adapters[provider] : undefined
}
