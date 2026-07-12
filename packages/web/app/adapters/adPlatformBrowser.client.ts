import type { AdBrowserInstruction } from '@meigallery/shared'
import { metaPixelAdapter } from './metaPixel.client'

type BrowserEventPayload = Record<string, string | number | boolean>

type BrowserAdapter = {
  initialize: (destinationId: string) => boolean
  pageView: () => boolean
  teardown: () => void
  standardEvent: (eventName: string, payload?: BrowserEventPayload, eventId?: string) => boolean
  execute: (instruction: AdBrowserInstruction) => boolean
}

const adapters: Partial<Record<AdBrowserInstruction['provider'], BrowserAdapter>> = {
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
}

export function executeAdBrowserInstruction(instruction: AdBrowserInstruction) {
  return adapters[instruction.provider]?.execute(instruction) ?? false
}

export function initializeAdBrowserProvider(provider: AdBrowserInstruction['provider'], destinationId: string) {
  return adapters[provider]?.initialize(destinationId) ?? false
}

export function trackAdBrowserPageView(provider: AdBrowserInstruction['provider']) {
  return adapters[provider]?.pageView() ?? false
}

export function trackAdBrowserStandardEvent(
  provider: AdBrowserInstruction['provider'],
  eventName: string,
  payload?: BrowserEventPayload,
  eventId?: string,
) {
  return adapters[provider]?.standardEvent(eventName, payload, eventId) ?? false
}

export function teardownAdBrowserProvider(provider: AdBrowserInstruction['provider']) {
  adapters[provider]?.teardown()
}
