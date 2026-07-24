import type {
  AttributionProvider,
  CanonicalConversionEvent,
  ConnectionVersionStatus,
} from '@meigallery/shared'

export interface AttributionConnection {
  id: string
  provider: AttributionProvider
  name: string
  isDefault: boolean
  activeVersionId: string | null
  createdAt: string
  updatedAt: string
}

export interface AttributionVersionBinding {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AttributionCredentialMetadata {
  provider: AttributionProvider
  schemaVersion: number
  keyId: string
  fingerprint: string
  destroyAfter: string | null
}

export interface AttributionConnectionVersion {
  id: string
  connectionId: string
  provider: AttributionProvider
  baseActiveVersionId: string | null
  status: ConnectionVersionStatus
  publicConfig: Readonly<Record<string, string>>
  configHash: string
  createdBy: number
  createdAt: string
  validatedAt: string | null
  activatedAt: string | null
  drainingAt: string | null
  retiredAt: string | null
  failureCode: string
  bindings: readonly AttributionVersionBinding[]
  credential: AttributionCredentialMetadata
}

export interface AttributionRuntimePolicy {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: 0 | 10 | 50 | 100
  serverEffectivePercentage: 0 | 10 | 50 | 100
  circuitState: 'closed' | 'server_open'
  runtimeGeneration: number
  updatedBy: number
  updatedAt: string
}

export interface AttributionConnectionAggregate {
  connection: AttributionConnection
  activeVersion: AttributionConnectionVersion | null
  liveCandidate: AttributionConnectionVersion | null
  runtimePolicy: AttributionRuntimePolicy
}

export interface AttributionCandidateBindingInput {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AttributionCandidateInput {
  provider: AttributionProvider
  publicConfig: Record<string, string>
  bindings: readonly AttributionCandidateBindingInput[]
  credentialFingerprint: string
}

export interface NormalizedAttributionCandidate {
  provider: AttributionProvider
  publicConfig: Readonly<Record<string, string>>
  bindings: readonly AttributionCandidateBindingInput[]
  credentialFingerprint: string
}
