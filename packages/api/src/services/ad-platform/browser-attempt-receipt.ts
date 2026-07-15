import type { AdAttributionProvider } from '@meigallery/shared'
import {
  deriveAttributionHmacVerificationKeys,
  type AttributionCryptoKeys,
} from '../../utils/attribution-crypto'

const IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/
const TOKEN = /^v1\.([0-9a-f]{16})\.(\d{10})\.([A-Za-z0-9_-]{43})$/
const RECEIPT_TTL_SECONDS = 10 * 60

type BrowserAttemptIdentity = {
  deliveryId: string
  provider: AdAttributionProvider
  externalEventId: string
}

export async function issueBrowserAttemptReceiptToken(
  keys: AttributionCryptoKeys,
  identity: BrowserAttemptIdentity,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!validIdentity(identity)) throw new Error('BROWSER_ATTEMPT_RECEIPT_INVALID')
  const [current] = await deriveAttributionHmacVerificationKeys({ keys, purpose: 'browser_receipt' })
  if (!current) throw new Error('BROWSER_ATTEMPT_RECEIPT_INVALID')
  const expiresAt = nowSeconds + RECEIPT_TTL_SECONDS
  const signature = await crypto.subtle.sign('HMAC', current.key, receiptMessage(identity, expiresAt))
  return `v1.${current.keyId}.${expiresAt}.${base64Url(new Uint8Array(signature))}`
}

export async function verifyBrowserAttemptReceiptToken(
  keys: AttributionCryptoKeys,
  identity: BrowserAttemptIdentity & { receiptToken: string },
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!validIdentity(identity)) return false
  const token = TOKEN.exec(identity.receiptToken)
  if (!token) return false
  const expiresAt = Number(token[2])
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds) return false
  const candidates = await deriveAttributionHmacVerificationKeys({ keys, purpose: 'browser_receipt' })
  const selected = candidates.find(candidate => candidate.keyId === token[1])
  if (!selected) return false
  try {
    return await crypto.subtle.verify(
      'HMAC',
      selected.key,
      decodeBase64Url(token[3]!),
      receiptMessage(identity, expiresAt),
    )
  }
  catch {
    return false
  }
}

export async function recordBrowserAttemptReceipt(input: {
  db: D1Database
  keys: AttributionCryptoKeys
  deliveryId: string
  provider: AdAttributionProvider
  receiptToken: string
  receivedAt?: string
}) {
  if (!IDENTIFIER.test(input.deliveryId)) return { accepted: false, created: false }
  const delivery = await input.db.prepare(`
    SELECT delivery.id, delivery.provider, fact.external_event_id
    FROM attribution_deliveries AS delivery
    JOIN attribution_conversion_facts AS fact ON fact.id = delivery.fact_id
    WHERE delivery.id = ?
      AND delivery.provider = ?
      AND delivery.transport = 'browser'
      AND delivery.status NOT IN ('cancelled', 'rejected')
    LIMIT 1
  `).bind(input.deliveryId, input.provider).first<{
    id: string
    provider: AdAttributionProvider
    external_event_id: string
  }>()
  if (!delivery || !await verifyBrowserAttemptReceiptToken(input.keys, {
    deliveryId: delivery.id,
    provider: delivery.provider,
    externalEventId: delivery.external_event_id,
    receiptToken: input.receiptToken,
  })) return { accepted: false, created: false }

  const receiptId = await deterministicReceiptId(delivery.id)
  const result = await input.db.prepare(`
    INSERT OR IGNORE INTO attribution_provider_receipts (
      id, delivery_id, provider, receipt_type, status, receipt_json, received_at
    ) VALUES (?, ?, ?, 'browser_attempt', 'attempted', '{}', ?)
  `).bind(
    receiptId,
    delivery.id,
    delivery.provider,
    input.receivedAt ?? new Date().toISOString(),
  ).run()
  return {
    accepted: true,
    created: (result.meta?.changes ?? result.meta?.rows_written ?? 0) > 0,
  }
}

function validIdentity(value: BrowserAttemptIdentity) {
  return typeof value.deliveryId === 'string'
    && typeof value.externalEventId === 'string'
    && IDENTIFIER.test(value.deliveryId)
    && IDENTIFIER.test(value.externalEventId)
    && (value.provider === 'meta' || value.provider === 'tiktok' || value.provider === 'google')
}

function receiptMessage(identity: BrowserAttemptIdentity, expiresAt: number) {
  return new TextEncoder().encode([
    'meigallery-browser-attempt-v1',
    identity.provider,
    identity.deliveryId,
    identity.externalEventId,
    String(expiresAt),
  ].join('\n'))
}

async function deterministicReceiptId(deliveryId: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`browser-attempt\n${deliveryId}`))
  return `bar_${hex(new Uint8Array(digest)).slice(0, 32)}`
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string) {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(atob(standard), character => character.charCodeAt(0))
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
