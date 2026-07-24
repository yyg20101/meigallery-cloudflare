import type { AttributionProvider } from '@meigallery/shared'

export interface AttributionRouteCandidate {
  provider: AttributionProvider
  connectionId: string
}

export interface AttributionRouteSignals {
  proof?: string
  contextToken?: string
  identifiers?: {
    fbclid?: string
    ttclid?: string
    gclid?: string
    gbraid?: string
    wbraid?: string
  }
  utmSource?: string
}

export type AttributionRoutingIncidentCode =
  | 'ATTRIBUTION_CONNECTION_AMBIGUOUS'
  | 'ATTRIBUTION_PROVIDER_CONFLICT'

export interface AttributionRoutingIncident {
  code: AttributionRoutingIncidentCode
  provider: AttributionProvider | null
}

export interface AttributionRoutingRepository {
  resolveManagedSource(
    proof: string,
  ): Promise<AttributionRouteCandidate | null>
  resolveFirstPartyContext(
    token: string,
  ): Promise<AttributionRouteCandidate | null>
  listEligibleConnections(
    provider: AttributionProvider,
  ): Promise<readonly string[]>
  recordRoutingIncident(incident: AttributionRoutingIncident): Promise<void>
}

export interface AttributionRouteResult {
  resolution: 'resolved' | 'none' | 'ambiguous' | 'conflict'
  provider: AttributionProvider | null
  connectionId: string | null
  incidentCode: AttributionRoutingIncidentCode | null
}

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])

export async function resolveAttributionRoute(
  repository: AttributionRoutingRepository,
  signals: AttributionRouteSignals,
): Promise<AttributionRouteResult> {
  const proof = usableSignal(signals.proof)
  if (proof) {
    const managed = validCandidate(
      await repository.resolveManagedSource(proof),
    )
    if (managed) return resolved(managed)
  }

  const contextToken = usableSignal(signals.contextToken)
  if (contextToken) {
    const context = validCandidate(
      await repository.resolveFirstPartyContext(contextToken),
    )
    if (context) return resolved(context)
  }

  const clickProviders = providersFromClickIds(signals.identifiers)
  if (clickProviders.length > 1) {
    const incident: AttributionRoutingIncident = {
      code: 'ATTRIBUTION_PROVIDER_CONFLICT',
      provider: null,
    }
    await repository.recordRoutingIncident(incident)
    return {
      resolution: 'conflict',
      provider: null,
      connectionId: null,
      incidentCode: incident.code,
    }
  }

  const provider = clickProviders[0]
  if (!provider) return noAttribution()

  const connections = [
    ...new Set(
      (await repository.listEligibleConnections(provider))
        .filter(isConnectionId),
    ),
  ]
  if (connections.length === 1) {
    return resolved({
      provider,
      connectionId: connections[0]!,
    })
  }
  if (connections.length > 1) {
    const incident: AttributionRoutingIncident = {
      code: 'ATTRIBUTION_CONNECTION_AMBIGUOUS',
      provider,
    }
    await repository.recordRoutingIncident(incident)
    return {
      resolution: 'ambiguous',
      provider,
      connectionId: null,
      incidentCode: incident.code,
    }
  }

  return noAttribution()
}

function providersFromClickIds(
  identifiers: AttributionRouteSignals['identifiers'],
): AttributionProvider[] {
  if (!identifiers) return []

  const providers = new Set<AttributionProvider>()
  if (usableSignal(identifiers.fbclid)) providers.add('meta')
  if (usableSignal(identifiers.ttclid)) providers.add('tiktok')
  if (
    usableSignal(identifiers.gclid)
    || usableSignal(identifiers.gbraid)
    || usableSignal(identifiers.wbraid)
  ) {
    providers.add('google')
  }
  return [...providers]
}

function validCandidate(
  candidate: AttributionRouteCandidate | null,
): AttributionRouteCandidate | null {
  if (
    !candidate
    || !PROVIDERS.has(candidate.provider)
    || !isConnectionId(candidate.connectionId)
  ) {
    return null
  }
  return candidate
}

function usableSignal(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    ? value
    : null
}

function isConnectionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function resolved(
  candidate: AttributionRouteCandidate,
): AttributionRouteResult {
  return {
    resolution: 'resolved',
    provider: candidate.provider,
    connectionId: candidate.connectionId,
    incidentCode: null,
  }
}

function noAttribution(): AttributionRouteResult {
  return {
    resolution: 'none',
    provider: null,
    connectionId: null,
    incidentCode: null,
  }
}
