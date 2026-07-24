import type {
  AttributionProvider,
} from '@meigallery/shared'
import type {
  ProviderDeliveryResult,
} from '../adapters/types'
import {
  openServerCircuitForFailure,
  recordServerSuccess,
  recordTransientFailure,
} from './circuit-breaker'
import {
  changed,
  isIdentifier,
  queueInvalid,
  trustedNow,
} from './queue-contract'
import type {
  AttributionQueueConsumerEnvironment,
  DeliveryHeader,
  DeliverySnapshot,
} from './queue-types'

export async function claimDelivery(
  db: D1Database,
  row: DeliverySnapshot,
  now: Date,
): Promise<number | null> {
  if (row.status !== 'queued' && row.status !== 'retrying') return null
  const result = await db.prepare(`
    UPDATE attribution_deliveries
    SET status = 'retrying',
        attempt_count = attempt_count + 1,
        last_error_code = 'processing',
        updated_at = ?
    WHERE id = ?
      AND provider = ?
      AND transport = 'server'
      AND status = ?
      AND attempt_count = ?
      AND last_error_code = ?
      AND updated_at = ?
  `).bind(
    now.toISOString(),
    row.deliveryId,
    row.provider,
    row.status,
    row.attemptCount,
    row.lastErrorCode,
    row.updatedAt,
  ).run()
  return changed(result) ? row.attemptCount + 1 : null
}

export async function persistTerminalResult(
  environment: AttributionQueueConsumerEnvironment,
  row: DeliverySnapshot,
  attempt: number,
  result: ProviderDeliveryResult,
  status: 'accepted' | 'processed' | 'rejected',
  lastErrorCode: string,
): Promise<void> {
  const now = trustedNow(environment.now).toISOString()
  const results = await environment.db.batch([
    receiptStatement(environment.db, row, attempt, result, now),
    environment.db.prepare(`
      UPDATE attribution_deliveries
      SET status = ?,
          last_error_code = ?,
          updated_at = ?
      WHERE id = ?
        AND provider = ?
        AND transport = 'server'
        AND status = 'retrying'
        AND attempt_count = ?
        AND last_error_code = 'processing'
    `).bind(
      status,
      lastErrorCode,
      now,
      row.deliveryId,
      row.provider,
      attempt,
    ),
    environment.db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id = ?
        AND provider = ?
        AND EXISTS (
          SELECT 1
          FROM attribution_deliveries
          WHERE id = ?
            AND provider = ?
            AND status = ?
            AND attempt_count = ?
        )
    `).bind(
      row.deliveryId,
      row.provider,
      row.deliveryId,
      row.provider,
      status,
      attempt,
    ),
  ])
  if (
    !changed(results[0])
    || !changed(results[1])
    || !changed(results[2])
  ) {
    throw queueInvalid()
  }
}

export async function persistRetryableResult(
  environment: AttributionQueueConsumerEnvironment,
  row: DeliverySnapshot,
  attempt: number,
  result: ProviderDeliveryResult & { classification: 'retryable' },
): Promise<boolean> {
  const now = trustedNow(environment.now)
  const results = await environment.db.batch([
    receiptStatement(
      environment.db,
      row,
      attempt,
      result,
      now.toISOString(),
    ),
    environment.db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'retrying',
          last_error_code = 'provider_retryable',
          updated_at = ?
      WHERE id = ?
        AND provider = ?
        AND transport = 'server'
        AND status = 'retrying'
        AND attempt_count = ?
        AND last_error_code = 'processing'
    `).bind(
      now.toISOString(),
      row.deliveryId,
      row.provider,
      attempt,
    ),
  ])
  if (!changed(results[0]) || !changed(results[1])) throw queueInvalid()
  return (await recordTransientFailure(environment, {
    connectionId: row.connectionId,
    provider: row.provider,
  })).opened
}

export async function rejectLocally(
  environment: AttributionQueueConsumerEnvironment,
  row: DeliverySnapshot,
  code: string,
  attempt?: number,
): Promise<void> {
  const now = trustedNow(environment.now).toISOString()
  const effectiveAttempt = attempt ?? row.attemptCount
  const results = await environment.db.batch([
    environment.db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'rejected',
          last_error_code = ?,
          updated_at = ?
      WHERE id = ?
        AND provider = ?
        AND transport = 'server'
        AND attempt_count = ?
        AND status IN ('planned','queued','retrying')
    `).bind(
      code,
      now,
      row.deliveryId,
      row.provider,
      effectiveAttempt,
    ),
    environment.db.prepare(`
      DELETE FROM attribution_outbox
      WHERE delivery_id = ?
        AND provider = ?
        AND EXISTS (
          SELECT 1
          FROM attribution_deliveries
          WHERE id = ?
            AND provider = ?
            AND status = 'rejected'
            AND last_error_code = ?
        )
    `).bind(
      row.deliveryId,
      row.provider,
      row.deliveryId,
      row.provider,
      code,
    ),
    incidentStatement(environment, {
      provider: row.provider,
      connectionId: row.connectionId,
      code,
    }),
  ])
  if (!changed(results[0]) || !changed(results[1])) throw queueInvalid()
}

export async function parkForOpenCircuit(
  db: D1Database,
  row: DeliverySnapshot,
  now: Date,
): Promise<void> {
  await db.prepare(`
    UPDATE attribution_deliveries
    SET status = 'retrying',
        last_error_code = 'server_circuit_open',
        updated_at = ?
    WHERE id = ?
      AND provider = ?
      AND transport = 'server'
      AND status IN ('planned','queued','retrying')
  `).bind(now.toISOString(), row.deliveryId, row.provider).run()
}

export async function cancelForRuntimePolicy(
  db: D1Database,
  row: DeliverySnapshot,
  now: Date,
): Promise<void> {
  const results = await db.batch([
    db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'cancelled',
          last_error_code = 'runtime_policy_disabled',
          updated_at = ?
      WHERE id = ?
        AND provider = ?
        AND transport = 'server'
        AND status IN ('planned','queued','retrying')
        AND attempt_count = ?
    `).bind(
      now.toISOString(),
      row.deliveryId,
      row.provider,
      row.attemptCount,
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
            AND status = 'cancelled'
            AND last_error_code = 'runtime_policy_disabled'
        )
    `).bind(
      row.deliveryId,
      row.provider,
      row.deliveryId,
      row.provider,
    ),
  ])
  if (!changed(results[0]) || !changed(results[1])) throw queueInvalid()
}

export async function deleteResidualOutbox(
  db: D1Database,
  deliveryId: string,
  provider: AttributionProvider,
): Promise<void> {
  await db.prepare(`
    DELETE FROM attribution_outbox
    WHERE delivery_id = ? AND provider = ?
  `).bind(deliveryId, provider).run()
}

export async function reconcileTerminalCircuit(
  environment: AttributionQueueConsumerEnvironment,
  header: DeliveryHeader,
): Promise<void> {
  const receipt = await environment.db.prepare(`
    SELECT classification
    FROM attribution_delivery_receipts
    WHERE delivery_id = ?
    ORDER BY attempt_count DESC
    LIMIT 1
  `).bind(header.deliveryId).first<{ classification: string }>()
  if (
    receipt?.classification === 'accepted'
    || receipt?.classification === 'processed'
  ) {
    await recordServerSuccess(environment, {
      connectionId: header.connectionId,
      provider: header.provider,
    })
  }
  if (
    receipt?.classification === 'credential_invalid'
    || receipt?.classification === 'destination_invalid'
  ) {
    await openServerCircuitForFailure(environment, {
      connectionId: header.connectionId,
      provider: header.provider,
      code: `provider_${receipt.classification}`,
    })
  }
}

export async function recordQueueIncident(
  environment: AttributionQueueConsumerEnvironment,
  input: {
    provider: AttributionProvider
    connectionId: string | null
    code: string
  },
): Promise<void> {
  await incidentStatement(environment, input).run()
}

export async function markDeadLetter(
  environment: AttributionQueueConsumerEnvironment,
  row: DeliverySnapshot,
): Promise<void> {
  await environment.db.batch([
    environment.db.prepare(`
      UPDATE attribution_deliveries
      SET status = 'dead_letter',
          last_error_code = 'queue_dead_letter',
          updated_at = ?
      WHERE id = ?
        AND provider = ?
        AND transport = 'server'
        AND status IN ('planned','queued','retrying')
    `).bind(
      trustedNow(environment.now).toISOString(),
      row.deliveryId,
      row.provider,
    ),
    incidentStatement(environment, {
      provider: row.provider,
      connectionId: row.connectionId,
      code: 'queue_dead_letter',
    }),
  ])
}

function receiptStatement(
  db: D1Database,
  row: DeliverySnapshot,
  attempt: number,
  result: ProviderDeliveryResult,
  now: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO attribution_delivery_receipts (
      id, delivery_id, provider, classification,
      http_status, request_id, provider_code,
      attempt_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `receipt_${row.deliveryId}_${attempt}`,
    row.deliveryId,
    row.provider,
    result.classification,
    result.httpStatus ?? null,
    result.requestId ?? '',
    result.providerCode ?? null,
    attempt,
    now,
  )
}

function incidentStatement(
  environment: AttributionQueueConsumerEnvironment,
  input: {
    provider: AttributionProvider
    connectionId: string | null
    code: string
  },
): D1PreparedStatement {
  const now = trustedNow(environment.now).toISOString()
  const idFactory = environment.idFactory
    ?? (prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`)
  const id = idFactory('incident')
  if (
    !isIdentifier(id)
    || !/^[a-z0-9_]{1,120}$/.test(input.code)
  ) {
    throw queueInvalid()
  }
  return environment.db.prepare(`
    INSERT OR IGNORE INTO attribution_incidents (
      id, provider, connection_id, severity, status, code,
      affected_transport, affected_fact_count,
      affected_delivery_count, opened_at, detected_at
    ) VALUES (
      ?, ?, ?, 'critical', 'open', ?, 'server', 0, 1, ?, ?
    )
  `).bind(
    id,
    input.provider,
    input.connectionId,
    input.code,
    now,
    now,
  )
}
