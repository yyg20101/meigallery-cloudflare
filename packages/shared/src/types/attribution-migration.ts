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

export interface AttributionMigrationInitialSnapshotV1 {
  schemaVersion: 1
  phase: 'initial'
  capturedAt: string
  sourceConfigurationHash: string
  connections: AttributionMigrationConnectionV1[]
  managedSources: AttributionMigrationManagedSourceV1[]
  historyDaily: AttributionMigrationHistoryDailyV1[]
  privacyPolicy: {
    defaultMode: 'notice_opt_out' | 'prior_consent' | 'disabled'
    priorConsentCountryCodes: string[]
    policyVersion: number
    updatedAt: string
  }
}

export interface AttributionMigrationReconcileSnapshotV1 {
  schemaVersion: 1
  phase: 'reconcile'
  initialRunId: string
  capturedAt: string
  sourceConfigurationHash: string
  managedSources: AttributionMigrationManagedSourceV1[]
  historyDaily: AttributionMigrationHistoryDailyV1[]
}

export type AttributionMigrationSnapshotV1 =
  | AttributionMigrationInitialSnapshotV1
  | AttributionMigrationReconcileSnapshotV1

export interface AttributionMigrationImportCountsV1 {
  connections: number
  versions: number
  credentials: number
  bindings: number
  managedSources: number
  historyRows: number
  historyFacts: number
}

export interface AttributionMigrationImportResultV1 {
  runId: string
  phase: 'initial' | 'reconcile'
  snapshotHash: string
  sourceConfigurationHash: string
  credentialSetHash: string
  capturedAt: string
  replayed: boolean
  counts: AttributionMigrationImportCountsV1
}
