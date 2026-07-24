import {
  isAttributionBusinessEventV1,
  type AttributionBusinessEventV1,
} from '@meigallery/shared'

const ATTRIBUTION_INTERNAL_ORIGIN = 'https://attribution.internal'
const PRIVACY_DECISION_PATH = '/internal/v1/privacy-decision'
const REGISTRATION_EVENTS_PATH = '/internal/v1/registration-events'
const CONTACT_CAPABILITIES_PATH = '/internal/v1/contact-capabilities'
const BROWSER_INSTRUCTION_PATH_PREFIX = '/internal/v1/events/'
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const CONTACT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const DESTINATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const CONTACT_BATCH_LIMIT = 100

export interface AttributionServiceBinding {
  fetch(request: Request): Promise<Response>
}

export interface AttributionServiceClient {
  resolvePrivacyDecision(
    input: AttributionPrivacyDecisionInput,
  ): Promise<AttributionPrivacyDecisionResult>
  ingestRegistrationEvent(
    input: AttributionBusinessEventV1,
  ): Promise<{ accepted: true; eventId: string }>
  getSignedBrowserInstruction(
    input: { eventId: string },
  ): Promise<{ instructionToken: string }>
  getSignedContactCapabilities(
    input: AttributionContactCapabilityInput[],
  ): Promise<AttributionContactCapabilityResult[]>
}

export interface AttributionPrivacyDecisionInput {
  privacyToken: string | null
  country: string | null
  gpc: boolean
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

    async ingestRegistrationEvent(input) {
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

    async getSignedBrowserInstruction(input) {
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
          headers: { Accept: 'application/json' },
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
