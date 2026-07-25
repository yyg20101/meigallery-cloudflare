import type { AdConsentSnapshot } from '@meigallery/shared'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Bindings, Variables } from '../index'
import { AD_ATTRIBUTION_CONTEXT_COOKIE } from '../utils/ad-attribution-cookie'
import { resolveTrustedAdAttributionContext } from '../utils/ad-attribution-context'
import {
  buildAdPlatformUserData,
  readAdPlatformBrowserIdentifiersFromRequest,
} from '../utils/ad-platform-identifiers'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import type {
  AttributionLegacyRegistrationDispatcher,
} from './attribution-business-outbox'
import { recordRegistration } from './conversions'

export interface LegacyRegistrationDispatchInput {
  userId: number
  visitorId: string
  sessionId: string
  occurredAt: string
  routeName?: string
  pagePath: string
  sourceChannel?: string
  sourceName?: string
  trackingSourceSlug?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  consentSnapshot: AdConsentSnapshot
  hashedEmail?: string
}

/**
 * Task 5 切换桥：只有业务 outbox claim 成功且 owner=old 时才调用旧写者。
 * 最终切换完成后由 Task 8 连同旧归因运行时整体删除。
 */
export function createLegacyRegistrationOutboxDispatcher(
  context: Context<{
    Bindings: Bindings
    Variables: Variables
  }>,
  input: LegacyRegistrationDispatchInput,
): AttributionLegacyRegistrationDispatcher {
  return async (_event, ownership) => {
    const attributionContext = input.consentSnapshot.marketingAllowed
      ? await trustedLegacyContext(context)
      : null
    await recordRegistration(context.env, {
      userId: input.userId,
      visitorId: input.visitorId,
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
      routeName: input.routeName,
      path: input.pagePath,
      sourceChannel: input.sourceChannel,
      sourceName: input.sourceName,
      trackingSourceSlug: input.trackingSourceSlug,
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      utmContent: input.utmContent,
      consentSnapshot: input.consentSnapshot,
      attributionContext,
      attributionSource: attributionContext ? 'context' : 'none',
      adPlatformUserData: input.consentSnapshot.marketingAllowed
        ? buildAdPlatformUserData(
            context.req.raw,
            readAdPlatformBrowserIdentifiersFromRequest(context.req.raw),
          )
        : undefined,
      hashedEmail: input.hashedEmail,
      metadata: { method: 'email' },
    }, ownership)
  }
}

async function trustedLegacyContext(
  context: Context<{
    Bindings: Bindings
    Variables: Variables
  }>,
) {
  try {
    const keys = await loadAttributionCryptoKeys(context.env)
    return await resolveTrustedAdAttributionContext(
      keys,
      getCookie(context, AD_ATTRIBUTION_CONTEXT_COOKIE),
    )
  } catch {
    return null
  }
}
