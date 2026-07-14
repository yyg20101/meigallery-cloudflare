const AES_KEY_BYTES = 32
const AES_GCM_IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/
const BASE64_KEY_PATTERN = /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/

type DataKeyUsage = 'encrypt' | 'decrypt'
const CURRENT_KEY_USAGES: DataKeyUsage[] = ['encrypt', 'decrypt']
const PREVIOUS_KEY_USAGES: DataKeyUsage[] = ['decrypt']
const ENVELOPE_FIELDS = new Set(['schemaVersion', 'keyId', 'iv', 'ciphertext', 'tag'])

export interface SecureContextEncryptedEnvelope {
  schemaVersion: 2
  keyId: string
  iv: string
  ciphertext: string
  tag: string
}

export interface SecureContextCryptoKeys {
  current: { id: string; key: CryptoKey }
  previous?: { id: string; key: CryptoKey }
}

export interface SecureContextCodec<TContext extends object, TAad> {
  loadKeys: (input: { current?: string; previous?: string }) => Promise<SecureContextCryptoKeys>
  encrypt: (input: {
    keys: SecureContextCryptoKeys
    aad: TAad
    value: TContext
  }) => Promise<SecureContextEncryptedEnvelope>
  decrypt: (input: {
    keys: SecureContextCryptoKeys
    aad: TAad
    envelope: SecureContextEncryptedEnvelope
  }) => Promise<TContext>
}

export function createSecureContextCodec<TContext extends object, TAad>(config: {
  dataKeyError: () => Error
  contextError: () => Error
  authenticationError: () => Error
  payloadError: () => Error
  encodeAad: (value: TAad) => Uint8Array
  validateContext: (value: unknown) => TContext
}): SecureContextCodec<TContext, TAad> {
  return {
    async loadKeys(input) {
      try {
        const current = await importDataKey(input.current, CURRENT_KEY_USAGES, config.dataKeyError)
        if (input.previous === undefined) return { current }

        const previous = await importDataKey(input.previous, PREVIOUS_KEY_USAGES, config.dataKeyError)
        return previous.id === current.id ? { current } : { current, previous }
      }
      catch {
        throw config.dataKeyError()
      }
    },

    async encrypt(input) {
      try {
        validateCryptoKey(input.keys.current, 'encrypt', config.contextError)
        const additionalData = config.encodeAad(input.aad)
        const plaintext = new TextEncoder().encode(JSON.stringify(config.validateContext(input.value)))
        const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
        const sealed = new Uint8Array(await crypto.subtle.encrypt({
          name: 'AES-GCM',
          iv,
          additionalData,
          tagLength: AES_GCM_TAG_BYTES * 8,
        }, input.keys.current.key, plaintext))
        const tagOffset = sealed.length - AES_GCM_TAG_BYTES
        if (tagOffset <= 0) throw config.contextError()

        return {
          schemaVersion: 2,
          keyId: input.keys.current.id,
          iv: encodeBase64Url(iv),
          ciphertext: encodeBase64Url(sealed.slice(0, tagOffset)),
          tag: encodeBase64Url(sealed.slice(tagOffset)),
        }
      }
      catch {
        throw config.contextError()
      }
    },

    async decrypt(input) {
      let additionalData: Uint8Array
      let envelope: ReturnType<typeof validateEnvelope>
      let selected: { id: string; key: CryptoKey }
      try {
        additionalData = config.encodeAad(input.aad)
        envelope = validateEnvelope(input.envelope, config.contextError)
        const candidate = [input.keys.current, input.keys.previous]
          .find(candidate => candidate?.id === envelope.keyId)
        if (!candidate) throw config.contextError()
        validateCryptoKey(candidate, 'decrypt', config.contextError)
        selected = candidate
      }
      catch {
        throw config.contextError()
      }

      let plaintext: ArrayBuffer
      try {
        plaintext = await crypto.subtle.decrypt({
          name: 'AES-GCM',
          iv: envelope.iv,
          additionalData,
          tagLength: AES_GCM_TAG_BYTES * 8,
        }, selected.key, concatenateBytes(envelope.ciphertext, envelope.tag))
      }
      catch {
        throw config.authenticationError()
      }

      try {
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)
        return config.validateContext(JSON.parse(decoded))
      }
      catch {
        throw config.payloadError()
      }
    },
  }
}

async function importDataKey(
  value: string | undefined,
  usages: DataKeyUsage[],
  error: () => Error,
) {
  if (typeof value !== 'string') throw error()
  const canonical = value.trim()
  if (!BASE64_KEY_PATTERN.test(canonical)) throw error()
  const raw = decodeBase64(canonical)
  if (raw.length !== AES_KEY_BYTES || encodeBase64(raw) !== canonical) throw error()
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages)
  return { id: bytesToHex(new Uint8Array(digest)).slice(0, 16), key }
}

function validateEnvelope(value: SecureContextEncryptedEnvelope, error: () => Error) {
  if (!isPlainSecureContextRecord(value) || !hasExactOwnFields(value, ENVELOPE_FIELDS)) throw error()
  if (value.schemaVersion !== 2 || typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    throw error()
  }
  return {
    keyId: value.keyId,
    iv: decodeBase64Url(value.iv, error, AES_GCM_IV_BYTES),
    ciphertext: decodeBase64Url(value.ciphertext, error),
    tag: decodeBase64Url(value.tag, error, AES_GCM_TAG_BYTES),
  }
}

function validateCryptoKey(
  value: unknown,
  requiredUsage: DataKeyUsage,
  error: () => Error,
): asserts value is { id: string; key: CryptoKey } {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'key')) throw error()
  const { id, key } = value as { id?: unknown; key?: unknown }
  if (typeof id !== 'string' || !KEY_ID_PATTERN.test(id)) throw error()
  if (typeof CryptoKey === 'undefined' || !(key instanceof CryptoKey)) throw error()

  const algorithm = key.algorithm as { name: string; length?: unknown }
  if (
    key.type !== 'secret'
    || algorithm.name !== 'AES-GCM'
    || algorithm.length !== AES_KEY_BYTES * 8
    || key.extractable
    || !key.usages.includes(requiredUsage)
  ) throw error()
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function decodeBase64Url(value: unknown, error: () => Error, expectedLength?: number) {
  if (typeof value !== 'string' || !BASE64_URL_PATTERN.test(value) || value.length % 4 === 1) throw error()
  const standard = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const bytes = decodeBase64(standard)
  if (encodeBase64Url(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) throw error()
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

export function isPlainSecureContextRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasOnlyOwnSecureContextFields(value: object, allowed: Iterable<string>) {
  const allowedFields = allowed instanceof Set ? allowed : new Set(allowed)
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowedFields.has(key))
}

function hasExactOwnFields(value: object, fields: Iterable<string>) {
  const requiredFields = fields instanceof Set ? fields : new Set(fields)
  return hasOnlyOwnSecureContextFields(value, requiredFields)
    && Array.from(requiredFields).every(field => Object.hasOwn(value, field))
}
