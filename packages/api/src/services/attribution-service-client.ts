import {
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
  type AttributionMigrationSnapshotV1,
} from '@meigallery/shared'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'

const ATTRIBUTION_INTERNAL_ORIGIN =
  ATTRIBUTION_SERVICE_BINDING.INTERNAL_ORIGIN
const PRIVACY_DECISION_PATH = '/internal/v1/privacy-decision'
const REGISTRATION_EVENTS_PATH = '/internal/v1/registration-events'
const CONTACT_EVENTS_PATH = '/internal/v1/contact-events'
const LEGACY_CONTEXT_PATH = '/internal/v1/legacy-context'
const RUNTIME_STATE_PATH = '/internal/v1/runtime-state'
const RUNTIME_TRANSITION_PATH =
  `${ATTRIBUTION_SERVICE_BINDING.ADMIN_PATH_PREFIX}`
  + '/runtime-state/transition'
const CONTACT_CAPABILITIES_PATH = '/internal/v1/contact-capabilities'
const BROWSER_INSTRUCTION_PATH_PREFIX = '/internal/v1/events/'
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const CONTACT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const DESTINATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const CONTACT_BATCH_LIMIT = 100
const PROVIDER_IDENTIFIER_KEYS = {
  meta: new Set(['fbclid']),
  tiktok: new Set(['ttclid']),
  google: new Set(['gclid', 'gbraid', 'wbraid']),
} as const

export interface AttributionServiceBinding {
  fetch(request: Request): Promise<Response>
}

export interface AttributionServiceClient {
  readRuntimeState(): Promise<AttributionRuntimeReadiness>
  transitionRuntimeState(
    input: AttributionRuntimeTransitionInput,
  ): Promise<AttributionRuntimeState>
  resolvePrivacyDecision(
    input: AttributionPrivacyDecisionInput,
  ): Promise<AttributionPrivacyDecisionResult>
  ingestRegistrationEvent(
    input: AttributionBusinessEventV1,
    ownership: AttributionRuntimeWriteOwnership,
  ): Promise<{ accepted: true; eventId: string }>
  ingestContactEvent(
    input: AttributionContactBridgeEventInput,
    ownership: AttributionRuntimeWriteOwnership,
  ): Promise<{ accepted: true; eventId: string }>
  translateLegacyContext(
    input: AttributionLegacyContextInput,
  ): Promise<{ sourceContextToken: string }>
  getSignedBrowserInstruction(
    input: { eventId: string },
    ownership: AttributionRuntimeWriteOwnership,
  ): Promise<{ instructionToken: string }>
  getSignedContactCapabilities(
    input: AttributionContactCapabilityInput[],
  ): Promise<AttributionContactCapabilityResult[]>
}

export interface AttributionMigrationClient {
  readImportResult(input: {
    runId: string
    actorId: number
  }): Promise<Response>
  importSnapshot(input: {
    runId: string
    actorId: number
    snapshot: AttributionMigrationSnapshotV1
  }): Promise<Response>
}

export interface AttributionPrivacyDecisionInput {
  privacyToken: string | null
  country: string | null
  gpc: boolean
}

export interface AttributionRuntimeWriteOwnership {
  owner: 'draining' | 'new'
  epoch: number
}

export interface AttributionRuntimeState {
  mode: 'shadow' | 'bridge' | 'active' | 'fenced'
  activatedAt: string | null
  bridgeOwnerEpoch: number | null
  activeOwnerEpoch: number | null
  fencedOwnerEpoch: number | null
  updatedAt: string
}

export interface AttributionRuntimeReadiness
  extends AttributionRuntimeState {
  migrationReconciled: boolean
  inFlightServerDeliveries: number
}

export interface AttributionRuntimeTransitionInput {
  targetMode: 'bridge' | 'active' | 'fenced'
  sourceOwnerEpoch: number
  actorId: number
  reason: string
  idempotencyKey: string
}

export interface AttributionContactBridgeEventInput {
  event: AttributionBusinessEventV1
  requestMetadata: {
    clientIp?: string
    userAgent?: string
  }
}

export interface AttributionLegacyContextInput {
  provider: 'meta' | 'tiktok' | 'google'
  identifiers: Record<string, string>
  idempotencyKey: string
}

export type AttributionPrivacyDecisionResult =
  | {
      state: 'granted'
      reason: 'explicit' | 'regional_default'
    }
  | {
      state: 'denied'
      reason: 'gpc' | 'disabled' | 'explicit'
    }
  | {
      state: 'choice_required'
      reason:
        | 'policy_default'
        | 'prior_consent_region'
        | 'unknown_region'
    }

export interface AttributionContactCapabilityInput {
  contactMethodId: string
  platform: string
  destinationDigest: string
}

export interface AttributionContactCapabilityResult
  extends AttributionContactCapabilityInput {
  attributionCapability: string
}

export class AttributionServiceClientError extends Error {
  readonly code: string
  readonly status: number | null

  constructor(code: string, status: number | null = null) {
    super(code)
    this.name = 'AttributionServiceClientError'
    this.code = code
    this.status = status
  }
}

export function createAttributionServiceClient(
  binding: AttributionServiceBinding,
): AttributionServiceClient {
  return {
    async readRuntimeState() {
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${RUNTIME_STATE_PATH}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_RUNTIME_STATE_FAILED',
          response.status,
        )
      }
      const result = await readJsonRecord(response)
      if (!isRuntimeReadiness(result)) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_RUNTIME_STATE_RESPONSE_INVALID',
          response.status,
        )
      }
      return result
    },

    async transitionRuntimeState(input) {
      const normalized = normalizeRuntimeTransitionInput(input)
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${RUNTIME_TRANSITION_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Idempotency-Key': normalized.idempotencyKey,
            ...runtimeCommandHeaders(normalized),
          },
          body: JSON.stringify({
            targetMode: normalized.targetMode,
            sourceOwnerEpoch: normalized.sourceOwnerEpoch,
            reason: normalized.reason,
          }),
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_RUNTIME_TRANSITION_FAILED',
          response.status,
        )
      }
      const result = await readJsonRecord(response)
      if (
        !isExactUnknownRecord(result, ['data'])
        || !isRuntimeState(result.data)
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_RUNTIME_TRANSITION_RESPONSE_INVALID',
          response.status,
        )
      }
      return result.data
    },

    async resolvePrivacyDecision(input) {
      const normalized = normalizePrivacyDecisionInput(input)
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${PRIVACY_DECISION_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(normalized),
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_PRIVACY_DECISION_FAILED',
          response.status,
        )
      }

      const result = await readJsonRecord(response)
      if (!isPrivacyDecisionResult(result)) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_PRIVACY_DECISION_RESPONSE_INVALID',
          response.status,
        )
      }
      return result
    },

    async ingestRegistrationEvent(input, ownership) {
      if (
        !isAttributionBusinessEventV1(input)
        || input.eventName !== 'CompleteRegistration'
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
        )
      }

      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${REGISTRATION_EVENTS_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...runtimeWriteHeaders(ownership),
          },
          body: JSON.stringify(input),
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_REGISTRATION_INGEST_FAILED',
          response.status,
        )
      }

      const result = await readJsonRecord(response)
      if (
        result.accepted !== true
        || result.eventId !== input.eventId
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_REGISTRATION_INGEST_RESPONSE_INVALID',
          response.status,
        )
      }
      return { accepted: true, eventId: input.eventId }
    },

    async ingestContactEvent(input, ownership) {
      if (
        !isPlainRecord(input)
        || !isAttributionBusinessEventV1(input.event)
        || input.event.eventName !== 'Contact'
        || !isRequestMetadata(input.requestMetadata)
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_CONTACT_EVENT_INVALID',
        )
      }
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${CONTACT_EVENTS_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...runtimeWriteHeaders(ownership),
          },
          body: JSON.stringify(input),
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_CONTACT_INGEST_FAILED',
          response.status,
        )
      }
      const result = await readJsonRecord(response)
      if (
        result.accepted !== true
        || result.eventId !== input.event.eventId
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_CONTACT_INGEST_RESPONSE_INVALID',
          response.status,
        )
      }
      return { accepted: true, eventId: input.event.eventId }
    },

    async translateLegacyContext(input) {
      const normalized = normalizeLegacyContextInput(input)
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${LEGACY_CONTEXT_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(normalized),
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_LEGACY_CONTEXT_FAILED',
          response.status,
        )
      }
      const result = await readJsonRecord(response)
      if (
        typeof result.sourceContextToken !== 'string'
        || result.sourceContextToken.length < 16
        || result.sourceContextToken.length > 4_096
        || /\p{Cc}/u.test(result.sourceContextToken)
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_LEGACY_CONTEXT_RESPONSE_INVALID',
          response.status,
        )
      }
      return { sourceContextToken: result.sourceContextToken }
    },

    async getSignedBrowserInstruction(input, ownership) {
      if (!EVENT_ID_PATTERN.test(input.eventId)) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_BROWSER_INSTRUCTION_INPUT_INVALID',
        )
      }

      const eventId = encodeURIComponent(input.eventId)
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${BROWSER_INSTRUCTION_PATH_PREFIX}${eventId}/browser-instruction`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...runtimeWriteHeaders(ownership),
          },
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_BROWSER_INSTRUCTION_FAILED',
          response.status,
        )
      }

      const result = await readJsonRecord(response)
      if (
        typeof result.instructionToken !== 'string'
        || result.instructionToken.length < 16
        || result.instructionToken.length > 16_384
      ) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_BROWSER_INSTRUCTION_RESPONSE_INVALID',
          response.status,
        )
      }
      return { instructionToken: result.instructionToken }
    },

    async getSignedContactCapabilities(input) {
      const contacts = normalizeContactCapabilityInput(input)
      const response = await binding.fetch(new Request(
        `${ATTRIBUTION_INTERNAL_ORIGIN}${CONTACT_CAPABILITIES_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ contacts }),
          redirect: 'error',
        },
      ))
      if (!response.ok) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_CONTACT_CAPABILITY_FAILED',
          response.status,
        )
      }

      const result = await readJsonRecord(response)
      if (!Array.isArray(result.capabilities)) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_CONTACT_CAPABILITY_RESPONSE_INVALID',
          response.status,
        )
      }
      return normalizeContactCapabilityResponse(
        contacts,
        result.capabilities,
        response.status,
      )
    },
  }
}

export function createAttributionMigrationClient(
  binding: AttributionServiceBinding,
): AttributionMigrationClient {
  return {
    async readImportResult(input) {
      const identity = normalizeMigrationIdentity(input)
      return binding.fetch(new Request(
        `${ATTRIBUTION_SERVICE_BINDING.INTERNAL_ORIGIN}`
          + `${ATTRIBUTION_SERVICE_BINDING.MIGRATION_PATH_PREFIX}`
          + `/imports/${encodeURIComponent(identity.runId)}`,
        {
          method: 'GET',
          headers: migrationHeaders(identity),
          redirect: 'error',
        },
      ))
    },

    async importSnapshot(input) {
      const identity = normalizeMigrationIdentity(input)
      if (!isPlainRecord(input.snapshot)) {
        throw new AttributionServiceClientError(
          'ATTRIBUTION_MIGRATION_INPUT_INVALID',
        )
      }
      return binding.fetch(new Request(
        `${ATTRIBUTION_SERVICE_BINDING.INTERNAL_ORIGIN}`
          + `${ATTRIBUTION_SERVICE_BINDING.MIGRATION_PATH_PREFIX}/import`,
        {
          method: 'POST',
          headers: {
            ...migrationHeaders(identity),
            'Content-Type': 'application/json',
            'Idempotency-Key': identity.runId,
          },
          body: JSON.stringify({
            runId: identity.runId,
            snapshot: input.snapshot,
          }),
          redirect: 'error',
        },
      ))
    },
  }
}

function normalizeMigrationIdentity(input: {
  runId: string
  actorId: number
}) {
  if (
    !EVENT_ID_PATTERN.test(input.runId)
    || !Number.isSafeInteger(input.actorId)
    || input.actorId < 1
  ) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_MIGRATION_INPUT_INVALID',
    )
  }
  return {
    runId: input.runId,
    actorId: input.actorId,
  }
}

function migrationHeaders(input: {
  runId: string
  actorId: number
}) {
  return {
    Accept: 'application/json',
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID]:
      String(input.actorId),
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE]: 'owner',
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID]:
      `migration_request_${input.runId}`,
  }
}

function normalizeRuntimeTransitionInput(
  input: AttributionRuntimeTransitionInput,
): AttributionRuntimeTransitionInput {
  if (
    !isExactUnknownRecord(input, [
      'targetMode',
      'sourceOwnerEpoch',
      'actorId',
      'reason',
      'idempotencyKey',
    ])
    || (
      input.targetMode !== 'bridge'
      && input.targetMode !== 'active'
      && input.targetMode !== 'fenced'
    )
    || !Number.isSafeInteger(input.sourceOwnerEpoch)
    || Number(input.sourceOwnerEpoch) < 2
    || !Number.isSafeInteger(input.actorId)
    || Number(input.actorId) < 1
    || typeof input.reason !== 'string'
    || input.reason.trim().length < 4
    || input.reason.trim().length > 240
    || /\p{Cc}/u.test(input.reason)
    || typeof input.idempotencyKey !== 'string'
    || !EVENT_ID_PATTERN.test(input.idempotencyKey)
  ) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_RUNTIME_TRANSITION_INPUT_INVALID',
    )
  }
  return {
    targetMode: input.targetMode,
    sourceOwnerEpoch: Number(input.sourceOwnerEpoch),
    actorId: Number(input.actorId),
    reason: input.reason.trim(),
    idempotencyKey: input.idempotencyKey,
  }
}

function runtimeCommandHeaders(input: AttributionRuntimeTransitionInput) {
  return {
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID]:
      String(input.actorId),
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE]: 'owner',
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID]:
      `runtime_request_${input.idempotencyKey}`.slice(0, 160),
  }
}

function normalizePrivacyDecisionInput(
  value: AttributionPrivacyDecisionInput,
): AttributionPrivacyDecisionInput {
  if (
    !isExactUnknownRecord(value, [
      'privacyToken',
      'country',
      'gpc',
    ])
    || !(
      value.privacyToken === null
      || (
        typeof value.privacyToken === 'string'
        && value.privacyToken.length > 0
        && value.privacyToken.length <= 4_096
        && !/\p{Cc}/u.test(value.privacyToken)
      )
    )
    || !(
      value.country === null
      || (
        typeof value.country === 'string'
        && /^[A-Z]{2}$/.test(value.country)
      )
    )
    || typeof value.gpc !== 'boolean'
  ) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_PRIVACY_DECISION_INPUT_INVALID',
    )
  }
  return { ...value }
}

function runtimeWriteHeaders(
  ownership: AttributionRuntimeWriteOwnership,
) {
  if (
    (ownership.owner !== 'draining' && ownership.owner !== 'new')
    || !Number.isSafeInteger(ownership.epoch)
    || ownership.epoch < 2
  ) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_RUNTIME_WRITE_OWNERSHIP_INVALID',
    )
  }
  return {
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_OWNER]:
      ownership.owner,
    [ATTRIBUTION_SERVICE_BINDING.HEADERS.RUNTIME_EPOCH]:
      String(ownership.epoch),
  }
}

function normalizeLegacyContextInput(
  input: AttributionLegacyContextInput,
): AttributionLegacyContextInput {
  if (
    !isExactUnknownRecord(input, [
      'provider',
      'identifiers',
      'idempotencyKey',
    ])
    || !['meta', 'tiktok', 'google'].includes(input.provider)
    || !EVENT_ID_PATTERN.test(input.idempotencyKey)
    || !isPlainRecord(input.identifiers)
    || Object.keys(input.identifiers).length
      > PROVIDER_IDENTIFIER_KEYS[input.provider].size
    || Object.entries(input.identifiers).some(([key, value]) =>
      !PROVIDER_IDENTIFIER_KEYS[input.provider].has(key)
      || typeof value !== 'string'
      || value.length === 0
      || value.length > 1_024
      || /\p{Cc}/u.test(value))
  ) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_LEGACY_CONTEXT_INPUT_INVALID',
    )
  }
  return {
    provider: input.provider,
    identifiers: { ...input.identifiers },
    idempotencyKey: input.idempotencyKey,
  }
}

function isRequestMetadata(
  value: unknown,
): value is AttributionContactBridgeEventInput['requestMetadata'] {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  return keys.every(key => key === 'clientIp' || key === 'userAgent')
    && keys.length <= 2
    && Object.values(value).every(item =>
      typeof item === 'string'
      && item.length > 0
      && item.length <= 1_024
      && !/\p{Cc}/u.test(item))
}

function isPrivacyDecisionResult(
  value: Record<string, unknown>,
): value is AttributionPrivacyDecisionResult {
  if (!isExactUnknownRecord(value, ['state', 'reason'])) return false
  if (value.state === 'granted') {
    return value.reason === 'explicit'
      || value.reason === 'regional_default'
  }
  if (value.state === 'denied') {
    return value.reason === 'gpc'
      || value.reason === 'disabled'
      || value.reason === 'explicit'
  }
  return value.state === 'choice_required'
    && (
      value.reason === 'policy_default'
      || value.reason === 'prior_consent_region'
      || value.reason === 'unknown_region'
    )
}

function isRuntimeReadiness(
  value: unknown,
): value is AttributionRuntimeReadiness {
  if (!isExactUnknownRecord(value, [
    'mode',
    'activatedAt',
    'bridgeOwnerEpoch',
    'activeOwnerEpoch',
    'fencedOwnerEpoch',
    'updatedAt',
    'migrationReconciled',
    'inFlightServerDeliveries',
  ])) {
    return false
  }
  return isRuntimeStateShape(value)
    && typeof value.migrationReconciled === 'boolean'
    && Number.isSafeInteger(value.inFlightServerDeliveries)
    && Number(value.inFlightServerDeliveries) >= 0
}

function isRuntimeState(
  value: unknown,
): value is AttributionRuntimeState {
  if (!isExactUnknownRecord(value, [
    'mode',
    'activatedAt',
    'bridgeOwnerEpoch',
    'activeOwnerEpoch',
    'fencedOwnerEpoch',
    'updatedAt',
  ])) {
    return false
  }
  return isRuntimeStateShape(value)
}

function isRuntimeStateShape(
  value: Record<string, unknown>,
): boolean {
  if (
    (value.mode !== 'shadow'
      && value.mode !== 'bridge'
      && value.mode !== 'active'
      && value.mode !== 'fenced')
    || typeof value.updatedAt !== 'string'
    || !isCanonicalTimestamp(value.updatedAt)
  ) {
    return false
  }
  if (value.mode === 'shadow') {
    return value.activatedAt === null
      && value.bridgeOwnerEpoch === null
      && value.activeOwnerEpoch === null
      && value.fencedOwnerEpoch === null
  }
  if (value.mode === 'bridge') {
    return value.activatedAt === null
      && Number.isSafeInteger(value.bridgeOwnerEpoch)
      && Number(value.bridgeOwnerEpoch) >= 2
      && value.activeOwnerEpoch === null
      && value.fencedOwnerEpoch === null
  }
  if (value.mode === 'fenced') {
    return value.activatedAt === null
      && value.bridgeOwnerEpoch === null
      && value.activeOwnerEpoch === null
      && Number.isSafeInteger(value.fencedOwnerEpoch)
      && Number(value.fencedOwnerEpoch) >= 3
  }
  return typeof value.activatedAt === 'string'
    && isCanonicalTimestamp(value.activatedAt)
    && Number.isSafeInteger(value.bridgeOwnerEpoch)
    && Number(value.bridgeOwnerEpoch) >= 2
    && Number.isSafeInteger(value.activeOwnerEpoch)
    && Number(value.activeOwnerEpoch)
      === Number(value.bridgeOwnerEpoch) + 1
    && value.fencedOwnerEpoch === null
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await response.json()
  }
  catch {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_SERVICE_RESPONSE_INVALID',
      response.status,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_SERVICE_RESPONSE_INVALID',
      response.status,
    )
  }
  return value as Record<string, unknown>
}

function normalizeContactCapabilityInput(
  value: AttributionContactCapabilityInput[],
): AttributionContactCapabilityInput[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > CONTACT_BATCH_LIMIT
  ) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_CONTACT_CAPABILITY_INPUT_INVALID',
    )
  }

  const seen = new Set<string>()
  return value.map((item) => {
    if (
      !isExactContactInput(item)
      || !CONTACT_ID_PATTERN.test(item.contactMethodId)
      || !isSafeText(item.platform, 80)
      || !DESTINATION_DIGEST_PATTERN.test(item.destinationDigest)
    ) {
      throw new AttributionServiceClientError(
        'ATTRIBUTION_CONTACT_CAPABILITY_INPUT_INVALID',
      )
    }
    const key = contactKey(item)
    if (seen.has(key)) {
      throw new AttributionServiceClientError(
        'ATTRIBUTION_CONTACT_CAPABILITY_INPUT_INVALID',
      )
    }
    seen.add(key)
    return { ...item }
  })
}

function normalizeContactCapabilityResponse(
  expected: AttributionContactCapabilityInput[],
  value: unknown[],
  status: number,
): AttributionContactCapabilityResult[] {
  if (value.length !== expected.length) {
    throw new AttributionServiceClientError(
      'ATTRIBUTION_CONTACT_CAPABILITY_RESPONSE_INVALID',
      status,
    )
  }
  const byKey = new Map<string, AttributionContactCapabilityResult>()
  for (const item of value) {
    if (
      !isExactContactResult(item)
      || !CONTACT_ID_PATTERN.test(item.contactMethodId)
      || !isSafeText(item.platform, 80)
      || !DESTINATION_DIGEST_PATTERN.test(item.destinationDigest)
      || item.attributionCapability.length < 16
      || item.attributionCapability.length > 4_096
    ) {
      throw new AttributionServiceClientError(
        'ATTRIBUTION_CONTACT_CAPABILITY_RESPONSE_INVALID',
        status,
      )
    }
    const key = contactKey(item)
    if (byKey.has(key)) {
      throw new AttributionServiceClientError(
        'ATTRIBUTION_CONTACT_CAPABILITY_RESPONSE_INVALID',
        status,
      )
    }
    byKey.set(key, item)
  }

  return expected.map((item) => {
    const capability = byKey.get(contactKey(item))
    if (!capability) {
      throw new AttributionServiceClientError(
        'ATTRIBUTION_CONTACT_CAPABILITY_RESPONSE_INVALID',
        status,
      )
    }
    return capability
  })
}

function isExactContactInput(
  value: unknown,
): value is AttributionContactCapabilityInput {
  return isExactRecord(value, [
    'contactMethodId',
    'platform',
    'destinationDigest',
  ])
}

function isExactContactResult(
  value: unknown,
): value is AttributionContactCapabilityResult {
  return isExactRecord(value, [
    'contactMethodId',
    'platform',
    'destinationDigest',
    'attributionCapability',
  ])
    && typeof value.attributionCapability === 'string'
}

function isExactRecord(
  value: unknown,
  keys: string[],
): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.keys(value)
  return entries.length === keys.length
    && keys.every(key => key in value)
    && entries.every(key => keys.includes(key))
}

function isExactUnknownRecord(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.keys(value)
  return entries.length === keys.length
    && keys.every(key => key in value)
    && entries.every(key => keys.includes(key))
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function isSafeText(value: unknown, maximum: number) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}

function contactKey(input: AttributionContactCapabilityInput) {
  return [
    input.contactMethodId,
    input.platform,
    input.destinationDigest,
  ].join('\u001f')
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString() === value
}
