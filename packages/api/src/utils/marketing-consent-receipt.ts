import type { AdConsentSnapshot, AnalyticsConsentState } from '@meigallery/shared'

export type { AdConsentSnapshot } from '@meigallery/shared'

export type MarketingConsentReceiptState = Extract<AnalyticsConsentState, 'granted' | 'denied'>

export interface MarketingConsentChoiceClaims {
  state: MarketingConsentReceiptState
  decidedAt: number
  expiresAt: number
  nonce: string
}

export interface MarketingConsentReceiptClaims {
  state: MarketingConsentReceiptState
  issuedAt: number
  expiresAt: number
  decisionNonce: string
  consent: AdConsentSnapshot
}

export interface MarketingConsentTokens {
  choice?: string
  receipt?: string
}

export interface ResolvedMarketingConsent {
  state: AnalyticsConsentState
  consent: AdConsentSnapshot
  choice: MarketingConsentChoiceClaims | null
  needsReceiptRefresh: boolean
  hasInvalidProof: boolean
}

export const MARKETING_CONSENT_RECEIPT_TTL_SECONDS = 30 * 60
export const MARKETING_CONSENT_RECEIPT_REFRESH_SECONDS = 10 * 60
export const MARKETING_CONSENT_CHOICE_TTL_SECONDS = 180 * 24 * 60 * 60

const CHOICE_SIGNING_PREFIX = 'meigallery:marketing-consent-choice:v1:'
const RECEIPT_SIGNING_PREFIX = 'meigallery:marketing-consent-receipt:v2:'
const SIGNATURE_BYTES = 32
const NONCE_PATTERN = /^[0-9a-f]{32}$/

export async function createMarketingConsentChoice(
  secret: string,
  state: MarketingConsentReceiptState,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const claims: MarketingConsentChoiceClaims = {
    state,
    decidedAt: nowSeconds,
    expiresAt: nowSeconds + MARKETING_CONSENT_CHOICE_TTL_SECONDS,
    nonce: randomHex(16),
  }
  return {
    claims,
    token: await encodeSignedClaims(secret, CHOICE_SIGNING_PREFIX, claims),
  }
}

export async function verifyMarketingConsentChoice(
  secret: string,
  choice: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MarketingConsentChoiceClaims> {
  const claims = await decodeSignedClaims(secret, CHOICE_SIGNING_PREFIX, choice)
  if (!isValidChoiceClaims(claims, nowSeconds)) throw new Error('营销授权选择无效或已过期')
  return claims
}

export async function createMarketingConsentReceipt(
  secret: string,
  choice: MarketingConsentReceiptState | MarketingConsentChoiceClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const decision = typeof choice === 'string'
    ? { state: choice, decidedAt: nowSeconds, nonce: randomHex(16) }
    : choice
  const claims: MarketingConsentReceiptClaims = {
    state: decision.state,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + MARKETING_CONSENT_RECEIPT_TTL_SECONDS,
    decisionNonce: decision.nonce,
    consent: createAdConsentSnapshot(decision.state, decision.decidedAt),
  }
  return encodeSignedClaims(secret, RECEIPT_SIGNING_PREFIX, claims)
}

export async function verifyMarketingConsentReceipt(
  secret: string,
  receipt: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MarketingConsentReceiptClaims> {
  const claims = await decodeSignedClaims(secret, RECEIPT_SIGNING_PREFIX, receipt)
  if (!isValidReceiptClaims(claims, nowSeconds)) throw new Error('营销授权 receipt 无效或已过期')
  return claims
}

export async function resolveTrustedMarketingConsent(
  secret: string,
  tokens: MarketingConsentTokens,
  requestedState: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ResolvedMarketingConsent> {
  const [receipt, choice] = await Promise.all([
    verifyOptionalReceipt(secret, tokens.receipt, nowSeconds),
    verifyOptionalChoice(secret, tokens.choice, nowSeconds),
  ])
  const proofsConflict = Boolean(receipt && choice && (
    receipt.state !== choice.state
    || receipt.decisionNonce !== choice.nonce
    || receipt.consent.decidedAt !== new Date(choice.decidedAt * 1_000).toISOString()
  ))
  const hasInvalidProof = Boolean(
    (tokens.receipt && !receipt)
    || (tokens.choice && !choice)
    || proofsConflict,
  )
  const trustedState = proofsConflict ? undefined : receipt?.state ?? choice?.state
  const trustedConsent = proofsConflict
    ? undefined
    : receipt?.consent ?? (choice ? createAdConsentSnapshot(choice.state, choice.decidedAt) : undefined)
  const state = limitRequestedState(trustedState, requestedState)
  const consent = state === 'granted' && trustedConsent?.marketingAllowed
    ? trustedConsent
    : createAdConsentSnapshot('denied', nowSeconds)
  const needsReceiptRefresh = Boolean(
    !proofsConflict
    && choice
    && (!receipt || receipt.expiresAt - nowSeconds <= MARKETING_CONSENT_RECEIPT_REFRESH_SECONDS),
  )
  return {
    state,
    consent,
    choice: proofsConflict ? null : choice,
    needsReceiptRefresh,
    hasInvalidProof,
  }
}

export function createAdConsentSnapshot(
  state: MarketingConsentReceiptState,
  decidedAtSeconds = Math.floor(Date.now() / 1000),
): AdConsentSnapshot {
  const allowed = state === 'granted'
  return {
    consentVersion: 1,
    marketingAllowed: allowed,
    adUserDataAllowed: allowed,
    adPersonalizationAllowed: allowed,
    decidedAt: new Date(decidedAtSeconds * 1_000).toISOString(),
  }
}

async function verifyOptionalChoice(secret: string, value: string | undefined, nowSeconds: number) {
  if (!value) return null
  try { return await verifyMarketingConsentChoice(secret, value, nowSeconds) }
  catch { return null }
}

async function verifyOptionalReceipt(secret: string, value: string | undefined, nowSeconds: number) {
  if (!value) return null
  try { return await verifyMarketingConsentReceipt(secret, value, nowSeconds) }
  catch { return null }
}

function limitRequestedState(
  trustedState: MarketingConsentReceiptState | undefined,
  requestedState: unknown,
): AnalyticsConsentState {
  if (requestedState === 'denied') return 'denied'
  if (requestedState === 'limited') return 'limited'
  if (trustedState === 'denied') return 'denied'
  if (trustedState === 'granted' && (requestedState === undefined || requestedState === 'granted')) return 'granted'
  return 'limited'
}

async function encodeSignedClaims(secret: string, prefix: string, claims: object) {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await sign(secret, prefix, payload)
  return `${payload}.${base64UrlEncode(signature)}`
}

async function decodeSignedClaims(secret: string, prefix: string, token: string): Promise<unknown> {
  const [payload, encodedSignature, extra] = token.split('.')
  if (!payload || !encodedSignature || extra !== undefined) throw new Error('营销授权凭证无效')
  let receivedSignature: Uint8Array
  try { receivedSignature = base64UrlDecode(encodedSignature) }
  catch { throw new Error('营销授权凭证无效') }
  const expectedSignature = await sign(secret, prefix, payload)
  if (!constantTimeSignatureMatch(expectedSignature, receivedSignature)) throw new Error('营销授权凭证签名无效')
  try { return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) }
  catch { throw new Error('营销授权凭证无效') }
}

async function sign(secret: string, prefix: string, payload: string) {
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
    new TextEncoder().encode(`${prefix}${payload}`),
  ))
}

function isValidChoiceClaims(value: unknown, nowSeconds: number): value is MarketingConsentChoiceClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 4 || !keys.every(key => ['state', 'decidedAt', 'expiresAt', 'nonce'].includes(key))) return false
  const claims = value as Partial<MarketingConsentChoiceClaims>
  return (claims.state === 'granted' || claims.state === 'denied')
    && Number.isInteger(claims.decidedAt)
    && Number.isInteger(claims.expiresAt)
    && Number(claims.decidedAt) <= nowSeconds
    && Number(claims.expiresAt) > nowSeconds
    && Number(claims.expiresAt) - Number(claims.decidedAt) === MARKETING_CONSENT_CHOICE_TTL_SECONDS
    && typeof claims.nonce === 'string'
    && NONCE_PATTERN.test(claims.nonce)
}

function isValidReceiptClaims(value: unknown, nowSeconds: number): value is MarketingConsentReceiptClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 5 || !keys.every(key => ['state', 'issuedAt', 'expiresAt', 'decisionNonce', 'consent'].includes(key))) return false
  const claims = value as Partial<MarketingConsentReceiptClaims>
  return (claims.state === 'granted' || claims.state === 'denied')
    && Number.isInteger(claims.issuedAt)
    && Number.isInteger(claims.expiresAt)
    && Number(claims.issuedAt) <= nowSeconds
    && Number(claims.expiresAt) > nowSeconds
    && Number(claims.expiresAt) - Number(claims.issuedAt) === MARKETING_CONSENT_RECEIPT_TTL_SECONDS
    && typeof claims.decisionNonce === 'string'
    && NONCE_PATTERN.test(claims.decisionNonce)
    && isValidAdConsentSnapshot(claims.consent, claims.state, claims.issuedAt)
}

function isValidAdConsentSnapshot(value: unknown, state: MarketingConsentReceiptState | undefined, issuedAt: number | undefined): value is AdConsentSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Partial<AdConsentSnapshot>
  const allowed = state === 'granted'
  const decidedAt = Date.parse(String(snapshot.decidedAt))
  return Object.keys(value).length === 5
    && snapshot.consentVersion === 1
    && snapshot.marketingAllowed === allowed
    && snapshot.adUserDataAllowed === allowed
    && snapshot.adPersonalizationAllowed === allowed
    && Number.isFinite(decidedAt)
    && decidedAt <= Number(issuedAt) * 1_000
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
