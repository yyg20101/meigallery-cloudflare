import type {
  AdAttributionProvider,
  AdBrowserPublicConfig,
  AdBrowserSignal,
  AdConsentSnapshot,
  AttributionBrowserInstructionV1,
} from '@meigallery/shared'
import { googleAdsAdapter } from './googleAds.client'
import { metaPixelAdapter } from './metaPixel.client'
import { tiktokPixelAdapter } from './tiktokPixel.client'

type BrowserEventPayload = Record<string, string | number | boolean>

export interface BrowserTrackingAdapter {
  initialize(config: AdBrowserPublicConfig, consent: AdConsentSnapshot): Promise<boolean>
  track(instruction: AttributionBrowserInstructionV1): Promise<boolean>
  trackSignal(signal: AdBrowserSignal, payload: BrowserEventPayload): Promise<boolean>
  teardown(): Promise<void>
}

const adapters: ReadonlyMap<AdAttributionProvider, BrowserTrackingAdapter> = new Map([
  ['meta', metaPixelAdapter],
  ['tiktok', tiktokPixelAdapter],
  ['google', googleAdsAdapter],
])

let activeProvider: AdAttributionProvider | null = null
let lifecycleQueue: Promise<void> = Promise.resolve()

export async function initializeBrowserTrackingProvider(config: AdBrowserPublicConfig, consent: AdConsentSnapshot) {
  return serializeLifecycle(async () => {
    if (!consent.marketingAllowed) {
      await teardownActiveProvider()
      return false
    }

    const adapter = adapters.get(config.provider)
    if (!adapter) return false
    if (activeProvider && activeProvider !== config.provider) await teardownActiveProvider()

    try {
      const initialized = await adapter.initialize(config, consent)
      if (!initialized) {
        activeProvider = null
        await safeTeardown(adapter)
        return false
      }
      activeProvider = config.provider
      return true
    }
    catch {
      activeProvider = null
      await safeTeardown(adapter)
      return false
    }
  })
}

export async function executeBrowserTrackingInstruction(
  instruction: AttributionBrowserInstructionV1,
) {
  return serializeLifecycle(async () => {
    if (instruction.provider !== activeProvider) return false
    try {
      return await adapters.get(instruction.provider)?.track(instruction) ?? false
    }
    catch {
      return false
    }
  })
}

export async function trackBrowserTrackingSignal(
  provider: AdAttributionProvider,
  signal: AdBrowserSignal,
  payload: BrowserEventPayload,
) {
  return serializeLifecycle(async () => {
    if (provider !== activeProvider) return false
    try {
      return await adapters.get(provider)?.trackSignal(signal, payload) ?? false
    }
    catch {
      return false
    }
  })
}

export async function teardownBrowserTrackingProviders() {
  return serializeLifecycle(teardownActiveProvider)
}

export function isRegisteredBrowserTrackingProvider(value: unknown): value is AdAttributionProvider {
  return typeof value === 'string' && adapters.has(value as AdAttributionProvider)
}

async function teardownActiveProvider() {
  const provider = activeProvider
  activeProvider = null
  if (provider) await safeTeardown(adapters.get(provider))
}

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const task = lifecycleQueue.then(operation, operation)
  lifecycleQueue = task.then(() => undefined, () => undefined)
  return task
}

async function safeTeardown(adapter: BrowserTrackingAdapter | undefined) {
  try {
    await adapter?.teardown()
  }
  catch {
    // 卸载失败不能恢复 active provider，后续投递继续 fail closed。
  }
}
