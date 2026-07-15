import type { AdAttributionProvider } from '@meigallery/shared'
import {
  decryptAttributionValue,
  deriveAttributionHmacKey,
  encryptAttributionValue,
  loadAttributionCryptoKeys,
  type AttributionEncryptedEnvelope,
} from '../../utils/attribution-crypto'

const PROVIDERS = new Set<AdAttributionProvider>(['meta', 'tiktok', 'google'])
const CREDENTIAL_TYPES = new Set<AttributionCredentialType>(['access_token', 'service_account_json'])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,160}$/
const FINGERPRINT_HEX_LENGTH = 32

export type AttributionCredentialType = 'access_token' | 'service_account_json'

export interface SaveCredentialInput {
  connectionId: string
  provider: AdAttributionProvider
  credentialType: AttributionCredentialType
  plaintext: string
  credentialRevision: string
  createdBy: number
}

export interface PreparedAttributionCredential {
  id: string
  connectionId: string
  provider: AdAttributionProvider
  credentialType: AttributionCredentialType
  credentialRevision: string
  schemaVersion: 1
  keyId: string
  iv: string
  ciphertext: string
  tag: string
  fingerprint: string
  createdBy: number
}

export type CredentialVaultEnv = {
  DB: D1Database
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT?: string
  AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS?: string
}

export type CredentialVaultErrorCode =
  | 'ATTRIBUTION_CREDENTIAL_INPUT_INVALID'
  | 'ATTRIBUTION_CREDENTIAL_CONNECTION_NOT_FOUND'
  | 'ATTRIBUTION_CREDENTIAL_NOT_FOUND'
  | 'ATTRIBUTION_CREDENTIAL_WRITE_FAILED'
  | 'ATTRIBUTION_CREDENTIAL_DECRYPT_FAILED'
  | 'ATTRIBUTION_CREDENTIAL_CRYPTO_UNAVAILABLE'

export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode

  constructor(code: CredentialVaultErrorCode) {
    super(code)
    this.name = 'CredentialVaultError'
    this.code = code
  }
}

export async function saveAttributionCredential(
  env: CredentialVaultEnv,
  input: SaveCredentialInput,
): Promise<{ id: string; credentialRevision: string }> {
  await validateSaveInput(input)
  await requireConnection(env.DB, input.connectionId, input.provider)
  const prepared = await prepareAttributionCredential(env, input)
  try {
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM attribution_credentials
        WHERE connection_id = ? AND provider = ? AND credential_type = ?
      `).bind(input.connectionId, input.provider, input.credentialType),
      env.DB.prepare(`
        INSERT INTO attribution_credentials (
          id, connection_id, provider, credential_type, schema_version, key_id,
          iv, ciphertext, tag, fingerprint, credential_revision, created_by, updated_at
        ) VALUES (
          ?,
          (SELECT id FROM attribution_platform_connections WHERE id = ? AND provider = ?),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
        )
      `).bind(
        prepared.id,
        input.connectionId,
        input.provider,
        input.provider,
        input.credentialType,
        prepared.schemaVersion,
        prepared.keyId,
        prepared.iv,
        prepared.ciphertext,
        prepared.tag,
        prepared.fingerprint,
        input.credentialRevision,
        input.createdBy,
      ),
    ])
  }
  catch {
    throw vaultError('ATTRIBUTION_CREDENTIAL_WRITE_FAILED')
  }

  return { id: prepared.id, credentialRevision: input.credentialRevision }
}

/** 完成凭证校验与封装，但把实际写入留给调用方的原子 batch。 */
export async function prepareAttributionCredential(
  env: Pick<CredentialVaultEnv, 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT' | 'AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS'>,
  input: SaveCredentialInput,
): Promise<PreparedAttributionCredential> {
  await validateSaveInput(input)

  try {
    const keys = await loadAttributionCryptoKeys(env)
    const envelope: AttributionEncryptedEnvelope = await encryptAttributionValue({
      keys,
      aad: credentialAad(input),
      plaintext: input.plaintext,
    })
    return {
      id: crypto.randomUUID(),
      connectionId: input.connectionId,
      provider: input.provider,
      credentialType: input.credentialType,
      credentialRevision: input.credentialRevision,
      schemaVersion: envelope.schemaVersion,
      keyId: envelope.keyId,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      tag: envelope.tag,
      fingerprint: await credentialFingerprint(keys, input.provider, input.credentialType, input.plaintext),
      createdBy: input.createdBy,
    }
  }
  catch (error) {
    if (error instanceof CredentialVaultError) throw error
    throw vaultError('ATTRIBUTION_CREDENTIAL_CRYPTO_UNAVAILABLE')
  }
}

export async function readAttributionCredential(
  env: CredentialVaultEnv,
  input: Omit<SaveCredentialInput, 'plaintext' | 'createdBy'>,
): Promise<string> {
  validateReadInput(input)
  const row = await env.DB.prepare(`
    SELECT credential.schema_version, credential.key_id, credential.iv, credential.ciphertext, credential.tag
    FROM attribution_credentials AS credential
    JOIN attribution_platform_connections AS connection
      ON connection.id = credential.connection_id AND connection.provider = credential.provider
    WHERE credential.connection_id = ? AND credential.provider = ?
      AND credential.credential_type = ? AND credential.credential_revision = ?
    LIMIT 1
  `).bind(
    input.connectionId,
    input.provider,
    input.credentialType,
    input.credentialRevision,
  ).first<CredentialEnvelopeRow>()
  if (!row) throw vaultError('ATTRIBUTION_CREDENTIAL_NOT_FOUND')

  try {
    const keys = await loadAttributionCryptoKeys(env)
    const plaintext = await decryptAttributionValue({
      keys,
      aad: credentialAad(input),
      envelope: toEnvelope(row),
    })
    await validateCredentialValue(input.provider, input.credentialType, plaintext)
    return plaintext
  }
  catch {
    throw vaultError('ATTRIBUTION_CREDENTIAL_DECRYPT_FAILED')
  }
}

type CredentialEnvelopeRow = {
  schema_version: number
  key_id: string
  iv: string
  ciphertext: string
  tag: string
}

async function requireConnection(db: D1Database, connectionId: string, provider: AdAttributionProvider) {
  const row = await db.prepare(`
    SELECT id FROM attribution_platform_connections WHERE id = ? AND provider = ? LIMIT 1
  `).bind(connectionId, provider).first<{ id: string }>()
  if (!row) throw vaultError('ATTRIBUTION_CREDENTIAL_CONNECTION_NOT_FOUND')
}

async function validateSaveInput(input: SaveCredentialInput) {
  validateReadInput(input)
  if (!Number.isSafeInteger(input.createdBy) || input.createdBy <= 0) throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
  await validateCredentialValue(input.provider, input.credentialType, input.plaintext)
}

function validateReadInput(input: Omit<SaveCredentialInput, 'plaintext' | 'createdBy'>) {
  if (!isProvider(input.provider) || !CREDENTIAL_TYPES.has(input.credentialType)
    || !isIdentifier(input.connectionId) || !isIdentifier(input.credentialRevision)) {
    throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
  }
}

async function validateCredentialValue(
  provider: AdAttributionProvider,
  credentialType: AttributionCredentialType,
  plaintext: unknown,
): Promise<void> {
  if (typeof plaintext !== 'string' || plaintext.length === 0 || plaintext.length > 32_768) {
    throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
  }
  if ((provider === 'meta' || provider === 'tiktok') && credentialType === 'access_token') return
  if (provider === 'google' && credentialType === 'service_account_json' && await isGoogleServiceAccount(plaintext)) return
  throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
}

async function isGoogleServiceAccount(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!isPlainRecord(parsed)) return false
    if (parsed.type !== 'service_account' || !isServiceAccountEmail(parsed.client_email)
      || parsed.token_uri !== 'https://oauth2.googleapis.com/token'
      || !await isPkcs8RsaPrivateKey(parsed.private_key)) return false
    return true
  }
  catch {
    return false
  }
}

function credentialAad(input: Pick<SaveCredentialInput, 'connectionId' | 'provider' | 'credentialRevision'>) {
  return {
    purpose: 'credential' as const,
    provider: input.provider,
    subjectId: input.connectionId,
    revision: input.credentialRevision,
  }
}

async function credentialFingerprint(
  keys: Awaited<ReturnType<typeof loadAttributionCryptoKeys>>,
  provider: AdAttributionProvider,
  credentialType: AttributionCredentialType,
  plaintext: string,
) {
  const key = await deriveAttributionHmacKey({ keys, purpose: 'credential' })
  const input = new TextEncoder().encode(`${provider}\u0000${credentialType}\u0000${plaintext}`)
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, input))
  return Array.from(signature.slice(0, FINGERPRINT_HEX_LENGTH / 2), byte => byte.toString(16).padStart(2, '0')).join('')
}

function toEnvelope(row: CredentialEnvelopeRow): AttributionEncryptedEnvelope {
  return {
    schemaVersion: row.schema_version as 1,
    keyId: row.key_id,
    iv: row.iv,
    ciphertext: row.ciphertext,
    tag: row.tag,
  }
}

function isProvider(value: unknown): value is AdAttributionProvider {
  return typeof value === 'string' && PROVIDERS.has(value as AdAttributionProvider)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value)
}

function isServiceAccountEmail(value: unknown) {
  return typeof value === 'string'
    && /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/.test(value)
}

async function isPkcs8RsaPrivateKey(value: unknown) {
  if (typeof value !== 'string') return false
  try {
    const match = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/.exec(value)
    if (!match) return false
    const encodedBody = match[1]
    if (!encodedBody) return false
    const encoded = encodedBody.replace(/\s/g, '')
    if (encoded.length === 0 || encoded.length % 4 !== 0) return false
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    if (btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) !== encoded) return false
    await crypto.subtle.importKey('pkcs8', bytes, {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    }, false, ['sign'])
    return true
  }
  catch {
    return false
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function vaultError(code: CredentialVaultErrorCode) {
  return new CredentialVaultError(code)
}
