import type { AttributionProvider } from '@meigallery/shared'
import { AttributionDomainError } from '../domain/errors'
import {
  openAttributionData,
  sealAttributionData,
  type AttributionDataEnvelope,
  type AttributionEncryptionKeys,
} from '../security/data-envelope'
import { sha256Hex } from '../security/digest'

export interface CredentialEnvelope extends AttributionDataEnvelope {
  fingerprint: string
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

const CREDENTIAL_PURPOSE = 'credential'
const encoder = new TextEncoder()

export async function sealCredential(
  keys: Pick<AttributionEncryptionKeys, 'current'>,
  input: SealCredentialInput,
): Promise<CredentialEnvelope> {
  assertCredentialInput(keys.current, input)
  try {
    return {
      ...await sealAttributionData(keys, {
        purpose: CREDENTIAL_PURPOSE,
        identity: credentialIdentity(input),
        plaintext: input.plaintext,
      }),
      fingerprint: await fingerprintCredential(input.plaintext),
    }
  } catch {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
}

export async function openCredential(
  keys: AttributionEncryptionKeys,
  input: OpenCredentialInput,
): Promise<string> {
  try {
    assertCredentialIdentity(input)
    assertCredentialEnvelope(input.envelope)
    const plaintext = await openAttributionData(keys, {
      purpose: CREDENTIAL_PURPOSE,
      identity: credentialIdentity(input),
      envelope: baseEnvelope(input.envelope),
    })
    if (!await credentialFingerprintMatches(
      plaintext,
      input.envelope.fingerprint,
    )) {
      throw new Error('fingerprint mismatch')
    }
    return plaintext
  } catch {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_AAD_MISMATCH')
  }
}

export async function fingerprintCredential(
  plaintext: string,
): Promise<string> {
  if (!plaintext) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
  return sha256Hex(`credential-fingerprint:v1:${plaintext}`)
}

async function credentialFingerprintMatches(
  plaintext: string,
  expected: string,
): Promise<boolean> {
  return await fingerprintCredential(plaintext) === expected
}

function credentialIdentity(input: CredentialIdentity): string {
  return `${input.provider}:${input.versionId}`
}

function baseEnvelope(
  envelope: CredentialEnvelope,
): AttributionDataEnvelope {
  return {
    schemaVersion: envelope.schemaVersion,
    keyId: envelope.keyId,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
  }
}

function assertCredentialInput(
  key: string,
  input: SealCredentialInput,
): void {
  assertCredentialIdentity(input)
  validateKey(key)
  if (!input.plaintext) {
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

function assertCredentialEnvelope(
  envelope: CredentialEnvelope,
): void {
  if (
    !envelope
    || !/^[0-9a-f]{64}$/.test(envelope.fingerprint)
  ) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
}

function validateKey(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || encoder.encode(value).byteLength < 32
    || value.length > 4096
  ) {
    throw new AttributionDomainError('ATTRIBUTION_CREDENTIAL_INVALID')
  }
}
