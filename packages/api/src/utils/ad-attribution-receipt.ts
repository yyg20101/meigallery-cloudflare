import type { AdAttributionProvider } from '@meigallery/shared'

export interface AdAttributionReceiptClaims {
  provider: AdAttributionProvider
  issuedAt: number
  expiresAt: number
  nonce: string
}

export const AD_ATTRIBUTION_RECEIPT_TTL_SECONDS = 30 * 60

const SIGNING_PREFIX = 'meigallery:ad-attribution:v1:'
const SIGNATURE_BYTES = 32
const NONCE_PATTERN = /^[0-9a-f]{32}$/

export async function createAdAttributionReceipt(
  secret: string,
  provider: AdAttributionProvider,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const claims: AdAttributionReceiptClaims = {
    provider,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + AD_ATTRIBUTION_RECEIPT_TTL_SECONDS,
    nonce: randomHex(16),
  }
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await sign(secret, payload)
  return `${payload}.${base64UrlEncode(signature)}`
}

export async function verifyAdAttributionReceipt(
  secret: string,
  receipt: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AdAttributionReceiptClaims> {
  const [payload, encodedSignature, extra] = receipt.split('.')
  if (!payload || !encodedSignature || extra !== undefined) throw new Error('广告来源 receipt 无效')

  let receivedSignature: Uint8Array
  try {
    receivedSignature = base64UrlDecode(encodedSignature)
  }
  catch {
    throw new Error('广告来源 receipt 无效')
  }
  const expectedSignature = await sign(secret, payload)
  if (!constantTimeSignatureMatch(expectedSignature, receivedSignature)) {
    throw new Error('广告来源 receipt 签名无效')
  }

  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)))
  }
  catch {
    throw new Error('广告来源 receipt 无效')
  }
  if (!isValidClaims(claims, nowSeconds)) throw new Error('广告来源 receipt 无效或已过期')
  return claims
}

export async function resolveTrustedAdAttributionProvider(
  secret: string,
  receipt: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AdAttributionProvider | null> {
  return (await resolveTrustedAdAttributionReceipt(secret, receipt, nowSeconds))?.provider ?? null
}

export async function resolveTrustedAdAttributionReceipt(
  secret: string,
  receipt: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AdAttributionReceiptClaims | null> {
  if (!receipt) return null
  try {
    return await verifyAdAttributionReceipt(secret, receipt, nowSeconds)
  }
  catch {
    return null
  }
}

async function sign(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${SIGNING_PREFIX}${payload}`),
  ))
}

function isValidClaims(value: unknown, nowSeconds: number): value is AdAttributionReceiptClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 4 || !keys.every(key => ['provider', 'issuedAt', 'expiresAt', 'nonce'].includes(key))) return false
  const claims = value as Partial<AdAttributionReceiptClaims>
  return (claims.provider === 'meta' || claims.provider === 'tiktok')
    && Number.isInteger(claims.issuedAt)
    && Number.isInteger(claims.expiresAt)
    && Number(claims.issuedAt) <= nowSeconds
    && Number(claims.expiresAt) > nowSeconds
    && Number(claims.expiresAt) - Number(claims.issuedAt) === AD_ATTRIBUTION_RECEIPT_TTL_SECONDS
    && typeof claims.nonce === 'string'
    && NONCE_PATTERN.test(claims.nonce)
}

function randomHex(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
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
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}
