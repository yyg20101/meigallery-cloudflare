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
  validateSaveInput(input)
  await requireConnection(env.DB, input.connectionId, input.provider)

  let envelope: AttributionEncryptedEnvelope
  let fingerprint: string
  try {
    const keys = await loadAttributionCryptoKeys(env)
    const aad = credentialAad(input)
    envelope = await encryptAttributionValue({ keys, aad, plaintext: input.plaintext })
    fingerprint = await credentialFingerprint(keys, input.provider, input.credentialType, input.plaintext)
  }
  catch {
    throw vaultError('ATTRIBUTION_CREDENTIAL_CRYPTO_UNAVAILABLE')
  }

  const id = crypto.randomUUID()
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        id,
        input.connectionId,
        input.provider,
        input.credentialType,
        envelope.schemaVersion,
        envelope.keyId,
        envelope.iv,
        envelope.ciphertext,
        envelope.tag,
        fingerprint,
        input.credentialRevision,
        input.createdBy,
      ),
    ])
  }
  catch {
    throw vaultError('ATTRIBUTION_CREDENTIAL_WRITE_FAILED')
  }

  return { id, credentialRevision: input.credentialRevision }
}

export async function readAttributionCredential(
  env: CredentialVaultEnv,
  input: Omit<SaveCredentialInput, 'plaintext' | 'createdBy'>,
): Promise<string> {
  validateReadInput(input)
  const row = await env.DB.prepare(`
    SELECT schema_version, key_id, iv, ciphertext, tag
    FROM attribution_credentials
    WHERE connection_id = ? AND provider = ? AND credential_type = ? AND credential_revision = ?
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
    validateCredentialValue(input.provider, input.credentialType, plaintext)
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

function validateSaveInput(input: SaveCredentialInput) {
  validateReadInput(input)
  if (!Number.isSafeInteger(input.createdBy) || input.createdBy <= 0) throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
  validateCredentialValue(input.provider, input.credentialType, input.plaintext)
}

function validateReadInput(input: Omit<SaveCredentialInput, 'plaintext' | 'createdBy'>) {
  if (!isProvider(input.provider) || !CREDENTIAL_TYPES.has(input.credentialType)
    || !isIdentifier(input.connectionId) || !isIdentifier(input.credentialRevision)) {
    throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
  }
}

function validateCredentialValue(
  provider: AdAttributionProvider,
  credentialType: AttributionCredentialType,
  plaintext: unknown,
) {
  if (typeof plaintext !== 'string' || plaintext.length === 0 || plaintext.length > 32_768) {
    throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
  }
  if ((provider === 'meta' || provider === 'tiktok') && credentialType === 'access_token') return
  if (provider === 'google' && credentialType === 'service_account_json' && isGoogleServiceAccount(plaintext)) return
  throw vaultError('ATTRIBUTION_CREDENTIAL_INPUT_INVALID')
}

function isGoogleServiceAccount(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!isPlainRecord(parsed)) return false
    if (parsed.type !== 'service_account' || !isServiceAccountEmail(parsed.client_email)
      || !isPrivateKey(parsed.private_key) || !isHttpsUrl(parsed.token_uri)) return false
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
  return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
}

function isPrivateKey(value: unknown) {
  return typeof value === 'string'
    && /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(value)
}

function isHttpsUrl(value: unknown) {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
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
