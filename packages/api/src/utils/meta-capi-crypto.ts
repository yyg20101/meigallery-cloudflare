import type {
  ActiveMetaEventName,
  MetaCapiEncryptedEnvelope as SharedMetaCapiEncryptedEnvelope,
  MetaCapiSensitiveContext as SharedMetaCapiSensitiveContext,
} from '@meigallery/shared'

const DATA_KEY_ERROR = 'META_CAPI_DATA_KEY_INVALID'
const CONTEXT_ERROR = 'META_CAPI_CONTEXT_INVALID'
const AES_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const HASH_PATTERN = /^[0-9a-f]{64}$/
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/
const BASE64_KEY_PATTERN = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const FBP_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const FBC_PATTERN = /^fb\.1\.\d{10,16}\.[A-Za-z0-9._-]{1,128}$/
const ACTIVE_EVENT_NAMES = new Set<ActiveMetaEventName>(['Contact', 'CompleteRegistration'])
const CONTEXT_FIELDS = [
  'fbp',
  'fbc',
  'clientIpAddress',
  'clientUserAgent',
  'emailSha256',
  'externalIdSha256',
] as const
const ENVELOPE_FIELDS = new Set(['schemaVersion', 'keyId', 'iv', 'ciphertext', 'tag'])

export interface MetaCapiSensitiveContext extends SharedMetaCapiSensitiveContext {
  emailSha256?: string
  externalIdSha256?: string
}

export interface MetaCapiEnvelopeAad {
  deliveryId: string
  externalEventId: string
  eventName: ActiveMetaEventName
}

export interface MetaCapiEncryptedEnvelope extends Omit<SharedMetaCapiEncryptedEnvelope, 'expiresAt'> {
  schemaVersion: 2
}

export interface MetaCapiCryptoKeys {
  current: { id: string; key: CryptoKey }
  previous?: { id: string; key: CryptoKey }
}

export async function loadMetaCapiCryptoKeys(env: {
  META_CAPI_DATA_KEY_CURRENT?: string
  META_CAPI_DATA_KEY_PREVIOUS?: string
}): Promise<MetaCapiCryptoKeys> {
  try {
    const current = await importDataKey(env.META_CAPI_DATA_KEY_CURRENT)
    if (env.META_CAPI_DATA_KEY_PREVIOUS === undefined) return { current }

    const previous = await importDataKey(env.META_CAPI_DATA_KEY_PREVIOUS)
    return previous.id === current.id ? { current } : { current, previous }
  }
  catch {
    throw stableError(DATA_KEY_ERROR)
  }
}

export async function encryptMetaCapiContext(input: {
  keys: MetaCapiCryptoKeys
  aad: MetaCapiEnvelopeAad
  value: MetaCapiSensitiveContext
}): Promise<MetaCapiEncryptedEnvelope> {
  try {
    validateCryptoKey(input.keys.current)
    const additionalData = encodeAad(input.aad)
    const plaintext = new TextEncoder().encode(JSON.stringify(validateContext(input.value)))
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData,
      tagLength: AES_GCM_TAG_BYTES * 8,
    }, input.keys.current.key, plaintext))
    const tagOffset = sealed.length - AES_GCM_TAG_BYTES
    if (tagOffset <= 0) throw stableError(CONTEXT_ERROR)

    return {
      schemaVersion: 2,
      keyId: input.keys.current.id,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(sealed.slice(0, tagOffset)),
      tag: encodeBase64Url(sealed.slice(tagOffset)),
    }
  }
  catch {
    throw stableError(CONTEXT_ERROR)
  }
}

export async function decryptMetaCapiContext(input: {
  keys: MetaCapiCryptoKeys
  aad: MetaCapiEnvelopeAad
  envelope: MetaCapiEncryptedEnvelope
}): Promise<MetaCapiSensitiveContext> {
  try {
    const additionalData = encodeAad(input.aad)
    const envelope = validateEnvelope(input.envelope)
    const selected = [input.keys.current, input.keys.previous]
      .find(candidate => candidate?.id === envelope.keyId)
    if (!selected) throw stableError(CONTEXT_ERROR)
    validateCryptoKey(selected)

    const sealed = concatenateBytes(envelope.ciphertext, envelope.tag)
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: envelope.iv,
      additionalData,
      tagLength: AES_GCM_TAG_BYTES * 8,
    }, selected.key, sealed)
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext))
    return validateContext(parsed)
  }
  catch {
    throw stableError(CONTEXT_ERROR)
  }
}

export async function metaConnectionFingerprint(pixelId: string, accessToken: string): Promise<string> {
  try {
    if (!isNonEmptyIdentifier(pixelId) || !isNonEmptyIdentifier(accessToken)) {
      throw stableError(CONTEXT_ERROR)
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
      encoder.encode(`meta-connection-v1\n${pixelId}`),
    )
    return bytesToHex(new Uint8Array(signature))
  }
  catch {
    throw stableError(CONTEXT_ERROR)
  }
}

async function importDataKey(value: string | undefined) {
  if (typeof value !== 'string') throw stableError(DATA_KEY_ERROR)
  const canonical = value.trim()
  if (!BASE64_KEY_PATTERN.test(canonical)) throw stableError(DATA_KEY_ERROR)
  const raw = decodeBase64(canonical)
  if (raw.length !== AES_KEY_BYTES || encodeBase64(raw) !== canonical) {
    throw stableError(DATA_KEY_ERROR)
  }
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id: bytesToHex(new Uint8Array(digest)).slice(0, 16), key }
}

function encodeAad(value: MetaCapiEnvelopeAad) {
  if (!isPlainRecord(value)) throw stableError(CONTEXT_ERROR)
  if (!hasOnlyFields(value, ['deliveryId', 'externalEventId', 'eventName'])) {
    throw stableError(CONTEXT_ERROR)
  }
  const { deliveryId, externalEventId, eventName } = value
  if (!isNonEmptyIdentifier(deliveryId) || !isNonEmptyIdentifier(externalEventId)) {
    throw stableError(CONTEXT_ERROR)
  }
  if (typeof eventName !== 'string' || !ACTIVE_EVENT_NAMES.has(eventName as ActiveMetaEventName)) {
    throw stableError(CONTEXT_ERROR)
  }
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    deliveryId,
    externalEventId,
    eventName,
  }))
}

function validateEnvelope(value: MetaCapiEncryptedEnvelope) {
  if (!isPlainRecord(value) || !hasOnlyFields(value, ENVELOPE_FIELDS)) {
    throw stableError(CONTEXT_ERROR)
  }
  if (value.schemaVersion !== 2 || typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    throw stableError(CONTEXT_ERROR)
  }
  return {
    keyId: value.keyId,
    iv: decodeBase64Url(value.iv, AES_GCM_IV_BYTES),
    ciphertext: decodeBase64Url(value.ciphertext),
    tag: decodeBase64Url(value.tag, AES_GCM_TAG_BYTES),
  }
}

function validateContext(value: unknown): MetaCapiSensitiveContext {
  if (!isPlainRecord(value) || !hasOnlyFields(value, CONTEXT_FIELDS)) {
    throw stableError(CONTEXT_ERROR)
  }
  const validated: MetaCapiSensitiveContext = {}
  for (const field of CONTEXT_FIELDS) {
    const fieldValue = value[field]
    if (fieldValue === undefined) continue
    if (typeof fieldValue !== 'string' || !isValidContextField(field, fieldValue)) {
      throw stableError(CONTEXT_ERROR)
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

function validateCryptoKey(value: { id: string; key: CryptoKey }) {
  if (!value || !KEY_ID_PATTERN.test(value.id) || !value.key) throw stableError(CONTEXT_ERROR)
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function decodeBase64Url(value: unknown, expectedLength?: number) {
  if (typeof value !== 'string' || !BASE64_URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw stableError(CONTEXT_ERROR)
  }
  const standard = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const bytes = decodeBase64(standard)
  if (encodeBase64Url(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    throw stableError(CONTEXT_ERROR)
  }
  return bytes
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function encodeBase64Url(bytes: Uint8Array) {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function concatenateBytes(first: Uint8Array, second: Uint8Array) {
  const combined = new Uint8Array(first.length + second.length)
  combined.set(first)
  combined.set(second, first.length)
  return combined
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !CONTROL_CHARACTER_PATTERN.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyFields(value: object, allowed: Iterable<string>) {
  const allowedFields = allowed instanceof Set ? allowed : new Set(allowed)
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowedFields.has(key))
}

function stableError(code: string) {
  return new Error(code)
}
