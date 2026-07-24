import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import type { AttributionProviderAdapter } from '../adapters/types'
import type { AttributionAppEnvironment } from '../env'
import type { AttributionEncryptionKeys } from '../security/data-envelope'
import type { CredentialEnvelope } from './credential-vault'

export interface AttributionQueueConsumerEnvironment {
  db: D1Database
  appEnvironment: AttributionAppEnvironment
  publicOrigins: readonly string[]
  credentialMasterKeys: AttributionEncryptionKeys
  dataEncryptionKeys: AttributionEncryptionKeys
  adapterFor?: (provider: AttributionProvider) => AttributionProviderAdapter
  now?: () => Date
  idFactory?: (prefix: string) => string
}

export interface AttributionQueueConsumerResult {
  accepted: number
  retried: number
  rejected: number
  deadLettered: number
  skipped: number
}

export interface DeliverySnapshot {
  deliveryId: string
  factId: string
  connectionId: string
  versionId: string
  provider: AttributionProvider
  destination: string
  externalEventId: string
  status: string
  attemptCount: number
  lastErrorCode: string
  updatedAt: string
  eventName: CanonicalConversionEvent
  factOrigin: 'live' | 'synthetic'
  publicConfig: Record<string, string>
  circuitState: 'closed' | 'server_open'
  outboxExpiresAt: string
  outboxEnvelope: {
    schemaVersion: 1
    keyId: string
    iv: string
    ciphertext: string
    tag: string
  }
  credentialEnvelope: CredentialEnvelope
  providerChainValid: boolean
  bindingValid: boolean
  runtimeEnabled: boolean
  serverEnabled: boolean
  serverEffectivePercentage: 0 | 10 | 50 | 100
}

export interface DeliveryHeader {
  deliveryId: string
  connectionId: string
  provider: AttributionProvider
  status: string
}

export interface ServerOutboxPayload {
  schemaVersion: 1
  factId: string
  deliveryId: string
  provider: AttributionProvider
  connectionId: string
  versionId: string
  transport: 'server'
  destination: string
  externalEventId: string
  eventName: CanonicalConversionEvent
  occurredAt: string
  pagePath: string
  consent: {
    marketingAllowed: true
    adUserDataAllowed: true
    adPersonalizationAllowed: boolean
  }
  payload:
    | {
        contactMethodId: string
        contactPlatform: string
        contactAction: 'open_link' | 'copy'
      }
    | {
        userId: number
        hashedEmail?: string
      }
  context: {
    sourceId: string
    issuedAt: number
    identifiers: Record<string, string>
  }
  requestMetadata: {
    clientIp?: string
    userAgent?: string
  }
}
