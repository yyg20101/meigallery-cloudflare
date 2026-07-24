import type {
  AdAttributionProvider,
  CanonicalConversionEvent,
} from './ad-attribution'

export const ATTRIBUTION_CONTRACT_VERSION = 1 as const
export const ATTRIBUTION_CONTEXT_COOKIE_NAME =
  '__Secure-mg_attribution_context'
export const ATTRIBUTION_PRIVACY_COOKIE_NAME =
  '__Secure-mg_attribution_privacy'

export type AttributionProvider = AdAttributionProvider

export type ConnectionVersionStatus =
  | 'candidate'
  | 'validating'
  | 'ready'
  | 'active'
  | 'draining'
  | 'failed'
  | 'superseded'
  | 'retired'

export interface AttributionBusinessEventV1 {
  schemaVersion: typeof ATTRIBUTION_CONTRACT_VERSION
  eventId: string
  eventName: CanonicalConversionEvent
  occurredAt: string
  pagePath: string
  dedupeKey: string
  sourceContextToken: string | null
  consent: {
    marketingAllowed: boolean
    adUserDataAllowed: boolean
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
}

export interface AttributionRuntimeLeaseV1 {
  schemaVersion: typeof ATTRIBUTION_CONTRACT_VERSION
  connectionId: string
  versionId: string
  provider: AttributionProvider
  issuedAt: number
  expiresAt: number
  signature: string
}

export interface AttributionBrowserInstructionV1 {
  schemaVersion: typeof ATTRIBUTION_CONTRACT_VERSION
  deliveryId: string
  provider: AttributionProvider
  canonicalEvent: CanonicalConversionEvent
  eventName: string
  destination: string
  externalEventId: string
  receiptToken: string
  payload: Record<string, string | number | boolean>
}

export interface AttributionServiceContractV1 {
  ingestRegistrationEvent(
    input: AttributionBusinessEventV1,
  ): Promise<{ accepted: true; eventId: string }>
  dispatchBusinessOutbox(
    input: { limit: number },
  ): Promise<{ claimed: number; accepted: number }>
  getSignedBrowserInstruction(
    input: { eventId: string },
  ): Promise<{ instructionToken: string }>
}

export function isAttributionBusinessEventV1(
  value: unknown,
): value is AttributionBusinessEventV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'eventId',
    'eventName',
    'occurredAt',
    'pagePath',
    'dedupeKey',
    'sourceContextToken',
    'consent',
    'payload',
  ])) return false

  return value.schemaVersion === ATTRIBUTION_CONTRACT_VERSION
    && (value.eventName === 'Contact' || value.eventName === 'CompleteRegistration')
    && isIdentifier(value.eventId)
    && isIdentifier(value.dedupeKey, 240)
    && typeof value.occurredAt === 'string'
    && Number.isFinite(Date.parse(value.occurredAt))
    && isSafePagePath(value.pagePath)
    && (value.sourceContextToken === null || isNonEmptyText(value.sourceContextToken, 4_096))
    && isConsentV1(value.consent)
    && isCanonicalPayload(value.eventName, value.payload)
}

function isConsentV1(value: unknown) {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'marketingAllowed',
      'adUserDataAllowed',
      'adPersonalizationAllowed',
    ])
    && typeof value.marketingAllowed === 'boolean'
    && typeof value.adUserDataAllowed === 'boolean'
    && typeof value.adPersonalizationAllowed === 'boolean'
}

function isCanonicalPayload(eventName: CanonicalConversionEvent, value: unknown) {
  if (!isPlainRecord(value)) return false
  if (eventName === 'Contact') {
    return hasExactKeys(value, [
      'contactMethodId',
      'contactPlatform',
      'contactAction',
    ])
      && isIdentifier(value.contactMethodId)
      && isNonEmptyText(value.contactPlatform, 80)
      && (value.contactAction === 'open_link' || value.contactAction === 'copy')
  }

  return hasExactKeys(value, ['userId'], ['hashedEmail'])
    && Number.isSafeInteger(value.userId)
    && Number(value.userId) > 0
    && (value.hashedEmail === undefined
      || (typeof value.hashedEmail === 'string' && /^[0-9a-f]{64}$/.test(value.hashedEmail)))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value)
    && keys.every(key => allowed.has(key))
}

function isIdentifier(value: unknown, maximum = 160) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function isNonEmptyText(value: unknown, maximum: number) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}

function isSafePagePath(value: unknown) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('#')
    || /\p{Cc}/u.test(value)
  ) {
    return false
  }
  try {
    const base = new URL('https://attribution.invalid/')
    const resolved = new URL(value, base)
    return resolved.origin === base.origin
      && `${resolved.pathname}${resolved.search}` === value
  } catch {
    return false
  }
}
