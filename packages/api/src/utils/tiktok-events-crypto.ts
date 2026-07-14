import type {
  AdPlatformConversionEventName,
  AdPlatformEncryptedEnvelope,
  AdPlatformSensitiveContext,
} from '@meigallery/shared'
import { ACTIVE_AD_PLATFORM_CONVERSION_EVENTS } from '@meigallery/shared/constants'
import {
  createSecureContextCodec,
  hasOnlyOwnSecureContextFields,
  isPlainSecureContextRecord,
  type SecureContextCryptoKeys,
} from './secure-context-crypto'

const DATA_KEY_ERROR = 'TIKTOK_EVENTS_DATA_KEY_INVALID'
const CONTEXT_ERROR = 'TIKTOK_EVENTS_CONTEXT_INVALID'
const AUTHENTICATION_ERROR = 'TIKTOK_EVENTS_AUTHENTICATION_FAILED'
const PAYLOAD_ERROR = 'TIKTOK_EVENTS_PAYLOAD_INVALID'
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const HASH_PATTERN = /^[0-9a-f]{64}$/
const ACTIVE_EVENT_NAMES = new Set<AdPlatformConversionEventName>(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS)
const CONTEXT_FIELDS = [
  'ttclid',
  'ttp',
  'clientIpAddress',
  'clientUserAgent',
  'emailSha256',
  'externalIdSha256',
] as const

export type TikTokEventsSensitiveContext = Pick<AdPlatformSensitiveContext, typeof CONTEXT_FIELDS[number]>

export interface TikTokEventsEnvelopeAad {
  deliveryId: string
  externalEventId: string
  eventName: AdPlatformConversionEventName
}

export interface TikTokEventsEncryptedEnvelope extends Omit<AdPlatformEncryptedEnvelope, 'expiresAt'> {
  schemaVersion: 2
}

export type TikTokEventsCryptoKeys = SecureContextCryptoKeys

export type TikTokEventsCryptoErrorCode =
  | typeof CONTEXT_ERROR
  | typeof AUTHENTICATION_ERROR
  | typeof PAYLOAD_ERROR

export class TikTokEventsCryptoError extends Error {
  readonly code: TikTokEventsCryptoErrorCode

  constructor(code: TikTokEventsCryptoErrorCode) {
    super(code)
    this.name = 'TikTokEventsCryptoError'
    this.code = code
  }
}

const codec = createSecureContextCodec<TikTokEventsSensitiveContext, TikTokEventsEnvelopeAad>({
  dataKeyError: () => new Error(DATA_KEY_ERROR),
  contextError: () => new TikTokEventsCryptoError(CONTEXT_ERROR),
  authenticationError: () => new TikTokEventsCryptoError(AUTHENTICATION_ERROR),
  payloadError: () => new TikTokEventsCryptoError(PAYLOAD_ERROR),
  encodeAad,
  validateContext,
})

export function loadTikTokEventsCryptoKeys(env: {
  TIKTOK_EVENTS_DATA_KEY_CURRENT?: string
  TIKTOK_EVENTS_DATA_KEY_PREVIOUS?: string
}): Promise<TikTokEventsCryptoKeys> {
  return codec.loadKeys({
    current: env.TIKTOK_EVENTS_DATA_KEY_CURRENT,
    previous: env.TIKTOK_EVENTS_DATA_KEY_PREVIOUS,
  })
}

export function encryptTikTokEventsContext(input: {
  keys: TikTokEventsCryptoKeys
  aad: TikTokEventsEnvelopeAad
  value: TikTokEventsSensitiveContext
}): Promise<TikTokEventsEncryptedEnvelope> {
  return codec.encrypt(input)
}

export function decryptTikTokEventsContext(input: {
  keys: TikTokEventsCryptoKeys
  aad: TikTokEventsEnvelopeAad
  envelope: TikTokEventsEncryptedEnvelope
}): Promise<TikTokEventsSensitiveContext> {
  return codec.decrypt(input)
}

export async function tiktokConnectionFingerprint(pixelId: string, accessToken: string): Promise<string> {
  try {
    if (!isSafeIdentifier(pixelId, 30) || !isSafeIdentifier(accessToken, 4_096)) {
      throw new TikTokEventsCryptoError(CONTEXT_ERROR)
    }
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(accessToken),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`tiktok-events-connection-v1\n${pixelId}`),
    )
    return bytesToHex(new Uint8Array(signature))
  }
  catch {
    throw new TikTokEventsCryptoError(CONTEXT_ERROR)
  }
}

function encodeAad(value: TikTokEventsEnvelopeAad) {
  if (!isPlainSecureContextRecord(value)
    || !hasExactOwnFields(value, ['deliveryId', 'externalEventId', 'eventName'])) {
    throw new TikTokEventsCryptoError(CONTEXT_ERROR)
  }
  const { deliveryId, externalEventId, eventName } = value
  if (!isSafeIdentifier(deliveryId, 96) || !isSafeIdentifier(externalEventId, 160)) {
    throw new TikTokEventsCryptoError(CONTEXT_ERROR)
  }
  if (typeof eventName !== 'string' || !ACTIVE_EVENT_NAMES.has(eventName as AdPlatformConversionEventName)) {
    throw new TikTokEventsCryptoError(CONTEXT_ERROR)
  }
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    provider: 'tiktok',
    deliveryId,
    externalEventId,
    eventName,
  }))
}

function validateContext(value: unknown): TikTokEventsSensitiveContext {
  if (!isPlainSecureContextRecord(value) || !hasOnlyOwnSecureContextFields(value, CONTEXT_FIELDS)) {
    throw new TikTokEventsCryptoError(CONTEXT_ERROR)
  }
  const validated: TikTokEventsSensitiveContext = {}
  for (const field of CONTEXT_FIELDS) {
    if (!Object.hasOwn(value, field)) continue
    const fieldValue = value[field]
    if (typeof fieldValue !== 'string' || !isValidContextField(field, fieldValue)) {
      throw new TikTokEventsCryptoError(CONTEXT_ERROR)
    }
    validated[field] = fieldValue
  }
  return validated
}

function isValidContextField(field: typeof CONTEXT_FIELDS[number], value: string) {
  if (!value || CONTROL_CHARACTER_PATTERN.test(value)) return false
  if (field === 'ttclid') return value.length <= 1_000
  if (field === 'ttp') return value.length <= 256
  if (field === 'clientIpAddress') return value.length <= 64
  if (field === 'clientUserAgent') return value.length <= 512
  return HASH_PATTERN.test(value)
}

function hasExactOwnFields(value: object, fields: Iterable<string>) {
  const requiredFields = fields instanceof Set ? fields : new Set(fields)
  return hasOnlyOwnSecureContextFields(value, requiredFields)
    && Array.from(requiredFields).every(field => Object.hasOwn(value, field))
}

function isSafeIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !CONTROL_CHARACTER_PATTERN.test(value)
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
