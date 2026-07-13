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

const DATA_KEY_ERROR = 'META_CAPI_DATA_KEY_INVALID'
const CONTEXT_ERROR = 'META_CAPI_CONTEXT_INVALID'
const AUTHENTICATION_ERROR = 'META_CAPI_AUTHENTICATION_FAILED'
const PAYLOAD_ERROR = 'META_CAPI_PAYLOAD_INVALID'
const HASH_PATTERN = /^[0-9a-f]{64}$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const ACTIVE_EVENT_NAMES = new Set<AdPlatformConversionEventName>(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS)
const CONTEXT_FIELDS = [
  'fbp',
  'fbc',
  'clientIpAddress',
  'clientUserAgent',
  'emailSha256',
  'externalIdSha256',
] as const

export type MetaCapiSensitiveContext = Pick<AdPlatformSensitiveContext, typeof CONTEXT_FIELDS[number]>

export interface MetaCapiEnvelopeAad {
  deliveryId: string
  externalEventId: string
  eventName: AdPlatformConversionEventName
}

export interface MetaCapiEncryptedEnvelope extends Omit<AdPlatformEncryptedEnvelope, 'expiresAt'> {
  schemaVersion: 2
}

export type MetaCapiCryptoKeys = SecureContextCryptoKeys

export type MetaCapiCryptoErrorCode =
  | typeof CONTEXT_ERROR
  | typeof AUTHENTICATION_ERROR
  | typeof PAYLOAD_ERROR

export class MetaCapiCryptoError extends Error {
  readonly code: MetaCapiCryptoErrorCode

  constructor(code: MetaCapiCryptoErrorCode) {
    super(code)
    this.name = 'MetaCapiCryptoError'
    this.code = code
  }
}

const codec = createSecureContextCodec<MetaCapiSensitiveContext, MetaCapiEnvelopeAad>({
  dataKeyError: () => new Error(DATA_KEY_ERROR),
  contextError: () => new MetaCapiCryptoError(CONTEXT_ERROR),
  authenticationError: () => new MetaCapiCryptoError(AUTHENTICATION_ERROR),
  payloadError: () => new MetaCapiCryptoError(PAYLOAD_ERROR),
  encodeAad,
  validateContext,
})

export function loadMetaCapiCryptoKeys(env: {
  META_CAPI_DATA_KEY_CURRENT?: string
  META_CAPI_DATA_KEY_PREVIOUS?: string
}): Promise<MetaCapiCryptoKeys> {
  return codec.loadKeys({
    current: env.META_CAPI_DATA_KEY_CURRENT,
    previous: env.META_CAPI_DATA_KEY_PREVIOUS,
  })
}

export function encryptMetaCapiContext(input: {
  keys: MetaCapiCryptoKeys
  aad: MetaCapiEnvelopeAad
  value: MetaCapiSensitiveContext
}): Promise<MetaCapiEncryptedEnvelope> {
  return codec.encrypt(input)
}

export function decryptMetaCapiContext(input: {
  keys: MetaCapiCryptoKeys
  aad: MetaCapiEnvelopeAad
  envelope: MetaCapiEncryptedEnvelope
}): Promise<MetaCapiSensitiveContext> {
  return codec.decrypt(input)
}

export async function metaConnectionFingerprint(pixelId: string, accessToken: string): Promise<string> {
  try {
    if (!isNonEmptyIdentifier(pixelId) || !isNonEmptyIdentifier(accessToken)) throw new Error(CONTEXT_ERROR)
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
      encoder.encode(`meta-connection-v1\n${pixelId}`),
    )
    return bytesToHex(new Uint8Array(signature))
  }
  catch {
    throw new MetaCapiCryptoError(CONTEXT_ERROR)
  }
}

function encodeAad(value: MetaCapiEnvelopeAad) {
  if (!isPlainSecureContextRecord(value)
    || !hasExactOwnFields(value, ['deliveryId', 'externalEventId', 'eventName'])) {
    throw new MetaCapiCryptoError(CONTEXT_ERROR)
  }
  const { deliveryId, externalEventId, eventName } = value
  if (!isNonEmptyIdentifier(deliveryId) || !isNonEmptyIdentifier(externalEventId)) {
    throw new MetaCapiCryptoError(CONTEXT_ERROR)
  }
  if (typeof eventName !== 'string' || !ACTIVE_EVENT_NAMES.has(eventName as AdPlatformConversionEventName)) {
    throw new MetaCapiCryptoError(CONTEXT_ERROR)
  }
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    deliveryId,
    externalEventId,
    eventName,
  }))
}

function validateContext(value: unknown): MetaCapiSensitiveContext {
  if (!isPlainSecureContextRecord(value) || !hasOnlyOwnSecureContextFields(value, CONTEXT_FIELDS)) {
    throw new MetaCapiCryptoError(CONTEXT_ERROR)
  }
  const validated: MetaCapiSensitiveContext = {}
  for (const field of CONTEXT_FIELDS) {
    if (!Object.hasOwn(value, field)) continue
    const fieldValue = value[field]
    if (typeof fieldValue !== 'string' || !isValidContextField(field, fieldValue)) {
      throw new MetaCapiCryptoError(CONTEXT_ERROR)
    }
    validated[field] = fieldValue
  }
  return validated
}

function isValidContextField(field: typeof CONTEXT_FIELDS[number], value: string) {
  if (!value || CONTROL_CHARACTER_PATTERN.test(value)) return false
  if (field === 'fbp') return FBP_PATTERN.test(value)
  if (field === 'fbc') return FBC_PATTERN.test(value)
  if (field === 'clientIpAddress') return value.length <= 64
  if (field === 'clientUserAgent') return value.length <= 512
  return HASH_PATTERN.test(value)
}

function hasExactOwnFields(value: object, fields: Iterable<string>) {
  const requiredFields = fields instanceof Set ? fields : new Set(fields)
  return hasOnlyOwnSecureContextFields(value, requiredFields)
    && Array.from(requiredFields).every(field => Object.hasOwn(value, field))
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !CONTROL_CHARACTER_PATTERN.test(value)
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
