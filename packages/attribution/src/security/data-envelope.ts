import {
  decodeBase64Url,
  encodeBase64Url,
} from './signed-token'

export interface AttributionEncryptionKeys {
  current: string
  previous?: string
}

export interface AttributionDataEnvelope {
  schemaVersion: 1
  keyId: string
  iv: string
  ciphertext: string
  tag: string
}

interface AttributionDataIdentity {
  purpose: string
  identity: string
}

interface SealAttributionDataInput extends AttributionDataIdentity {
  plaintext: string
}

interface OpenAttributionDataInput extends AttributionDataIdentity {
  envelope: AttributionDataEnvelope
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
})
const IV_LENGTH = 12
const TAG_LENGTH = 16

export async function sealAttributionData(
  keys: Pick<AttributionEncryptionKeys, 'current'>,
  input: SealAttributionDataInput,
): Promise<AttributionDataEnvelope> {
  validateKey(keys.current)
  validateIdentity(input)
  if (typeof input.plaintext !== 'string' || input.plaintext.length === 0) {
    throw invalid()
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: additionalData(input),
    tagLength: TAG_LENGTH * 8,
  }, await importEncryptionKey(keys.current, input.purpose), encoder.encode(
    input.plaintext,
  )))

  return {
    schemaVersion: 1,
    keyId: await encryptionKeyId(keys.current),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(encrypted.slice(0, -TAG_LENGTH)),
    tag: encodeBase64Url(encrypted.slice(-TAG_LENGTH)),
  }
}

export async function openAttributionData(
  keys: AttributionEncryptionKeys,
  input: OpenAttributionDataInput,
): Promise<string> {
  try {
    validateIdentity(input)
    validateEnvelope(input.envelope)
    const keyMaterial = await matchingKey(keys, input.envelope.keyId)
    if (!keyMaterial) throw invalid()

    const ciphertext = decodeBase64Url(input.envelope.ciphertext)
    const tag = decodeBase64Url(input.envelope.tag)
    const encrypted = new Uint8Array(ciphertext.length + tag.length)
    encrypted.set(ciphertext)
    encrypted.set(tag, ciphertext.length)
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: decodeBase64Url(input.envelope.iv),
      additionalData: additionalData(input),
      tagLength: TAG_LENGTH * 8,
    }, await importEncryptionKey(keyMaterial, input.purpose), encrypted)
    return decoder.decode(plaintext)
  } catch {
    throw invalid()
  }
}

async function importEncryptionKey(
  secret: string,
  purpose: string,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    await deriveBytes(`encryption:${purpose}`, secret),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptionKeyId(secret: string): Promise<string> {
  return toHex((await deriveBytes('key-id', secret)).slice(0, 16))
}

async function matchingKey(
  keys: AttributionEncryptionKeys,
  keyId: string,
): Promise<string | null> {
  validateKey(keys.current)
  if (await encryptionKeyId(keys.current) === keyId) return keys.current
  if (keys.previous) {
    validateKey(keys.previous)
    if (await encryptionKeyId(keys.previous) === keyId) return keys.previous
  }
  return null
}

async function deriveBytes(
  purpose: string,
  secret: string,
): Promise<Uint8Array> {
  validateKey(secret)
  return new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`attribution-data:${purpose}:${secret}`),
  ))
}

function additionalData(input: AttributionDataIdentity): Uint8Array {
  return encoder.encode(
    `attribution-data:v1:${input.purpose}:${input.identity}`,
  )
}

function validateIdentity(input: AttributionDataIdentity): void {
  if (
    typeof input.purpose !== 'string'
    || input.purpose.length === 0
    || input.purpose.length > 120
    || !/^[a-z0-9:_-]+$/.test(input.purpose)
    || typeof input.identity !== 'string'
    || input.identity.length === 0
    || input.identity.length > 1024
  ) {
    throw invalid()
  }
}

function validateEnvelope(envelope: AttributionDataEnvelope): void {
  if (
    !envelope
    || envelope.schemaVersion !== 1
    || !/^[0-9a-f]{32}$/.test(envelope.keyId)
    || decodeBase64Url(envelope.iv).byteLength !== IV_LENGTH
    || decodeBase64Url(envelope.tag).byteLength !== TAG_LENGTH
    || decodeBase64Url(envelope.ciphertext).byteLength === 0
  ) {
    throw invalid()
  }
}

function validateKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || encoder.encode(value).byteLength < 32
    || value.length > 4096
  ) {
    throw invalid()
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function invalid(): Error {
  return new Error('ATTRIBUTION_DATA_ENVELOPE_INVALID')
}
