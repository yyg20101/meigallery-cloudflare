import type { AttributionSigningKeys } from '../security/signed-token'

export const CONTACT_CAPABILITY_MAX_AGE_SECONDS = 24 * 60 * 60

export interface ContactCapabilityV1 {
  schemaVersion: 1
  contactMethodId: string
  platform: string
  destinationDigest: string
  issuedAt: number
  expiresAt: number
}

export interface ContactCapabilityInput {
  contactMethodId: string
  platform: string
  destinationDigest: string
}

export interface ContactCapabilityEnvironment {
  signingKeys: AttributionSigningKeys
  nowSeconds?: () => number
}

const TOKEN_VERSION = 'v1'
const SIGNATURE_PREFIX = 'contact-capability:v1:'
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/
const DESTINATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
})

export async function issueContactCapability(
  environment: ContactCapabilityEnvironment,
  input: ContactCapabilityInput,
  lifetimeSeconds = CONTACT_CAPABILITY_MAX_AGE_SECONDS,
): Promise<string> {
  validateInput(input)
  if (
    !Number.isSafeInteger(lifetimeSeconds)
    || lifetimeSeconds <= 0
    || lifetimeSeconds > CONTACT_CAPABILITY_MAX_AGE_SECONDS
  ) {
    throw invalid()
  }
  const issuedAt = trustedNow(environment.nowSeconds)
  const payload: ContactCapabilityV1 = {
    schemaVersion: 1,
    contactMethodId: input.contactMethodId,
    platform: input.platform,
    destinationDigest: input.destinationDigest,
    issuedAt,
    expiresAt: issuedAt + lifetimeSeconds,
  }
  const encodedPayload = encodeBase64Url(
    encoder.encode(stableJson(payload)),
  )
  const signature = await sign(
    environment.signingKeys.current,
    `${SIGNATURE_PREFIX}${encodedPayload}`,
  )
  return [
    TOKEN_VERSION,
    encodedPayload,
    encodeBase64Url(signature),
  ].join('.')
}

export async function verifyContactCapability(
  environment: ContactCapabilityEnvironment,
  token: string,
): Promise<ContactCapabilityV1 | null> {
  try {
    if (
      typeof token !== 'string'
      || token.length === 0
      || token.length > 4_096
    ) {
      return null
    }
    const parts = token.split('.')
    if (
      parts.length !== 3
      || parts[0] !== TOKEN_VERSION
      || !TOKEN_PART_PATTERN.test(parts[1] ?? '')
      || !TOKEN_PART_PATTERN.test(parts[2] ?? '')
    ) {
      return null
    }
    const encodedPayload = parts[1]!
    const signature = decodeBase64Url(parts[2]!)
    if (signature.byteLength !== 32) return null
    const message = `${SIGNATURE_PREFIX}${encodedPayload}`
    const secrets = [
      environment.signingKeys.current,
      environment.signingKeys.previous,
    ].filter((value): value is string => typeof value === 'string')
    let signatureValid = false
    for (const secret of secrets) {
      if (await verify(secret, message, signature)) {
        signatureValid = true
        break
      }
    }
    if (!signatureValid) return null

    const parsed: unknown = JSON.parse(
      decoder.decode(decodeBase64Url(encodedPayload)),
    )
    const payload = parsePayload(parsed)
    if (
      encodeBase64Url(encoder.encode(stableJson(payload)))
      !== encodedPayload
    ) {
      return null
    }
    const now = trustedNow(environment.nowSeconds)
    if (
      payload.issuedAt > now
      || payload.expiresAt <= now
      || payload.expiresAt - payload.issuedAt
        > CONTACT_CAPABILITY_MAX_AGE_SECONDS
    ) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export function stableJson(payload: ContactCapabilityV1): string {
  return JSON.stringify({
    contactMethodId: payload.contactMethodId,
    destinationDigest: payload.destinationDigest,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
    platform: payload.platform,
    schemaVersion: payload.schemaVersion,
  })
}

function parsePayload(value: unknown): ContactCapabilityV1 {
  if (
    !isPlainRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'contactMethodId',
      'platform',
      'destinationDigest',
      'issuedAt',
      'expiresAt',
    ])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.issuedAt)
    || !Number.isSafeInteger(value.expiresAt)
  ) {
    throw invalid()
  }
  const payload = value as unknown as ContactCapabilityV1
  validateInput(payload)
  if (
    payload.issuedAt <= 0
    || payload.expiresAt <= payload.issuedAt
  ) {
    throw invalid()
  }
  return payload
}

function validateInput(input: ContactCapabilityInput): void {
  if (
    !input
    || !IDENTIFIER_PATTERN.test(input.contactMethodId)
    || !isSafeText(input.platform, 80)
    || !DESTINATION_DIGEST_PATTERN.test(input.destinationDigest)
  ) {
    throw invalid()
  }
}

async function sign(
  secret: string,
  message: string,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    await importKey(secret),
    encoder.encode(message),
  ))
}

async function verify(
  secret: string,
  message: string,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    'HMAC',
    await importKey(secret),
    signature,
    encoder.encode(message),
  )
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (
    typeof secret !== 'string'
    || encoder.encode(secret).byteLength < 32
    || secret.length > 4_096
  ) {
    throw invalid()
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const binary = atob(
    value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  )
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function trustedNow(nowSeconds: (() => number) | undefined): number {
  const value = (nowSeconds ?? (() => Math.floor(Date.now() / 1_000)))()
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid()
  return value
}

function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= maximum
    && !/\p{Cc}/u.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return keys.length === required.length
    && required.every(key => key in value)
}

function invalid(): Error {
  return new Error('ATTRIBUTION_CONTACT_CAPABILITY_INVALID')
}
