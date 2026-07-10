export interface PixelReceiptClaims {
  deliveryId: string
  eventId: string
  expiresAt: number
}

const SIGNING_PREFIX = 'meigallery:pixel-receipt:v1:'
const SIGNATURE_BYTES = 32

export async function createPixelReceiptToken(secret: string, claims: PixelReceiptClaims): Promise<string> {
  if (!isValidClaims(claims, 0)) throw new Error('Pixel 回执无效')
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await sign(secret, payload)
  return `${payload}.${base64UrlEncode(signature)}`
}

export async function verifyPixelReceiptToken(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<PixelReceiptClaims> {
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Pixel 回执无效')

  let receivedSignature: Uint8Array
  try {
    receivedSignature = base64UrlDecode(parts[1])
  } catch {
    throw new Error('Pixel 回执无效')
  }

  const expectedSignature = await sign(secret, parts[0])
  if (!constantTimeSignatureMatch(expectedSignature, receivedSignature)) {
    throw new Error('Pixel 回执签名无效')
  }

  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])))
  } catch {
    throw new Error('Pixel 回执无效')
  }
  if (!isValidClaims(claims, nowSeconds)) {
    if (isExpiredClaims(claims, nowSeconds)) throw new Error('Pixel 回执已过期')
    throw new Error('Pixel 回执无效')
  }
  return claims
}

async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${SIGNING_PREFIX}${payload}`)))
}

function isValidClaims(value: unknown, nowSeconds: number): value is PixelReceiptClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Partial<PixelReceiptClaims>
  return typeof claims.deliveryId === 'string'
    && claims.deliveryId.length > 0
    && typeof claims.eventId === 'string'
    && claims.eventId.length > 0
    && Number.isInteger(claims.expiresAt)
    && Number(claims.expiresAt) > nowSeconds
}

function isExpiredClaims(value: unknown, nowSeconds: number) {
  if (!value || typeof value !== 'object') return false
  const expiresAt = (value as Partial<PixelReceiptClaims>).expiresAt
  return Number.isInteger(expiresAt) && Number(expiresAt) <= nowSeconds
}

function constantTimeSignatureMatch(expected: Uint8Array, received: Uint8Array) {
  let difference = expected.length === SIGNATURE_BYTES && received.length === SIGNATURE_BYTES ? 0 : 1
  for (let index = 0; index < SIGNATURE_BYTES; index += 1) {
    difference |= (expected[index] ?? 0) ^ (received[index] ?? 0)
  }
  return difference === 0
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
