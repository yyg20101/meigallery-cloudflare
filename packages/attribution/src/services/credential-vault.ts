import type { AttributionProvider } from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'

export interface CredentialEnvelope {
  schemaVersion: 1
  keyId: string
  iv: string
  ciphertext: string
  tag: string
  fingerprint: string
}

interface CredentialKeys {
  current: string
  previous?: string
}

interface CredentialIdentity {
  versionId: string
  provider: AttributionProvider
}

interface SealCredentialInput extends CredentialIdentity {
  plaintext: string
}

interface OpenCredentialInput extends CredentialIdentity {
  envelope: CredentialEnvelope
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const IV_LENGTH = 12
const TAG_LENGTH = 16

export async function sealCredential(
  keys: Pick<CredentialKeys, 'current'>,
  input: SealCredentialInput,
): Promise<CredentialEnvelope> {
  assertCredentialInput(keys.current, input)

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encryptionKey = await importEncryptionKey(keys.current)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: credentialAad(input),
    tagLength: TAG_LENGTH * 8,
  }, encryptionKey, encoder.encode(input.plaintext)))

  const ciphertext = encrypted.slice(0, -TAG_LENGTH)
  const tag = encrypted.slice(-TAG_LENGTH)

  return {
    schemaVersion: 1,
    keyId: await credentialKeyId(keys.current),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
    tag: encodeBase64Url(tag),
    fingerprint: await fingerprintCredential(keys.current, input.plaintext),
  }
}

export async function openCredential(
  keys: CredentialKeys,
  input: OpenCredentialInput,
): Promise<string> {
  try {
    assertCredentialIdentity(input)
    assertEnvelope(input.envelope)

    const keyMaterial = await findKeyMaterial(keys, input.envelope.keyId)
    if (!keyMaterial) {
      throw new Error('key not found')
    }

    const ciphertext = decodeBase64Url(input.envelope.ciphertext)
    const tag = decodeBase64Url(input.envelope.tag)
    const encrypted = new Uint8Array(ciphertext.length + tag.length)
    encrypted.set(ciphertext)
    encrypted.set(tag, ciphertext.length)

    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: decodeBase64Url(input.envelope.iv),
      additionalData: credentialAad(input),
      tagLength: TAG_LENGTH * 8,
    }, await importEncryptionKey(keyMaterial), encrypted)

    const decoded = decoder.decode(plaintext)
    if (
      await fingerprintCredential(keyMaterial, decoded)
      !== input.envelope.fingerprint
    ) {
      throw new Error('fingerprint mismatch')
    }
    return decoded
  } catch {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
  }
}

export async function fingerprintCredential(
  key: string,
  plaintext: string,
): Promise<string> {
  if (!key.trim() || !plaintext) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    await deriveBytes('fingerprint', key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    encoder.encode(plaintext),
  )
  return toHex(new Uint8Array(signature))
}

function credentialAad(input: CredentialIdentity): Uint8Array {
  return encoder.encode(`credential:v1:${input.provider}:${input.versionId}`)
}

async function importEncryptionKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    await deriveBytes('encryption', key),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function credentialKeyId(key: string): Promise<string> {
  const bytes = await deriveBytes('key-id', key)
  return toHex(bytes.slice(0, 16))
}

async function deriveBytes(purpose: string, key: string): Promise<Uint8Array> {
  if (!key.trim()) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
  return new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`attribution:${purpose}:${key}`),
  ))
}

async function findKeyMaterial(
  keys: CredentialKeys,
  keyId: string,
): Promise<string | null> {
  if (await credentialKeyId(keys.current) === keyId) return keys.current
  if (keys.previous && await credentialKeyId(keys.previous) === keyId) {
    return keys.previous
  }
  return null
}

function assertCredentialInput(
  key: string,
  input: SealCredentialInput,
): void {
  assertCredentialIdentity(input)
  if (!key.trim() || !input.plaintext) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
}

function assertCredentialIdentity(input: CredentialIdentity): void {
  if (
    !input.versionId
    || !['meta', 'tiktok', 'google'].includes(input.provider)
  ) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
}

function assertEnvelope(envelope: CredentialEnvelope): void {
  if (
    envelope.schemaVersion !== 1
    || !/^[0-9a-f]{32}$/.test(envelope.keyId)
    || !/^[0-9a-f]{64}$/.test(envelope.fingerprint)
    || decodeBase64Url(envelope.iv).length !== IV_LENGTH
    || decodeBase64Url(envelope.tag).length !== TAG_LENGTH
    || decodeBase64Url(envelope.ciphertext).length === 0
  ) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }

  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
