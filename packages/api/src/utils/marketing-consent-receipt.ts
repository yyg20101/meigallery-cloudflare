import type { AnalyticsConsentState } from '@meigallery/shared'

export type MarketingConsentReceiptState = Extract<AnalyticsConsentState, 'granted' | 'denied'>

export interface AdConsentSnapshot {
  consentVersion: number
  marketingAllowed: boolean
  adUserDataAllowed: boolean
  adPersonalizationAllowed: boolean
  decidedAt: string
}

export interface MarketingConsentReceiptClaims {
  state: MarketingConsentReceiptState
  issuedAt: number
  expiresAt: number
  nonce: string
  consent: AdConsentSnapshot
}

export const MARKETING_CONSENT_RECEIPT_TTL_SECONDS = 30 * 60

const SIGNING_PREFIX = 'meigallery:marketing-consent:v1:'
const SIGNATURE_BYTES = 32
const NONCE_PATTERN = /^[0-9a-f]{32}$/

export async function createMarketingConsentReceipt(
  secret: string,
  state: MarketingConsentReceiptState,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const claims: MarketingConsentReceiptClaims = {
    state,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
    nonce: randomHex(16),
    consent: createAdConsentSnapshot(state, nowSeconds),
  }
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await sign(secret, payload)
  return `${payload}.${base64UrlEncode(signature)}`
}

export async function verifyMarketingConsentReceipt(
  secret: string,
  receipt: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MarketingConsentReceiptClaims> {
  const [payload, encodedSignature, extra] = receipt.split('.')
  if (!payload || !encodedSignature || extra !== undefined) throw new Error('营销授权 receipt 无效')

  let receivedSignature: Uint8Array
  try {
    receivedSignature = base64UrlDecode(encodedSignature)
  }
  catch {
    throw new Error('营销授权 receipt 无效')
  }
  const expectedSignature = await sign(secret, payload)
  if (!constantTimeSignatureMatch(expectedSignature, receivedSignature)) {
    throw new Error('营销授权 receipt 签名无效')
  }

  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)))
  }
  catch {
    throw new Error('营销授权 receipt 无效')
  }
  if (!isValidClaims(claims, nowSeconds)) throw new Error('营销授权 receipt 无效或已过期')
  return claims
}

export async function resolveTrustedMarketingConsent(
  secret: string,
  receipt: string | undefined,
  requestedState: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AnalyticsConsentState> {
  if (requestedState === 'denied') return 'denied'
  if (requestedState === 'limited') return 'limited'

  let receiptState: MarketingConsentReceiptState | undefined
  if (receipt) {
    try {
      receiptState = (await verifyMarketingConsentReceipt(secret, receipt, nowSeconds)).state
    }
    catch {
      receiptState = undefined
    }
  }
  if (receiptState === 'denied') return 'denied'
  if (receiptState === 'granted' && (requestedState === undefined || requestedState === 'granted')) return 'granted'
  return 'limited'
}

export async function resolveTrustedAdConsentSnapshot(
  secret: string,
  receipt: string | undefined,
  requestedState: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AdConsentSnapshot> {
  const state = await resolveTrustedMarketingConsent(secret, receipt, requestedState, nowSeconds)
  if (state !== 'granted') return createAdConsentSnapshot('denied', nowSeconds)
  if (!receipt) return createAdConsentSnapshot('denied', nowSeconds)
  try {
    return (await verifyMarketingConsentReceipt(secret, receipt, nowSeconds)).consent
  }
  catch {
    return createAdConsentSnapshot('denied', nowSeconds)
  }
}

export function createAdConsentSnapshot(
  state: MarketingConsentReceiptState,
  nowSeconds = Math.floor(Date.now() / 1000),
): AdConsentSnapshot {
  const allowed = state === 'granted'
  return {
    consentVersion: 1,
    marketingAllowed: allowed,
    adUserDataAllowed: allowed,
    adPersonalizationAllowed: allowed,
    decidedAt: new Date(nowSeconds * 1_000).toISOString(),
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

function isValidClaims(value: unknown, nowSeconds: number): value is MarketingConsentReceiptClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 5 || !keys.every(key => ['state', 'issuedAt', 'expiresAt', 'nonce', 'consent'].includes(key))) return false
  const claims = value as Partial<MarketingConsentReceiptClaims>
  return (claims.state === 'granted' || claims.state === 'denied')
    && Number.isInteger(claims.issuedAt)
    && Number.isInteger(claims.expiresAt)
    && Number(claims.issuedAt) <= nowSeconds
    && Number(claims.expiresAt) > nowSeconds
    && Number(claims.expiresAt) - Number(claims.issuedAt) === MARKETING_CONSENT_RECEIPT_TTL_SECONDS
    && typeof claims.nonce === 'string'
    && NONCE_PATTERN.test(claims.nonce)
    && isValidAdConsentSnapshot(claims.consent, claims.state, claims.issuedAt)
}

function isValidAdConsentSnapshot(value: unknown, state: MarketingConsentReceiptState | undefined, issuedAt: number | undefined): value is AdConsentSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Partial<AdConsentSnapshot>
  const allowed = state === 'granted'
  return Object.keys(value).length === 5
    && snapshot.consentVersion === 1
    && snapshot.marketingAllowed === allowed
    && snapshot.adUserDataAllowed === allowed
    && snapshot.adPersonalizationAllowed === allowed
    && snapshot.decidedAt === new Date(Number(issuedAt) * 1_000).toISOString()
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
