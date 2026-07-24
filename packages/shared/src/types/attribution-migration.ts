import type {
  AdAttributionProvider,
  AttributionCredentialType,
  CanonicalConversionEvent,
} from './ad-attribution'

export type AttributionMigrationRolloutPercentage = 0 | 10 | 50 | 100

export interface AttributionMigrationEventBindingV1 {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AttributionMigrationConnectionV1 {
  id: string
  provider: AdAttributionProvider
  name: string
  isDefault: boolean
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: AttributionMigrationRolloutPercentage
  serverEffectivePercentage: AttributionMigrationRolloutPercentage
  circuitState: 'closed' | 'server_open'
  publicConfig: Record<string, string>
  eventBindings: AttributionMigrationEventBindingV1[]
  credential: {
    type: AttributionCredentialType
    plaintext: string
  }
  createdAt: string
  updatedAt: string
}

export interface AttributionMigrationManagedSourceV1 {
  id: string
  provider: AdAttributionProvider
  connectionId: string
  campaign: string
  medium: string
  content: string
  proof: string
  enabled: boolean
  expiresAt: string | null
  createdAt: string
}

export interface AttributionMigrationLiveFactV1 {
  id: string
  eventId: string
  eventName: CanonicalConversionEvent
  dedupeKey: string
  provider: AdAttributionProvider | null
  externalEventId: string | null
  occurredAt: string
  consent: {
    marketingAllowed: boolean
    adUserDataAllowed: boolean
    adPersonalizationAllowed: boolean
  }
  analyticsDimensions: Record<string, unknown>
  createdAt: string
}

export interface AttributionMigrationHistoryDailyV1 {
  date: string
  eventName: CanonicalConversionEvent
  factOrigin: 'historical_backfill' | 'archived_live'
  provider: AdAttributionProvider | null
  attributionSource: string
  factCount: number
  firstOccurredAt: string
  lastOccurredAt: string
}

export interface AttributionMigrationSnapshotV1 {
  schemaVersion: 1
  capturedAt: string
  windowStartedAt: string
  connections: AttributionMigrationConnectionV1[]
  managedSources: AttributionMigrationManagedSourceV1[]
  liveFacts: AttributionMigrationLiveFactV1[]
  historyDaily: AttributionMigrationHistoryDailyV1[]
  privacyPolicy: {
    defaultMode: 'notice_opt_out' | 'prior_consent' | 'disabled'
    priorConsentCountryCodes: string[]
    policyVersion: number
    updatedAt: string
  }
}

export interface AttributionMigrationImportCountsV1 {
  connections: number
  versions: number
  credentials: number
  bindings: number
  managedSources: number
  liveFacts: number
  historyRows: number
}

export interface AttributionMigrationImportResultV1 {
  runId: string
  snapshotHash: string
  replayed: boolean
  counts: AttributionMigrationImportCountsV1
}
