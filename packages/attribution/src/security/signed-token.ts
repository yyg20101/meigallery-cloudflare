export interface AttributionSigningKeys {
  current: string
  previous?: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
})
const TOKEN_VERSION = 'v1'
const KEY_ID_PATTERN = /^[0-9a-f]{32}$/
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/

export async function signAttributionToken(
  secret: string,
  purpose: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  validateSecret(secret)
  validatePurpose(purpose)
  const keyId = await signingKeyId(secret)
  const encodedPayload = encodeBase64Url(
    encoder.encode(JSON.stringify(payload)),
  )
  const message = tokenMessage(purpose, keyId, encodedPayload)
  const signature = await hmacSha256(secret, message)
  return [
    TOKEN_VERSION,
    keyId,
    encodedPayload,
    encodeBase64Url(signature),
  ].join('.')
}

export async function verifyAttributionToken(
  keys: AttributionSigningKeys,
  purpose: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    validatePurpose(purpose)
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
      return null
    }
    const parts = token.split('.')
    if (
      parts.length !== 4
      || parts[0] !== TOKEN_VERSION
      || !KEY_ID_PATTERN.test(parts[1] ?? '')
      || !TOKEN_PART_PATTERN.test(parts[2] ?? '')
      || !TOKEN_PART_PATTERN.test(parts[3] ?? '')
    ) {
      return null
    }

    const keyId = parts[1]!
    const encodedPayload = parts[2]!
    const signature = decodeBase64Url(parts[3]!)
    if (signature.byteLength !== 32) return null
    const secret = await matchingSecret(keys, keyId)
    if (!secret) return null

    const key = await importHmacKey(secret)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(tokenMessage(purpose, keyId, encodedPayload)),
    )
    if (!valid) return null

    const parsed: unknown = JSON.parse(
      decoder.decode(decodeBase64Url(encodedPayload)),
    )
    return isPlainRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

export function decodeBase64Url(value: string): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !TOKEN_PART_PATTERN.test(value)
  ) {
    throw new Error('ATTRIBUTION_SIGNING_INPUT_INVALID')
  }
  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function hmacSha256(
  secret: string,
  message: string,
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importHmacKey(secret),
    encoder.encode(message),
  )
  return new Uint8Array(signature)
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  validateSecret(secret)
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

async function signingKeyId(secret: string): Promise<string> {
  validateSecret(secret)
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`attribution:signing-key-id:${secret}`),
  ))
  return toHex(digest.slice(0, 16))
}

async function matchingSecret(
  keys: AttributionSigningKeys,
  keyId: string,
): Promise<string | null> {
  validateSecret(keys.current)
  if (await signingKeyId(keys.current) === keyId) return keys.current
  if (keys.previous) {
    validateSecret(keys.previous)
    if (await signingKeyId(keys.previous) === keyId) return keys.previous
  }
  return null
}

function tokenMessage(
  purpose: string,
  keyId: string,
  encodedPayload: string,
): string {
  return `attribution-token:${TOKEN_VERSION}:${purpose}:${keyId}:${encodedPayload}`
}

function validateSecret(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || encoder.encode(value).byteLength < 32
    || value.length > 4096
  ) {
    throw new Error('ATTRIBUTION_SIGNING_KEY_INVALID')
  }
}

function validatePurpose(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 120
    || !/^[a-z0-9:_-]+$/.test(value)
  ) {
    throw new Error('ATTRIBUTION_SIGNING_INPUT_INVALID')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
