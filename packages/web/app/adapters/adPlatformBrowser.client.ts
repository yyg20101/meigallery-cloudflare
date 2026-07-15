import type {
  AdAttributionProvider,
  AdBrowserInstruction,
  AdBrowserSignal,
  AdConsentSnapshot,
  PlatformPublicConfig,
} from '@meigallery/shared'
import { googleAdsAdapter } from './googleAds.client'
import { metaPixelAdapter } from './metaPixel.client'
import { tiktokPixelAdapter } from './tiktokPixel.client'

type BrowserEventPayload = Record<string, string | number | boolean>

export interface BrowserTrackingAdapter {
  initialize(config: PlatformPublicConfig, consent: AdConsentSnapshot): Promise<boolean>
  track(instruction: AdBrowserInstruction): Promise<boolean>
  trackSignal(signal: AdBrowserSignal, payload: BrowserEventPayload): Promise<boolean>
  teardown(): Promise<void>
}

const adapters: ReadonlyMap<AdAttributionProvider, BrowserTrackingAdapter> = new Map([
  ['meta', metaPixelAdapter],
  ['tiktok', tiktokPixelAdapter],
  ['google', googleAdsAdapter],
])

let activeProvider: AdAttributionProvider | null = null

export async function initializeAdBrowserProvider(config: PlatformPublicConfig, consent: AdConsentSnapshot) {
  if (!consent.marketingAllowed) {
    await teardownAllAdBrowserProviders()
    return false
  }
  const adapter = adapters.get(config.provider)
  if (!adapter) return false
  if (activeProvider && activeProvider !== config.provider) await teardownAllAdBrowserProviders()
  const initialized = await adapter.initialize(config, consent)
  activeProvider = initialized ? config.provider : null
  return initialized
}

export async function executeAdBrowserInstruction(instruction: AdBrowserInstruction) {
  if (instruction.provider !== activeProvider) return false
  return adapters.get(instruction.provider)?.track(instruction) ?? false
}

export async function trackAdBrowserSignal(
  provider: AdAttributionProvider,
  signal: AdBrowserSignal,
  payload: BrowserEventPayload,
) {
  if (provider !== activeProvider) return false
  return adapters.get(provider)?.trackSignal(signal, payload) ?? false
}

export async function teardownAllAdBrowserProviders() {
  const provider = activeProvider
  activeProvider = null
  if (provider) await adapters.get(provider)?.teardown()
}

export function isRegisteredAdBrowserProvider(value: unknown): value is AdAttributionProvider {
  return typeof value === 'string' && adapters.has(value as AdAttributionProvider)
}
