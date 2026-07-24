import type {
  AttributionAppEnvironment,
} from '../env'
import type { AttributionProvider } from '@meigallery/shared'
import type { AttributionQueueMessage } from '../domain/queue'

export type { AttributionQueueMessage } from '../domain/queue'

export type AttributionProviderQueues = Readonly<
  Record<AttributionProvider, Queue<AttributionQueueMessage>>
>

export interface SecureOutboxEnvironment {
  db: D1Database
  queues: AttributionProviderQueues
  now?: () => Date
}

export type EnqueueDeliveryResult =
  | 'enqueued'
  | 'failed'
  | 'expired'
  | 'not_pending'

export interface OutboxRecoveryResult {
  attempted: number
  enqueued: number
  failed: number
  expired: number
}

interface OutboxDeliveryRow {
  delivery_id: string
  provider: string
  status: string
  queue_attempt_count: number
  updated_at: string
  expires_at: string
  circuit_state: string
}

const PROVIDERS = [
  'meta',
  'tiktok',
  'google',
] as const satisfies readonly AttributionProvider[]
const STALE_AFTER_MS = 5 * 60 * 1_000
const MAX_RECOVERY_BATCH = 100

export async function enqueueServerDelivery(
  environment: SecureOutboxEnvironment,
  input: {
    provider: AttributionProvider
    deliveryId: string
  },
): Promise<EnqueueDeliveryResult> {
  if (!isProvider(input.provider) || !isIdentifier(input.deliveryId)) {
    return 'not_pending'
  }
  const now = trustedNow(environment.now)
  const row = await readOutboxDelivery(
    environment.db,
    input.deliveryId,
  )
  if (
    !row
    || row.provider !== input.provider
    || row.circuit_state !== 'closed'
    || !recoverable(row, now)
  ) {
    return 'not_pending'
  }
  if (expired(row.expires_at, now)) {
    return await rejectExpired(environment.db, row, now)
      ? 'expired'
      : 'not_pending'
  }

  const queueAttempt = row.queue_attempt_count + 1
  const claimed = await environment.db.prepare(`
    UPDATE attribution_deliveries
    SET status = 'queued',
        queue_attempt_count = ?,
        last_error_code = '',
        updated_at = ?
    WHERE id = ?
      AND provider = ?
      AND transport = 'server'
      AND status = ?
      AND queue_attempt_count = ?
      AND updated_at = ?
      AND EXISTS (
        SELECT 1
        FROM attribution_outbox AS outbox
        WHERE outbox.delivery_id = attribution_deliveries.id
          AND outbox.provider = attribution_deliveries.provider
      )
  `).bind(
    queueAttempt,
    now.toISOString(),
    row.delivery_id,
    row.provider,
    row.status,
    row.queue_attempt_count,
    row.updated_at,
  ).run()
  if (!changed(claimed)) return 'not_pending'

  try {
    await environment.queues[input.provider].send({
      schemaVersion: 1,
      provider: input.provider,
      deliveryId: input.deliveryId,
    })
    return 'enqueued'
  } catch {
    try {
      await environment.db.prepare(`
        UPDATE attribution_deliveries
        SET status = 'retrying',
            last_error_code = 'queue_send_failed',
            updated_at = ?
        WHERE id = ?
          AND provider = ?
          AND transport = 'server'
          AND status = 'queued'
          AND queue_attempt_count = ?
      `).bind(
        now.toISOString(),
        input.deliveryId,
        input.provider,
        queueAttempt,
      ).run()
    } catch {
      // Outbox 仍保留，后续定时恢复会重新定位该 Delivery。
    }
    return 'failed'
  }
}

export async function recoverPendingServerOutbox(
  environment: SecureOutboxEnvironment,
  limit = MAX_RECOVERY_BATCH,
): Promise<OutboxRecoveryResult> {
  const now = trustedNow(environment.now)
  const normalizedLimit = normalizeLimit(limit)
  if (normalizedLimit === 0) {
    return { attempted: 0, enqueued: 0, failed: 0, expired: 0 }
  }
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS).toISOString()
  const result = await environment.db.prepare(`
    SELECT
      delivery.id AS delivery_id,
      delivery.provider
    FROM attribution_deliveries AS delivery
    INNER JOIN attribution_outbox AS outbox
      ON outbox.delivery_id = delivery.id
     AND outbox.provider = delivery.provider
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = delivery.connection_id
    WHERE delivery.transport = 'server'
      AND policy.enabled = 1
      AND policy.server_enabled = 1
      AND policy.server_effective_percentage > 0
      AND policy.circuit_state = 'closed'
      AND (
        delivery.status = 'planned'
        OR (
          delivery.status IN ('queued','retrying')
          AND delivery.updated_at <= ?
        )
      )
    ORDER BY outbox.created_at ASC, delivery.id ASC
    LIMIT ?
  `).bind(cutoff, normalizedLimit).all<{
    delivery_id: string
    provider: string
  }>()

  const summary: OutboxRecoveryResult = {
    attempted: 0,
    enqueued: 0,
    failed: 0,
    expired: 0,
  }
  for (const row of result.results) {
    if (!isProvider(row.provider) || !isIdentifier(row.delivery_id)) continue
    summary.attempted += 1
    const outcome = await enqueueServerDelivery(environment, {
      provider: row.provider,
      deliveryId: row.delivery_id,
    })
    if (outcome === 'enqueued') summary.enqueued += 1
    if (outcome === 'failed') summary.failed += 1
    if (outcome === 'expired') summary.expired += 1
  }
  return summary
}

export async function purgeExpiredServerOutbox(
  db: D1Database,
  now = new Date(),
  limit = MAX_RECOVERY_BATCH,
): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new Error('OUTBOX_NOW_INVALID')
  const normalizedLimit = normalizeLimit(limit)
  if (normalizedLimit === 0) return 0
  const result = await db.prepare(`
    SELECT
      delivery.id AS delivery_id,
      delivery.provider,
      delivery.status,
      delivery.queue_attempt_count,
      delivery.updated_at,
      outbox.expires_at,
      'closed' AS circuit_state
    FROM attribution_deliveries AS delivery
    INNER JOIN attribution_outbox AS outbox
      ON outbox.delivery_id = delivery.id
     AND outbox.provider = delivery.provider
    WHERE (
      outbox.expires_at <= ?
      OR datetime(outbox.expires_at) IS NULL
    )
    ORDER BY outbox.expires_at ASC, delivery.id ASC
    LIMIT ?
  `).bind(now.toISOString(), normalizedLimit).all<OutboxDeliveryRow>()

  let purged = 0
  for (const row of result.results) {
    if (!validRow(row)) continue
    if (await rejectExpired(db, row, now)) purged += 1
  }
  return purged
}

export function physicalQueue(
  queueName: string,
  appEnvironment: AttributionAppEnvironment,
): {
  provider: AttributionProvider
  deadLetter: boolean
} | null {
  const suffix = appEnvironment === 'production' ? '' : '-dev'
  for (const provider of PROVIDERS) {
    if (queueName === `meigallery-attribution-${provider}${suffix}`) {
      return { provider, deadLetter: false }
    }
    if (queueName === `meigallery-attribution-${provider}${suffix}-dlq`) {
      return { provider, deadLetter: true }
    }
  }
  return null
}

async function readOutboxDelivery(
  db: D1Database,
  deliveryId: string,
): Promise<OutboxDeliveryRow | null> {
  const row = await db.prepare(`
    SELECT
      delivery.id AS delivery_id,
      delivery.provider,
      delivery.status,
      delivery.queue_attempt_count,
      delivery.updated_at,
      outbox.expires_at,
      policy.circuit_state
    FROM attribution_deliveries AS delivery
    INNER JOIN attribution_outbox AS outbox
      ON outbox.delivery_id = delivery.id
     AND outbox.provider = delivery.provider
    INNER JOIN attribution_runtime_policies AS policy
      ON policy.connection_id = delivery.connection_id
    WHERE delivery.id = ?
      AND delivery.transport = 'server'
    LIMIT 1
  `).bind(deliveryId).first<OutboxDeliveryRow>()
  return row && validRow(row) ? row : null
}

async function rejectExpired(
  db: D1Database,
  row: OutboxDeliveryRow,
  now: Date,
): Promise<boolean> {
  if (terminal(row.status)) {
    const deleted = await db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id = ? AND provider = ?
    `).bind(row.delivery_id, row.provider).run()
    return changed(deleted)
  }
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'rejected',
          last_error_code = 'outbox_expired',
          updated_at = ?
      WHERE id = ?
        AND provider = ?
        AND transport = 'server'
        AND status = ?
        AND queue_attempt_count = ?
        AND updated_at = ?
        AND status IN ('planned','queued','retrying')
    `).bind(
      now.toISOString(),
      row.delivery_id,
      row.provider,
      row.status,
      row.queue_attempt_count,
      row.updated_at,
    ),
    db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id = ?
        AND provider = ?
        AND EXISTS (
          SELECT 1
          FROM attribution_deliveries
          WHERE id = ?
            AND provider = ?
            AND status = 'rejected'
            AND last_error_code = 'outbox_expired'
        )
    `).bind(
      row.delivery_id,
      row.provider,
      row.delivery_id,
      row.provider,
    ),
  ])
  return changed(results[1])
}

function recoverable(row: OutboxDeliveryRow, now: Date): boolean {
  return row.status === 'planned'
    || (
      (row.status === 'queued' || row.status === 'retrying')
      && timestamp(row.updated_at) <= now.getTime() - STALE_AFTER_MS
    )
}

function expired(value: string, now: Date): boolean {
  return timestamp(value) <= now.getTime()
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function validRow(row: OutboxDeliveryRow): boolean {
  return isIdentifier(row.delivery_id)
    && isProvider(row.provider)
    && Number.isSafeInteger(row.queue_attempt_count)
    && row.queue_attempt_count >= 0
    && typeof row.status === 'string'
    && typeof row.updated_at === 'string'
    && typeof row.expires_at === 'string'
    && (
      row.circuit_state === 'closed'
      || row.circuit_state === 'server_open'
    )
}

function terminal(status: string): boolean {
  return status === 'accepted'
    || status === 'processed'
    || status === 'rejected'
    || status === 'dead_letter'
    || status === 'cancelled'
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_RECOVERY_BATCH
  return Math.max(0, Math.min(MAX_RECOVERY_BATCH, Math.trunc(value)))
}

function trustedNow(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))()
  if (!Number.isFinite(value.getTime())) throw new Error('OUTBOX_NOW_INVALID')
  return value
}

function isProvider(value: unknown): value is AttributionProvider {
  return value === 'meta' || value === 'tiktok' || value === 'google'
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9:_-]{1,240}$/.test(value)
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return Number(result?.meta.changes ?? 0) > 0
}
