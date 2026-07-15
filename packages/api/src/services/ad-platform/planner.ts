import type { AdAttributionProvider, AdBrowserInstruction, CanonicalConversionEvent } from '@meigallery/shared'
import { buildAdExternalEventIdFromKey } from '@meigallery/shared/utils'
import { deriveAttributionHmacKey, type AttributionCryptoKeys } from '../../utils/attribution-crypto'
import type { AttributionConnectionSnapshot } from './connections'
import { issueBrowserAttemptReceiptToken } from './browser-attempt-receipt'
import { getAdPlatformDefinition } from './registry'

export interface PlannedAttributionDelivery {
  id: string
  provider: AdAttributionProvider
  transport: 'browser' | 'server'
  destination: string
  externalEventId: string
  matchSignals: Record<string, string>
  browserInstruction?: AdBrowserInstruction
}

export interface AttributionDeliveryPlan { externalEventId: string; deliveries: PlannedAttributionDelivery[]; rolloutBucket: number | null }

export async function buildAttributionDeliveryPlan(input: {
  factId: string
  provider: unknown
  canonicalEvent: CanonicalConversionEvent
  consentGranted: boolean
  sourceAvailable: boolean
  stableId: string
  serverAllowed?: boolean
  cryptoKeys?: AttributionCryptoKeys
  eventKey?: CryptoKey
  matchSignals?: Record<string, string>
  connection: AttributionConnectionSnapshot
}): Promise<AttributionDeliveryPlan> {
  const eventKey = input.eventKey ?? (input.cryptoKeys ? await deriveAttributionHmacKey({ keys: input.cryptoKeys, purpose: 'event_id' }) : null)
  if (!eventKey) throw new Error('ATTRIBUTION_EVENT_KEY_UNAVAILABLE')
  const externalEventId = await buildAdExternalEventIdFromKey(eventKey, input.factId, input.canonicalEvent)
  const definition = getAdPlatformDefinition(input.provider)
  if (!definition || !input.consentGranted || !input.sourceAvailable || input.connection.state !== 'ready') return { externalEventId, deliveries: [], rolloutBucket: null }
  const { connection, bindings } = input.connection
  const descriptor = definition.describeEvent({ canonicalEvent: input.canonicalEvent })
  const binding = bindings.get(input.canonicalEvent)
  if (!descriptor || !binding || !binding.enabled || !connection.enabled || connection.mode === 'disabled') return { externalEventId, deliveries: [], rolloutBucket: null }
  const boundDescriptor = {
    ...descriptor,
    browserDestination: binding.browserDestination,
    serverDestination: binding.serverDestination,
  }
  const deliveries: PlannedAttributionDelivery[] = []
  if (connection.browserEnabled && definition.capabilities.transports.includes('browser')) {
    if (!input.cryptoKeys) throw new Error('ATTRIBUTION_RECEIPT_KEY_UNAVAILABLE')
    const deliveryId = crypto.randomUUID()
    deliveries.push({
      id: deliveryId, provider: connection.provider, transport: 'browser', destination: binding.browserDestination, externalEventId, matchSignals: {},
      browserInstruction: {
        deliveryId,
        provider: connection.provider,
        canonicalEvent: input.canonicalEvent,
        externalEventId,
        receiptToken: await issueBrowserAttemptReceiptToken(input.cryptoKeys, {
          deliveryId,
          provider: connection.provider,
          externalEventId,
        }),
        descriptor: boundDescriptor,
        payload: {},
      },
    })
  }
  const rolloutBucket = input.stableId.trim() ? await attributionPlannerRolloutBucket(`${connection.id}:${connection.connectionRevision}`, input.stableId) : null
  if (input.serverAllowed !== false && connection.serverEnabled && definition.capabilities.transports.includes('server') && rolloutBucket !== null && rolloutBucket < connection.rolloutEffectivePercentage) {
    deliveries.push({ id: crypto.randomUUID(), provider: connection.provider, transport: 'server', destination: binding.serverDestination, externalEventId, matchSignals: input.matchSignals ?? {} })
  }
  return { externalEventId, deliveries, rolloutBucket }
}

/** 为 rollout 提供可复现的稳定分桶，不包含任何平台特例。 */
export async function attributionPlannerRolloutBucket(namespace: string, stableId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}\n${stableId.trim()}`))
  return new DataView(digest).getUint32(0, false) % 100
}
