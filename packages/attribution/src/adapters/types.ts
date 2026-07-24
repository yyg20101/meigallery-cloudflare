import type {
  AttributionBrowserInstructionV1,
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import type {
  AttributionCandidateBindingInput,
} from '../domain/connection'

export interface AdapterRuntime {
  fetcher?: typeof fetch
  now?: () => Date
}

export interface CandidateValidationInput {
  provider: AttributionProvider
  connectionId: string
  versionId: string
  publicConfig: Record<string, string>
  credential: string
  bindings: AttributionCandidateBindingInput[]
  testEventCode?: string
}

export interface ValidationEvidence {
  schemaVersion: 1
  provider: AttributionProvider
  connectionId: string
  versionId: string
  publicConfigValid: true
  credentialFormatValid: true
  bindingsValid: true
  checkedAt: string
}

export interface BrowserInstructionInput {
  provider: AttributionProvider
  connectionId: string
  versionId: string
  deliveryId: string
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  destination: string
  receiptToken: string
}

export type BrowserInstruction = AttributionBrowserInstructionV1

export interface ServerDeliveryConsent {
  marketingAllowed: boolean
  adUserDataAllowed: boolean
  adPersonalizationAllowed: boolean
}

export interface ServerDeliveryInput {
  provider: AttributionProvider
  connectionId: string
  versionId: string
  deliveryId: string
  canonicalEvent: CanonicalConversionEvent
  externalEventId: string
  occurredAt: string
  /**
   * 由 Queue 使用已验证的公开站点 origin 与事件路径构造。
   * Connection 配置不得保存环境域名。
   */
  pageUrl: string
  destination: string
  publicConfig: Record<string, string>
  credential: string
  identifiers: Record<string, string>
  contextIssuedAt: number
  hashedEmail?: string
  clientIp?: string
  userAgent?: string
  consent: ServerDeliveryConsent
  validateOnly: boolean
  testEventCode?: string
}

export type ProviderDeliveryClassification =
  | 'accepted'
  | 'processed'
  | 'retryable'
  | 'rejected'
  | 'credential_invalid'
  | 'destination_invalid'

export interface ProviderDeliveryResult {
  classification: ProviderDeliveryClassification
  provider: AttributionProvider
  httpStatus?: number
  requestId?: string
  providerCode?: number
}

export interface QualitySignalInput {
  provider: AttributionProvider
  connectionId: string
  versionId: string
  publicConfig: Record<string, string>
  credential: string
}

export interface QualityMetric {
  canonicalEvent: CanonicalConversionEvent
  key: string
  value: number
}

export type QualitySignalResult =
  | {
      availability: 'available'
      provider: AttributionProvider
      metrics: QualityMetric[]
      checkedAt: string
    }
  | {
      availability: 'unavailable' | 'error'
      provider: AttributionProvider
      reason: string
      checkedAt: string
    }

export interface AttributionProviderAdapter {
  readonly provider: AttributionProvider
  eventName(event: CanonicalConversionEvent): string
  normalizeTestEventCode(
    value: unknown,
  ): string | undefined | null
  validateCandidate(
    input: CandidateValidationInput,
  ): Promise<ValidationEvidence>
  buildBrowserInstruction(
    input: BrowserInstructionInput,
  ): BrowserInstruction
  deliverServerEvent(
    input: ServerDeliveryInput,
  ): Promise<ProviderDeliveryResult>
  readQualitySignal(
    input: QualitySignalInput,
  ): Promise<QualitySignalResult>
}
