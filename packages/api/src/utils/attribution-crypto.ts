const AES_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/
const BASE64_KEY_PATTERN = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const PURPOSES = new Set<AttributionCryptoPurpose>([
  'credential', 'outbox', 'context', 'verification_input', 'event_id',
])
const AAD_FIELDS = new Set(['purpose', 'provider', 'subjectId', 'revision'])
const ENVELOPE_FIELDS = new Set(['schemaVersion', 'keyId', 'iv', 'ciphertext', 'tag'])
const HKDF_SALT = new TextEncoder().encode('meigallery-attribution-hkdf-salt-v1')
const writableRoots = new WeakSet<AttributionDerivedKeyRoot>()
const rootKeys = new WeakMap<AttributionDerivedKeyRoot, CryptoKey>()

type AesKeyUsage = 'encrypt' | 'decrypt'

export type AttributionCryptoPurpose = 'credential' | 'outbox' | 'context' | 'verification_input' | 'event_id'

export interface AttributionAad {
  purpose: AttributionCryptoPurpose
  provider: string
  subjectId: string
  revision: string
}

export interface AttributionEncryptedEnvelope {
  schemaVersion: 1
  keyId: string
  iv: string
  ciphertext: string
  tag: string
}

export interface AttributionCryptoKeys {
  current: AttributionDerivedKeyRoot
  previous?: AttributionDerivedKeyRoot
}

class AttributionDerivedKeyRoot {
  readonly id: string

  constructor(id: string, key: CryptoKey) {
    this.id = id
    rootKeys.set(this, key)
  }
}

export type AttributionCryptoErrorCode =
  | 'ATTRIBUTION_CRYPTO_KEY_INVALID'
  | 'ATTRIBUTION_CRYPTO_CONTEXT_INVALID'
  | 'ATTRIBUTION_CRYPTO_AUTHENTICATION_FAILED'

export class AttributionCryptoError extends Error {
  readonly code: AttributionCryptoErrorCode

  constructor(code: AttributionCryptoErrorCode) {
    super(code)
    this.name = 'AttributionCryptoError'
    this.code = code
  }
}

export async function loadAttributionCryptoKeys(env: {
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
}): Promise<AttributionCryptoKeys> {
  try {
    const current = await importMasterKey(env.AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT)
    writableRoots.add(current)
    if (env.AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS === undefined) return { current }
    const previous = await importMasterKey(env.AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS)
    return previous.id === current.id ? { current } : { current, previous }
  }
  catch {
    throw keyError()
  }
}

export async function encryptAttributionValue(input: {
  keys: AttributionCryptoKeys
  aad: AttributionAad
  plaintext: string
}): Promise<AttributionEncryptedEnvelope> {
  try {
    validateKeyRoot(input.keys.current)
    if (!writableRoots.has(input.keys.current)) throw contextError()
    if (typeof input.plaintext !== 'string') throw contextError()
    const additionalData = encodeAad(input.aad)
    const key = await deriveAesKey(input.keys.current, input.aad.purpose, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData,
      tagLength: AES_GCM_TAG_BYTES * 8,
    }, key, new TextEncoder().encode(input.plaintext)))
    const tagOffset = sealed.length - AES_GCM_TAG_BYTES
    if (tagOffset < 0) throw contextError()

    return {
      schemaVersion: 1,
      keyId: input.keys.current.id,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(sealed.slice(0, tagOffset)),
      tag: encodeBase64Url(sealed.slice(tagOffset)),
    }
  }
  catch {
    throw contextError()
  }
}

export async function decryptAttributionValue(input: {
  keys: AttributionCryptoKeys
  aad: AttributionAad
  envelope: AttributionEncryptedEnvelope
}): Promise<string> {
  let envelope: ReturnType<typeof validateEnvelope>
  let selected: AttributionDerivedKeyRoot
  let additionalData: Uint8Array
  try {
    additionalData = encodeAad(input.aad)
    envelope = validateEnvelope(input.envelope)
    const candidate = [input.keys.current, input.keys.previous].find(item => item?.id === envelope.keyId)
    if (!candidate) throw contextError()
    validateKeyRoot(candidate)
    selected = candidate
  }
  catch {
    throw contextError()
  }

  let plaintext: ArrayBuffer
  try {
    const key = await deriveAesKey(selected, input.aad.purpose, ['decrypt'])
    plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: envelope.iv,
      additionalData,
      tagLength: AES_GCM_TAG_BYTES * 8,
    }, key, concatenateBytes(envelope.ciphertext, envelope.tag))
  }
  catch {
    throw authenticationError()
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)
  }
  catch {
    throw authenticationError()
  }
}

/** 为 event_id 等不可逆用途提供独立 HMAC 派生能力。 */
export async function deriveAttributionHmacKey(input: {
  keys: AttributionCryptoKeys
  purpose: AttributionCryptoPurpose
}): Promise<CryptoKey> {
  try {
    validateKeyRoot(input.keys.current)
    if (!writableRoots.has(input.keys.current)) throw contextError()
    if (!PURPOSES.has(input.purpose)) throw contextError()
    return crypto.subtle.deriveKey({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: hkdfInfo(input.purpose, 'hmac-sha256'),
    }, keyForRoot(input.keys.current), { name: 'HMAC', hash: 'SHA-256', length: AES_KEY_BYTES * 8 }, false, ['sign'])
  }
  catch {
    throw contextError()
  }
}

async function importMasterKey(value: string | undefined): Promise<AttributionDerivedKeyRoot> {
  if (typeof value !== 'string') throw keyError()
  const canonical = value.trim()
  if (!BASE64_KEY_PATTERN.test(canonical)) throw keyError()
  const raw = decodeBase64(canonical)
  if (raw.length !== AES_KEY_BYTES || encodeBase64(raw) !== canonical) throw keyError()
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  return new AttributionDerivedKeyRoot(bytesToHex(new Uint8Array(digest)).slice(0, 16), key)
}

function encodeAad(value: AttributionAad) {
  if (!isPlainRecord(value) || !hasExactOwnFields(value, AAD_FIELDS)) throw contextError()
  if (!PURPOSES.has(value.purpose)
    || !isSafeIdentifier(value.provider)
    || !isSafeIdentifier(value.subjectId)
    || !isSafeIdentifier(value.revision)) throw contextError()
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    purpose: value.purpose,
    provider: value.provider,
    subjectId: value.subjectId,
    revision: value.revision,
  }))
}

function validateEnvelope(value: AttributionEncryptedEnvelope) {
  if (!isPlainRecord(value) || !hasExactOwnFields(value, ENVELOPE_FIELDS)) throw contextError()
  if (value.schemaVersion !== 1 || typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    throw contextError()
  }
  return {
    keyId: value.keyId,
    iv: decodeBase64Url(value.iv, AES_GCM_IV_BYTES),
    ciphertext: decodeBase64Url(value.ciphertext),
    tag: decodeBase64Url(value.tag, AES_GCM_TAG_BYTES),
  }
}

function validateKeyRoot(value: unknown): asserts value is AttributionDerivedKeyRoot {
  if (!(value instanceof AttributionDerivedKeyRoot)) throw contextError()
  const key = keyForRoot(value)
  if (typeof value.id !== 'string' || !KEY_ID_PATTERN.test(value.id)) throw contextError()
  if (typeof CryptoKey === 'undefined' || !(key instanceof CryptoKey)) throw contextError()
  if (key.type !== 'secret' || key.algorithm.name !== 'HKDF' || key.extractable || !key.usages.includes('deriveKey')) {
    throw contextError()
  }
}

function deriveAesKey(root: AttributionDerivedKeyRoot, purpose: AttributionCryptoPurpose, usages: AesKeyUsage[]) {
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: HKDF_SALT,
    info: hkdfInfo(purpose, 'aes-256-gcm'),
  }, keyForRoot(root), { name: 'AES-GCM', length: AES_KEY_BYTES * 8 }, false, usages)
}

function keyForRoot(root: AttributionDerivedKeyRoot) {
  const key = rootKeys.get(root)
  if (!key) throw contextError()
  return key
}

function hkdfInfo(purpose: AttributionCryptoPurpose, algorithm: string) {
  return new TextEncoder().encode(`meigallery-attribution-v1\\0${purpose}\\0${algorithm}`)
}

function decodeBase64Url(value: unknown, expectedLength?: number) {
  if (typeof value !== 'string' || value.length % 4 === 1) throw contextError()
  if (value.length === 0) {
    if (expectedLength !== undefined) throw contextError()
    return new Uint8Array()
  }
  if (!BASE64_URL_PATTERN.test(value)) throw contextError()
  const standard = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const bytes = decodeBase64(standard)
  if (encodeBase64Url(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    throw contextError()
  }
  return bytes
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactOwnFields(value: object, fields: Set<string>) {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.has(key))
    && Array.from(fields).every(field => Object.hasOwn(value, field))
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !CONTROL_CHARACTER_PATTERN.test(value)
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
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

function keyError() {
  return new AttributionCryptoError('ATTRIBUTION_CRYPTO_KEY_INVALID')
}

function contextError() {
  return new AttributionCryptoError('ATTRIBUTION_CRYPTO_CONTEXT_INVALID')
}

function authenticationError() {
  return new AttributionCryptoError('ATTRIBUTION_CRYPTO_AUTHENTICATION_FAILED')
}
