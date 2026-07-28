import type { Bindings } from '../index'
import {
  resolveAdAttributionRouting,
  type AdAttributionResolution,
  type AdAttributionSignals,
} from '../services/ad-attribution-routing'
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

export interface RequestAdAttributionResult {
  context: AdAttributionContext | null
  resolution: AdAttributionResolution
}

/**
 * 当前请求中的官方 click ID 或 active 受管链接属于明确新来源，统一经过中央
 * 路由器并覆盖历史 Cookie。没有新来源时继承可信 Cookie；Cookie 缺失时才使用
 * 站内已归一化的受管来源恢复，不接受 provider 声明或普通 UTM。
 */
export async function resolveRequestAdAttribution(
  env: AttributionContextEnv,
  encryptedCookie: string | undefined,
  fallback: Record<string, unknown> = {},
  persistedTrackingSourceSlug?: unknown,
): Promise<RequestAdAttributionResult> {
  try {
    const keys = await loadAttributionCryptoKeys(env)
    const existing = await resolveTrustedAdAttributionContext(keys, encryptedCookie)
    const explicitSignals = pickAdAttributionSignals(fallback)
    if (!hasExplicitSignals(explicitSignals)) {
      if (existing) {
        return { context: existing, resolution: 'inherited' }
      }
      explicitSignals.trackingSourceSlug = persistedTrackingSourceSlug
    }
    const routed = await resolveAdAttributionRouting(
      env.DB,
      explicitSignals,
      existing?.provider ?? null,
    )
    if (routed.resolution === 'inherited' && existing) {
      return { context: existing, resolution: 'inherited' }
    }
    if (routed.resolution !== 'matched' || !routed.provider || !routed.source) {
      return { context: null, resolution: routed.resolution }
    }

    return {
      context: createAdAttributionContext({
        provider: routed.provider,
        source: routed.source,
        identifiers: routed.identifiers,
      }),
      resolution: 'matched',
    }
  }
  catch {
    console.error('[ad-attribution.resolve] 请求来源解析失败', {
      code: 'AD_ATTRIBUTION_REQUEST_RESOLUTION_FAILED',
    })
    return { context: null, resolution: 'none' }
  }
}

function pickAdAttributionSignals(input: Record<string, unknown>): AdAttributionSignals {
  return {
    fbclid: input.fbclid,
    ttclid: input.ttclid,
    gclid: input.gclid,
    gbraid: input.gbraid,
    wbraid: input.wbraid,
    trackingSourceSlug: input.trackingSourceSlug,
  }
}

function hasExplicitSignals(signals: AdAttributionSignals) {
  return Object.values(signals).some(value => (
    value !== undefined
    && value !== null
    && value !== ''
  ))
}
