import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import type {
  AdapterRuntime,
  BrowserInstructionInput,
  CandidateValidationInput,
  ProviderDeliveryClassification,
  ProviderDeliveryResult,
  QualitySignalResult,
  ServerDeliveryInput,
  ValidationEvidence,
} from './types'

export const CANONICAL_EVENTS = [
  'Contact',
  'CompleteRegistration',
] as const satisfies readonly CanonicalConversionEvent[]

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/
const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const CONTROL_PATTERN = /\p{Cc}/u

export function assertProvider(
  actual: unknown,
  expected: AttributionProvider,
): asserts actual is AttributionProvider {
  if (actual !== expected) {
    throw new AttributionDomainError(
      'ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH',
    )
  }
}

export function assertCandidateBase(
  input: CandidateValidationInput,
  provider: AttributionProvider,
): void {
  assertProvider(input?.provider, provider)
  if (
    !isIdentifier(input.connectionId)
    || !isIdentifier(input.versionId)
    || !isSafeSecret(input.credential)
    || !Array.isArray(input.bindings)
  ) {
    throw adapterInputInvalid()
  }
}

export function validationEvidence(
  runtime: AdapterRuntime,
  input: CandidateValidationInput,
): ValidationEvidence {
  return {
    schemaVersion: 1,
    provider: input.provider,
    connectionId: input.connectionId,
    versionId: input.versionId,
    publicConfigValid: true,
    credentialFormatValid: true,
    bindingsValid: true,
    checkedAt: checkedAt(runtime),
  }
}

export function assertBrowserInput(
  input: BrowserInstructionInput,
  provider: AttributionProvider,
): void {
  assertProvider(input?.provider, provider)
  if (
    !isIdentifier(input.connectionId)
    || !isIdentifier(input.versionId)
    || !isIdentifier(input.deliveryId)
    || !isCanonicalEvent(input.canonicalEvent)
    || !isExternalEventId(input.externalEventId)
    || !isSafeText(input.destination, 512)
    || !isSafeText(input.receiptToken, 4_096)
  ) {
    throw adapterInputInvalid()
  }
}

export function assertServerInput(
  input: ServerDeliveryInput,
  provider: AttributionProvider,
): void {
  assertProvider(input?.provider, provider)
  if (
    !isIdentifier(input.connectionId)
    || !isIdentifier(input.versionId)
    || !isIdentifier(input.deliveryId)
    || !isCanonicalEvent(input.canonicalEvent)
    || !isExternalEventId(input.externalEventId)
    || !isCanonicalTimestamp(input.occurredAt)
    || !isHttpsUrl(input.pageUrl)
    || !isSafeText(input.destination, 512)
    || !isSafeSecret(input.credential)
    || !isStringRecord(input.publicConfig)
    || !isStringRecord(input.identifiers)
    || !Number.isSafeInteger(input.contextIssuedAt)
    || input.contextIssuedAt < 946_684_800
    || input.contextIssuedAt > 4_102_444_799
    || (
      input.hashedEmail !== undefined
      && !HASH_PATTERN.test(input.hashedEmail)
    )
    || (
      input.clientIp !== undefined
      && !isIpAddress(input.clientIp)
    )
    || (
      input.userAgent !== undefined
      && !isSafeText(input.userAgent, 512)
    )
    || !isConsent(input.consent)
    || typeof input.validateOnly !== 'boolean'
  ) {
    throw adapterInputInvalid()
  }
  if (
    input.consent.marketingAllowed !== true
    || input.consent.adUserDataAllowed !== true
  ) {
    throw adapterInputInvalid()
  }
}

export function assertIdentifierKeys(
  identifiers: Record<string, string>,
  allowed: ReadonlySet<string>,
  foreign: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(identifiers)) {
    if (foreign.has(key)) {
      throw new AttributionDomainError(
        'ATTRIBUTION_ADAPTER_PROVIDER_MISMATCH',
      )
    }
    if (!allowed.has(key) || !isSafeText(value, 4_096)) {
      throw adapterInputInvalid()
    }
  }
}

export function exactStringConfig(
  value: unknown,
  required: Readonly<Record<string, RegExp>>,
  optional: Readonly<Record<string, RegExp>> = {},
): Record<string, string> {
  if (!isStringRecord(value)) throw adapterInputInvalid()
  const allowed = new Set([
    ...Object.keys(required),
    ...Object.keys(optional),
  ])
  if (
    Object.keys(value).some(key => !allowed.has(key))
    || Object.entries(required).some(([key, pattern]) =>
      !pattern.test(value[key] ?? ''))
    || Object.entries(optional).some(([key, pattern]) =>
      value[key] !== undefined && !pattern.test(value[key] ?? ''))
    || Object.values(value).some(item => item.trim() !== item)
  ) {
    throw adapterInputInvalid()
  }
  return value
}

export function assertCanonicalBindings(
  input: CandidateValidationInput,
  validateDestination: (
    binding: CandidateValidationInput['bindings'][number],
  ) => boolean,
): void {
  if (
    input.bindings.length !== CANONICAL_EVENTS.length
    || new Set(
      input.bindings.map(binding => binding.canonicalEvent),
    ).size !== CANONICAL_EVENTS.length
    || CANONICAL_EVENTS.some(event =>
      !input.bindings.some(binding => binding.canonicalEvent === event))
    || input.bindings.some(binding =>
      typeof binding.enabled !== 'boolean'
      || !validateDestination(binding))
  ) {
    throw adapterInputInvalid()
  }
}

export function deliveryResult(
  provider: AttributionProvider,
  classification: ProviderDeliveryClassification,
  response?: Response,
  details: {
    requestId?: string
    providerCode?: number
  } = {},
): ProviderDeliveryResult {
  const requestId = safeRequestId(details.requestId)
  return {
    classification,
    provider,
    ...(response ? { httpStatus: response.status } : {}),
    ...(requestId ? { requestId } : {}),
    ...(Number.isSafeInteger(details.providerCode)
      ? { providerCode: details.providerCode }
      : {}),
  }
}

export function unavailableQuality(
  runtime: AdapterRuntime,
  provider: AttributionProvider,
  reason: string,
): QualitySignalResult {
  return {
    availability: 'unavailable',
    provider,
    reason,
    checkedAt: checkedAt(runtime),
  }
}

export function errorQuality(
  runtime: AdapterRuntime,
  provider: AttributionProvider,
  reason: string,
): QualitySignalResult {
  return {
    availability: 'error',
    provider,
    reason,
    checkedAt: checkedAt(runtime),
  }
}

export function runtimeFetcher(runtime: AdapterRuntime): typeof fetch {
  return runtime.fetcher ?? ((input, init) => fetch(input, init))
}

export function checkedAt(runtime: AdapterRuntime): string {
  const value = (runtime.now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw adapterInputInvalid()
  return value.toISOString()
}

export function eventTimeSeconds(occurredAt: string): number {
  const value = Date.parse(occurredAt) / 1_000
  if (!Number.isSafeInteger(value)) throw adapterInputInvalid()
  return value
}

export function safeRequestId(value: unknown): string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
    ? value
    : ''
}

export function isSafeSecret(value: unknown): value is string {
  return isSafeText(value, 32_768) && value.trim() === value
}

export function isSafeText(
  value: unknown,
  maximum: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !CONTROL_PATTERN.test(value)
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

export function isExternalEventId(value: unknown): value is string {
  return typeof value === 'string'
    && EXTERNAL_EVENT_ID_PATTERN.test(value)
}

export function isCanonicalEvent(
  value: unknown,
): value is CanonicalConversionEvent {
  return value === 'Contact' || value === 'CompleteRegistration'
}

export function adapterInputInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_ADAPTER_INPUT_INVALID')
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isSafeText(value, 64)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function isHttpsUrl(value: unknown): value is string {
  if (!isSafeText(value, 2_048)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return (
    prototype === Object.prototype
    || prototype === null
  ) && Object.values(value).every(item => typeof item === 'string')
}

function isConsent(value: unknown): value is ServerDeliveryInput['consent'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const consent = value as Record<string, unknown>
  return Object.keys(consent).length === 3
    && typeof consent.marketingAllowed === 'boolean'
    && typeof consent.adUserDataAllowed === 'boolean'
    && typeof consent.adPersonalizationAllowed === 'boolean'
}

function isIpAddress(value: unknown): value is string {
  if (!isSafeText(value, 45)) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every(part => {
      const number = Number(part)
      return Number.isInteger(number) && number >= 0 && number <= 255
    })
  }
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) {
    return false
  }
  try {
    return Boolean(new URL(`http://[${value}]/`).hostname)
  } catch {
    return false
  }
}
