import type { AdAttributionProvider, AdBrowserInstruction, CanonicalConversionEvent } from '@meigallery/shared'
import { deriveAttributionHmacKey, type AttributionCryptoKeys } from '../../utils/attribution-crypto'
import type { AttributionConnectionSnapshot } from './connections'
import { getAdPlatformDefinition } from './registry'

export interface PlannedAttributionDelivery {
  id: string
  provider: AdAttributionProvider
  transport: 'browser' | 'server'
  destination: string
  externalEventId: string
  browserInstruction?: AdBrowserInstruction
}

export interface AttributionDeliveryPlan {
  externalEventId: string
  deliveries: PlannedAttributionDelivery[]
  rolloutBucket: number | null
}

export async function buildAttributionDeliveryPlan(input: {
  factId: string
  provider: unknown
  canonicalEvent: CanonicalConversionEvent
  consentGranted: boolean
  sourceAvailable: boolean
  stableId: string
  cryptoKeys?: AttributionCryptoKeys
  eventKey?: CryptoKey
  connection: AttributionConnectionSnapshot
}): Promise<AttributionDeliveryPlan> {
  const eventKey = input.eventKey ?? (input.cryptoKeys
    ? await deriveAttributionHmacKey({ keys: input.cryptoKeys, purpose: 'event_id' })
    : null)
  if (!eventKey) throw new Error('ATTRIBUTION_EVENT_KEY_UNAVAILABLE')
  const externalEventId = await createExternalEventId(eventKey, input.factId, input.canonicalEvent)
  const definition = getAdPlatformDefinition(input.provider)
  if (!definition || !input.consentGranted || !input.sourceAvailable || input.connection.state !== 'ready') {
    return { externalEventId, deliveries: [], rolloutBucket: null }
  }
  const { connection, bindings } = input.connection
  const descriptor = definition.describeEvent({ canonicalEvent: input.canonicalEvent })
  const binding = bindings.get(input.canonicalEvent)
  if (!descriptor || !binding || !binding.enabled || !connection.enabled || connection.mode === 'disabled') {
    return { externalEventId, deliveries: [], rolloutBucket: null }
  }
  const rolloutBucket = await stableBucket(`${connection.id}:${connection.connectionRevision}`, input.stableId)
  if (rolloutBucket >= connection.rolloutEffectivePercentage) return { externalEventId, deliveries: [], rolloutBucket }
  const deliveries: PlannedAttributionDelivery[] = []
  if (connection.browserEnabled && definition.capabilities.transports.includes('browser')) {
    deliveries.push({
      id: crypto.randomUUID(), provider: connection.provider, transport: 'browser', destination: binding.browserDestination,
      externalEventId, browserInstruction: {
        provider: connection.provider, canonicalEvent: input.canonicalEvent, externalEventId, descriptor,
        payload: { destination: binding.browserDestination },
      },
    })
  }
  if (connection.serverEnabled && definition.capabilities.transports.includes('server')) {
    deliveries.push({ id: crypto.randomUUID(), provider: connection.provider, transport: 'server', destination: binding.serverDestination, externalEventId })
  }
  return { externalEventId, deliveries, rolloutBucket }
}

async function createExternalEventId(key: CryptoKey, factId: string, event: CanonicalConversionEvent) {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v3:${event}:${factId}`)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return `mg3_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '').slice(0, 43)}`
}

async function stableBucket(namespace: string, stableId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}\n${stableId.trim()}`))
  return new DataView(digest).getUint32(0, false) % 100
}
