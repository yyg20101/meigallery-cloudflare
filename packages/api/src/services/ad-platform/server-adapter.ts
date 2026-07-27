import type { AdAttributionProvider, CanonicalConversionEvent } from '@meigallery/shared'
import { googleServerAdapter } from './adapters/google-server'
import { metaServerAdapter } from './adapters/meta-server'
import { tiktokServerAdapter } from './adapters/tiktok-server'

export type DeliveryClassification = 'accepted' | 'processed' | 'retryable' | 'rejected' | 'credential_invalid' | 'destination_invalid'

export interface ServerDeliveryBaseInput {
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  eventTime: number
  pageUrl: string
  destination: string
  matchSignals: Record<string, string>
  hashedEmail?: string
  clientIpAddress?: string
  clientUserAgent?: string
}

export interface MetaServerDeliveryInput extends ServerDeliveryBaseInput { provider: 'meta' }
export interface TikTokServerDeliveryInput extends ServerDeliveryBaseInput { provider: 'tiktok' }
export interface GoogleServerDeliveryInput extends ServerDeliveryBaseInput { provider: 'google'; validateOnly: boolean }
export type ServerDeliveryInput = MetaServerDeliveryInput | TikTokServerDeliveryInput | GoogleServerDeliveryInput

export interface ServerAdapterIncident {
  code: 'cross_platform_identifier' | 'server_adapter_unavailable'
  severity: 'critical'
}

export interface ServerDeliveryResult {
  classification: DeliveryClassification
  receipt?: { status: number; requestId?: string }
  incident?: ServerAdapterIncident
}

export interface ServerAdapterRequest {
  input: ServerDeliveryInput
  config: Record<string, string>
  credential: string
  fetcher?: typeof fetch
}

export interface ServerTrackingAdapter {
  readonly provider: AdAttributionProvider
  deliver(request: ServerAdapterRequest): Promise<ServerDeliveryResult>
}

const ADAPTERS: ReadonlyMap<AdAttributionProvider, ServerTrackingAdapter> = new Map([
  ['meta', metaServerAdapter],
  ['tiktok', tiktokServerAdapter],
  ['google', googleServerAdapter],
])

export function getServerTrackingAdapter(provider: unknown): ServerTrackingAdapter | null {
  return typeof provider === 'string' ? ADAPTERS.get(provider as AdAttributionProvider) ?? null : null
}

export async function deliverServerEvent(request: ServerAdapterRequest): Promise<ServerDeliveryResult> {
  const adapter = getServerTrackingAdapter(request.input.provider)
  return adapter
    ? adapter.deliver(request)
    : { classification: 'rejected', incident: { code: 'server_adapter_unavailable', severity: 'critical' } }
}
