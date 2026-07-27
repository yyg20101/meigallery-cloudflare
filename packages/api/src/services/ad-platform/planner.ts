import type { AdAttributionProvider, AdBrowserInstruction, CanonicalConversionEvent } from '@meigallery/shared'
import { buildAdExternalEventIdFromKey } from '@meigallery/shared/utils'
import { deriveAttributionHmacKey, type AttributionCryptoKeys } from '../../utils/attribution-crypto'
import type { AttributionConnectionSnapshot } from './connections'
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

export interface AttributionDeliveryPlan { externalEventId: string; deliveries: PlannedAttributionDelivery[] }

export async function buildAttributionDeliveryPlan(input: {
  factId: string
  provider: unknown
  canonicalEvent: CanonicalConversionEvent
  sourceAvailable: boolean
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
  if (!definition || !input.sourceAvailable || input.connection.state !== 'ready') return { externalEventId, deliveries: [] }
  const { connection, bindings } = input.connection
  const descriptor = definition.describeEvent({ canonicalEvent: input.canonicalEvent })
  const binding = bindings.get(input.canonicalEvent)
  if (!descriptor || !binding || !binding.enabled || !connection.enabled) return { externalEventId, deliveries: [] }
  const boundDescriptor = {
    ...descriptor,
    browserDestination: binding.browserDestination,
    serverDestination: binding.serverDestination,
  }
  const deliveries: PlannedAttributionDelivery[] = []
  if (connection.browserEnabled && definition.capabilities.transports.includes('browser')) {
    const deliveryId = crypto.randomUUID()
    deliveries.push({
      id: deliveryId, provider: connection.provider, transport: 'browser', destination: binding.browserDestination, externalEventId, matchSignals: {},
      browserInstruction: {
        provider: connection.provider,
        canonicalEvent: input.canonicalEvent,
        externalEventId,
        descriptor: boundDescriptor,
        payload: {},
      },
    })
  }
  if (input.serverAllowed !== false && connection.serverEnabled && definition.capabilities.transports.includes('server')) {
    deliveries.push({ id: crypto.randomUUID(), provider: connection.provider, transport: 'server', destination: binding.serverDestination, externalEventId, matchSignals: input.matchSignals ?? {} })
  }
  return { externalEventId, deliveries }
}
