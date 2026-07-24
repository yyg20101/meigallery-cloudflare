import type {
  AttributionProvider,
  CanonicalConversionEvent,
} from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import { isAllowedAttributionOrigin } from '../domain/origin-policy'
import type { AttributionQueueMessage } from '../domain/queue'
import type { AttributionAppEnvironment } from '../env'
import {
  openAttributionData,
  type AttributionEncryptionKeys,
} from '../security/data-envelope'
import type {
  DeliverySnapshot,
  ServerOutboxPayload,
} from './queue-types'

const PROVIDERS = new Set<AttributionProvider>([
  'meta',
  'tiktok',
  'google',
])
const RETRY_DELAYS = [30, 60, 300, 900, 3_600] as const
const OUTBOX_PURPOSE = 'delivery-outbox'
const EXACT_OUTBOX_KEYS = [
  'schemaVersion',
  'factId',
  'deliveryId',
  'provider',
  'connectionId',
  'versionId',
  'transport',
  'destination',
  'externalEventId',
  'eventName',
  'occurredAt',
  'pagePath',
  'consent',
  'payload',
  'context',
  'requestMetadata',
]

export function isQueueMessage(
  value: unknown,
): value is AttributionQueueMessage {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'schemaVersion',
      'provider',
      'deliveryId',
    ])
    && value.schemaVersion === 1
    && PROVIDERS.has(value.provider as AttributionProvider)
    && isIdentifier(value.deliveryId)
}

export async function openServerPayload(
  keys: AttributionEncryptionKeys,
  row: DeliverySnapshot,
): Promise<ServerOutboxPayload> {
  const plaintext = await openAttributionData(keys, {
    purpose: OUTBOX_PURPOSE,
    identity: `${row.deliveryId}:${row.provider}:${row.versionId}`,
    envelope: row.outboxEnvelope,
  })
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    throw queueInvalid()
  }
  if (!isServerOutboxPayload(value)) throw queueInvalid()
  return value
}

export function assertPayloadMatchesSnapshot(
  payload: ServerOutboxPayload,
  row: DeliverySnapshot,
): void {
  if (
    payload.factId !== row.factId
    || payload.deliveryId !== row.deliveryId
    || payload.provider !== row.provider
    || payload.connectionId !== row.connectionId
    || payload.versionId !== row.versionId
    || payload.destination !== row.destination
    || payload.externalEventId !== row.externalEventId
    || payload.eventName !== row.eventName
  ) {
    throw new AttributionDomainError(
      'ATTRIBUTION_QUEUE_PROVIDER_MISMATCH',
    )
  }
}

export function hashedEmail(
  payload: ServerOutboxPayload,
): { hashedEmail?: string } {
  if (
    payload.eventName === 'CompleteRegistration'
    && 'hashedEmail' in payload.payload
    && payload.payload.hashedEmail
  ) {
    return { hashedEmail: payload.payload.hashedEmail }
  }
  return {}
}

export function pageUrl(
  origins: readonly string[],
  path: string,
  appEnvironment: AttributionAppEnvironment,
): string {
  const origin = origins[0]
  if (!origin || !isSafePagePath(path)) throw queueInvalid()
  const url = new URL(path, origin)
  if (
    !isAllowedAttributionOrigin(url, appEnvironment)
    || url.origin !== new URL(origin).origin
    || url.username
    || url.password
    || url.hash
  ) {
    throw queueInvalid()
  }
  return url.toString()
}

export function parseStringRecord(value: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw queueInvalid()
  }
  if (!isStringRecord(parsed, 4_096)) throw queueInvalid()
  return parsed
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9:_-]{1,240}$/.test(value)
}

export function isExternalEventId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function isCanonicalEvent(
  value: unknown,
): value is CanonicalConversionEvent {
  return value === 'Contact' || value === 'CompleteRegistration'
}

export function isSafeText(
  value: unknown,
  maximum: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}

export function asProvider(value: unknown): AttributionProvider {
  if (!PROVIDERS.has(value as AttributionProvider)) throw queueInvalid()
  return value as AttributionProvider
}

export function isRolloutPercentage(
  value: number,
): value is 0 | 10 | 50 | 100 {
  return value === 0 || value === 10 || value === 50 || value === 100
}

export function trustedNow(now?: () => Date): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw queueInvalid()
  return value
}

export function outboxExpired(value: string, now: Date): boolean {
  return timestamp(value) <= now.getTime()
}

export function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

export function retryDelay(attempt: number): number {
  const normalized = Number.isSafeInteger(attempt)
    ? Math.max(1, attempt)
    : 1
  return RETRY_DELAYS[
    Math.min(RETRY_DELAYS.length - 1, normalized - 1)
  ] ?? 3_600
}

export function changed(result: D1Result<unknown> | undefined): boolean {
  return Number(result?.meta.changes ?? 0) > 0
}

export function queueInvalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_QUEUE_MESSAGE_INVALID')
}

function isServerOutboxPayload(
  value: unknown,
): value is ServerOutboxPayload {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, EXACT_OUTBOX_KEYS)
    || value.schemaVersion !== 1
    || !isIdentifier(value.factId)
    || !isIdentifier(value.deliveryId)
    || !PROVIDERS.has(value.provider as AttributionProvider)
    || !isIdentifier(value.connectionId)
    || !isIdentifier(value.versionId)
    || value.transport !== 'server'
    || !isSafeText(value.destination, 512)
    || !isExternalEventId(value.externalEventId)
    || !isCanonicalEvent(value.eventName)
    || !isCanonicalTimestamp(value.occurredAt)
    || !isSafePagePath(value.pagePath)
    || !isConsent(value.consent)
    || !isContext(value.context)
    || !isRequestMetadata(value.requestMetadata)
  ) {
    return false
  }
  return isCanonicalPayload(value.eventName, value.payload)
}

function isConsent(
  value: unknown,
): value is ServerOutboxPayload['consent'] {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'marketingAllowed',
      'adUserDataAllowed',
      'adPersonalizationAllowed',
    ])
    && value.marketingAllowed === true
    && value.adUserDataAllowed === true
    && typeof value.adPersonalizationAllowed === 'boolean'
}

function isContext(
  value: unknown,
): value is ServerOutboxPayload['context'] {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sourceId', 'issuedAt', 'identifiers'])
    && isIdentifier(value.sourceId)
    && Number.isSafeInteger(value.issuedAt)
    && Number(value.issuedAt) >= 946_684_800
    && Number(value.issuedAt) <= 4_102_444_799
    && isStringRecord(value.identifiers, 4_096)
}

function isRequestMetadata(
  value: unknown,
): value is ServerOutboxPayload['requestMetadata'] {
  return isPlainRecord(value)
    && hasExactKeys(value, [], ['clientIp', 'userAgent'])
    && (
      value.clientIp === undefined
      || isSafeText(value.clientIp, 128)
    )
    && (
      value.userAgent === undefined
      || isSafeText(value.userAgent, 1_024)
    )
}

function isCanonicalPayload(
  event: CanonicalConversionEvent,
  value: unknown,
): value is ServerOutboxPayload['payload'] {
  if (!isPlainRecord(value)) return false
  if (event === 'Contact') {
    return hasExactKeys(value, [
      'contactMethodId',
      'contactPlatform',
      'contactAction',
    ])
      && isIdentifier(value.contactMethodId)
      && isSafeText(value.contactPlatform, 80)
      && (
        value.contactAction === 'open_link'
        || value.contactAction === 'copy'
      )
  }
  return hasExactKeys(value, ['userId'], ['hashedEmail'])
    && Number.isSafeInteger(value.userId)
    && Number(value.userId) > 0
    && (
      value.hashedEmail === undefined
      || (
        typeof value.hashedEmail === 'string'
        && /^[0-9a-f]{64}$/.test(value.hashedEmail)
      )
    )
}

function isStringRecord(
  value: unknown,
  maximum: number,
): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.entries(value).every(([key, item]) =>
      /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)
      && isSafeText(item, maximum))
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every(key => key in value)
    && keys.every(key => allowed.has(key))
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isSafeText(value, 64)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function isSafePagePath(value: unknown): value is string {
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
