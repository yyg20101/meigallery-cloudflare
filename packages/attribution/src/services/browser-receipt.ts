import { AttributionDomainError } from '../domain/errors'

export interface BrowserReceiptEnvironment {
  db: D1Database
  now?: () => Date
}

export interface RecordBrowserReceiptInput {
  deliveryId: string
  attemptedAt: string
}

export interface BrowserReceiptResult {
  deliveryId: string
  attemptedAt: string
}

interface BrowserReceiptRow {
  delivery_id: string
  attempted_at: string
}

interface EligibleBrowserDeliveryRow {
  delivery_id: string
  occurred_at: string
}

const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1_000

export async function recordBrowserReceipt(
  environment: BrowserReceiptEnvironment,
  input: RecordBrowserReceiptInput,
): Promise<BrowserReceiptResult> {
  validateIdentifier(input.deliveryId)
  const attemptedAt = parseTimestamp(input.attemptedAt)
  const now = trustedNow(environment.now)
  if (
    attemptedAt > now.getTime()
    || now.getTime() - attemptedAt > RECEIPT_WINDOW_MS
  ) {
    throw invalid()
  }

  const existing = await readReceipt(environment.db, input.deliveryId)
  if (existing) return receiptResult(existing)

  const delivery = await environment.db.prepare(`
    SELECT
      delivery.id AS delivery_id,
      fact.occurred_at
    FROM attribution_deliveries AS delivery
    INNER JOIN attribution_facts AS fact
      ON fact.id = delivery.fact_id
    WHERE delivery.id = ?
      AND delivery.transport = 'browser'
      AND delivery.status IN ('planned','accepted')
    LIMIT 1
  `).bind(input.deliveryId).first<EligibleBrowserDeliveryRow>()
  if (
    delivery?.delivery_id !== input.deliveryId
    || attemptedAt < parseTimestamp(delivery.occurred_at)
  ) {
    throw invalid()
  }

  const attemptedAtIso = new Date(attemptedAt).toISOString()
  try {
    const results = await environment.db.batch([
      environment.db.prepare(`
        INSERT INTO attribution_browser_receipts (
          delivery_id, attempted_at, created_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(delivery_id) DO NOTHING
      `).bind(input.deliveryId, attemptedAtIso, now.toISOString()),
      environment.db.prepare(`
        UPDATE attribution_deliveries
        SET status = CASE
              WHEN status = 'planned' THEN 'accepted'
              ELSE status
            END,
            updated_at = ?
        WHERE id = ?
          AND transport = 'browser'
          AND status IN ('planned','accepted')
      `).bind(now.toISOString(), input.deliveryId),
    ])
    if (
      Number(results[1]?.meta.changes ?? 0) !== 1
      || Number(results[0]?.meta.changes ?? 0) > 1
    ) {
      throw invalid()
    }
  } catch {
    const raced = await readReceipt(environment.db, input.deliveryId)
    if (raced) return receiptResult(raced)
    throw invalid()
  }

  const stored = await readReceipt(environment.db, input.deliveryId)
  if (!stored) throw invalid()
  return receiptResult(stored)
}

async function readReceipt(
  db: D1Database,
  deliveryId: string,
): Promise<BrowserReceiptRow | null> {
  return db.prepare(`
    SELECT delivery_id, attempted_at
    FROM attribution_browser_receipts
    WHERE delivery_id = ?
    LIMIT 1
  `).bind(deliveryId).first<BrowserReceiptRow>()
}

function receiptResult(row: BrowserReceiptRow): BrowserReceiptResult {
  if (
    !isIdentifier(row.delivery_id)
    || !Number.isFinite(parseTimestamp(row.attempted_at))
  ) {
    throw invalid()
  }
  return {
    deliveryId: row.delivery_id,
    attemptedAt: row.attempted_at,
  }
}

function trustedNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw invalid()
  return value
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw invalid()
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalid()
  }
  return parsed.getTime()
}

function validateIdentifier(value: unknown): asserts value is string {
  if (!isIdentifier(value)) throw invalid()
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9:_-]+$/.test(value)
}

function invalid(): AttributionDomainError {
  return new AttributionDomainError('ATTRIBUTION_BROWSER_RECEIPT_INVALID')
}
