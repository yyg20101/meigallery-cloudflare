import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'

export type AttributionRuntimePercentage = 0 | 10 | 50 | 100
export type AttributionCredentialType =
  | 'access_token'
  | 'service_account_json'

export interface AttributionConnectionCandidateView {
  state: 'candidate' | 'validating' | 'ready' | 'failed'
  createdAt: string
  failureCode: string
  productionContinues: true
}

export interface AttributionRuntimePolicyView {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: AttributionRuntimePercentage
  serverEffectivePercentage: AttributionRuntimePercentage
  circuitState: 'closed' | 'server_open'
}

export interface AttributionConnectionView {
  id: string
  provider: AttributionProvider
  name: string
  isDefault: boolean
  state: 'not_configured' | 'active' | 'disabled'
  activeTarget: string
  candidate: AttributionConnectionCandidateView | null
  runtime: AttributionRuntimePolicyView
  health: {
    level: 'healthy' | 'warning' | 'critical'
    lastDeliveryAt: string
  }
}

export interface AttributionEventBindingInput {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface CreateAttributionConnectionRequest {
  provider: AttributionProvider
  name: string
  isDefault: boolean
}

export interface CreateCandidateRequest {
  publicConfig: Record<string, string>
  credential?: {
    type: AttributionCredentialType
    plaintext: string
  }
  eventBindings: AttributionEventBindingInput[]
  testEventCode?: string
}

export interface SetRuntimePolicyRequest {
  enabled: boolean
  browserEnabled: boolean
  serverEnabled: boolean
  serverTargetPercentage: AttributionRuntimePercentage
}

export interface AttributionQualityQuery {
  dateFrom?: string
  dateTo?: string
  provider?: AttributionProvider
  connectionId?: string
  limit?: number
}

export interface AttributionQualityView {
  date: string
  provider: AttributionProvider
  connectionId: string
  connectionName: string
  metricKey: string
  numerator: number | null
  denominator: number | null
  value: number | null
  availability: 'available' | 'unavailable' | 'error'
}

export interface AttributionDateRangeQuery {
  dateFrom?: string
  dateTo?: string
  provider?: AttributionProvider
  connectionId?: string
  limit?: number
}

export interface AttributionOperationView {
  date: string
  provider: AttributionProvider | null
  connectionId: string
  connectionName: string
  contactCount: number
  completeRegistrationCount: number
  factCount: number
  attributedFactCount: number
  unattributedFactCount: number
  browserAttempted: number
  serverPlanned: number
  serverQueued: number
  serverProcessed: number
  serverRejected: number
  serverDeadLetter: number
}

export type AttributionOperationMetrics = Omit<
  AttributionOperationView,
  'date' | 'provider' | 'connectionId' | 'connectionName'
>

export interface AttributionBindingView {
  canonicalEvent: CanonicalConversionEvent
  enabled: boolean
  browserDestination: string
  serverDestination: string
}

export interface AttributionConnectionBindingsView {
  provider: AttributionProvider
  connectionId: string
  connectionName: string
  active: {
    state: 'active' | 'not_configured'
    bindings: AttributionBindingView[]
  }
  candidate: null | {
    state: 'candidate' | 'validating' | 'ready' | 'failed'
    bindings: AttributionBindingView[]
  }
}

export interface AttributionVerificationView {
  provider: AttributionProvider
  connectionId: string
  connectionName: string
  status: 'queued' | 'running' | 'verified' | 'failed' | 'timed_out'
  failureCode: string
  candidateChecked: boolean
  pairedEventCount: number
  createdAt: string
  startedAt: string
  completedAt: string
}

export type AttributionIncidentProvider =
  | AttributionProvider
  | 'cloudflare'
  | 'system'

export interface AttributionIncidentQuery {
  dateFrom?: string
  dateTo?: string
  provider?: AttributionIncidentProvider
  connectionId?: string
  severity?: 'warning' | 'critical'
  status?: 'open' | 'resolved'
  limit?: number
}

export interface AttributionAuditView {
  provider: AttributionProvider | null
  connectionId: string
  connectionName: string
  actorId: number
  commandType: string
  outcome: string
  summary: string
  createdAt: string
}

export interface AttributionIncidentView {
  id: string
  provider: AttributionIncidentProvider
  connectionId: string
  connectionName: string
  severity: 'warning' | 'critical'
  code: string
  affectedChannel: string
  affectedEvent: string
  openedAt: string
  detectedAt: string
  recoveredAt: string
  affectedFactCount: number
  affectedDeliveryCount: number
  automaticAction: string
  recoveryStatus: 'active' | 'recovered'
}

export interface AttributionPrivacyPolicyView {
  availability: 'available'
  defaultMode: 'notice_opt_out' | 'prior_consent' | 'disabled'
  priorConsentCountryCodes: readonly string[]
  policyVersion: number
  updatedAt: string
}

export interface SaveAttributionPrivacyPolicyRequest {
  defaultMode: AttributionPrivacyPolicyView['defaultMode']
  priorConsentCountryCodes: string[]
}

export interface AttributionManagedSourceView {
  id: string
  provider: AttributionProvider
  connectionId: string
  campaign: string
  medium: string
  content: string
  expiresAt: string | null
  enabled: boolean
  createdAt: string
}

export interface CreateAttributionManagedSourceRequest {
  campaign: string
  medium: string
  content: string
  expiresAt?: string
}

export interface AttributionManagedSourceListView {
  connectionId: string
  sources: AttributionManagedSourceView[]
}

export interface CreateAttributionManagedSourceResult {
  source: AttributionManagedSourceView
  proof: string | null
  proofDelivery: 'issued_once' | 'not_recoverable'
  replayed: boolean
}

export interface DisableAttributionManagedSourceResult {
  source: AttributionManagedSourceView
  disabled: true
}

export interface AttributionAdminApiResponse<T> {
  data: T
}

export interface AttributionAdminRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  body?: unknown
  query?: Record<string, string | number | undefined>
  headers?: Record<string, string>
}

export interface AttributionAdminClient {
  request<T>(
    path: string,
    options?: AttributionAdminRequestOptions,
  ): Promise<T>
  createIdempotencyKey(): string
}
