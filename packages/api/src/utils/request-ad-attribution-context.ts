import type { Bindings } from '../index'
import { resolveAdAttributionRouting } from '../services/ad-attribution-routing'
import {
  createAdAttributionContext,
  resolveTrustedAdAttributionContext,
  type AdAttributionContext,
} from './ad-attribution-context'
import { loadAttributionCryptoKeys } from './attribution-crypto'

type AttributionContextEnv = Pick<
  Bindings,
  'DB' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS'
>

/**
 * Cookie 是首选来源。Cookie 偶发缺失时，仅允许同一服务端路由器根据当前官方
 * click ID 或 active 受管广告链接恢复，不接受 provider 声明或普通 UTM。
 */
export async function resolveRequestAdAttributionContext(
  env: AttributionContextEnv,
  encryptedCookie: string | undefined,
  fallback: Record<string, unknown> = {},
  persistedTrackingSourceSlug?: unknown,
): Promise<AdAttributionContext | null> {
  try {
    const keys = await loadAttributionCryptoKeys(env)
    const existing = await resolveTrustedAdAttributionContext(keys, encryptedCookie)
    if (existing) return existing

    const signals = { ...fallback }
    if (signals.trackingSourceSlug === undefined || signals.trackingSourceSlug === '') {
      signals.trackingSourceSlug = persistedTrackingSourceSlug
    }
    const routed = await resolveAdAttributionRouting(env.DB, signals, null)
    if (routed.resolution !== 'matched' || !routed.provider || !routed.source) return null

    return createAdAttributionContext({
      provider: routed.provider,
      source: routed.source,
      identifiers: routed.identifiers,
    })
  }
  catch {
    return null
  }
}
