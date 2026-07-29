import type {
  AdAttributionProvider,
  AdBrowserEvent,
  AdBrowserPublicConfig,
  AdBrowserInstruction,
  AdBrowserSignal,
} from '@meigallery/shared'
import { googleAdsAdapter } from './googleAds.client'
import { metaPixelAdapter } from './metaPixel.client'
import { tiktokPixelAdapter } from './tiktokPixel.client'

type BrowserEventPayload = Record<string, string | number | boolean>

export interface BrowserTrackingAdapter {
  initialize(config: AdBrowserPublicConfig): Promise<boolean>
  track(event: AdBrowserEvent): Promise<boolean>
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

export async function initializeAdBrowserProvider(config: AdBrowserPublicConfig) {
  return serializeLifecycle(async () => {
    const adapter = adapters.get(config.provider)
    if (!adapter) return false
    if (activeProvider && activeProvider !== config.provider) await teardownActiveProvider()
    try {
      const initialized = await adapter.initialize(config)
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

export async function executeAdBrowserInstruction(instruction: AdBrowserInstruction) {
  return dispatchAdBrowserEvent({
    provider: instruction.provider,
    canonicalEvent: instruction.canonicalEvent,
    externalEventId: instruction.externalEventId,
    browserEventName: instruction.descriptor.browserEventName,
    browserDestination: instruction.descriptor.browserDestination,
    payload: instruction.payload,
  })
}

/**
 * 联系外链可能立即让页面进入后台，调用 adapter 时不得排队等待异步生命周期。
 * adapter 的 Pixel 入队动作会在本函数返回 Promise 前同步执行。
 */
export function dispatchAdBrowserEvent(event: AdBrowserEvent): Promise<boolean> {
  if (event.provider !== activeProvider) return Promise.resolve(false)
  try {
    return (adapters.get(event.provider)?.track(event) ?? Promise.resolve(false))
      .catch(() => false)
  }
  catch {
    return Promise.resolve(false)
  }
}

export async function trackAdBrowserSignal(
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

export async function teardownAllAdBrowserProviders() {
  return serializeLifecycle(teardownActiveProvider)
}

async function teardownActiveProvider() {
  const provider = activeProvider
  activeProvider = null
  if (provider) await safeTeardown(adapters.get(provider))
}

export function isRegisteredAdBrowserProvider(value: unknown): value is AdAttributionProvider {
  return typeof value === 'string' && adapters.has(value as AdAttributionProvider)
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
