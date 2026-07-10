import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import {
  MetaCapiDeliveryError,
  confirmDeliveryTransition,
  readMetaCapiDelivery,
  recordDuplicateSuppressed,
  sendMetaCapiEvent,
} from './meta-capi'

const META_RETRY_DELAYS = [60, 300, 900, 1800] as const
const META_RECOVERY_STALE_MINUTES = 5
const META_RECOVERY_BATCH_SIZE = 25

type MetaCapiQueueEnv = Pick<Bindings, 'DB' | 'META_CAPI_QUEUE'>

export interface MetaCapiRecoveryResult {
  scanned: number
  enqueued: number
  failed: number
  reason?: 'missing_queue'
}

export function computeMetaRetryDelay(attempts: number) {
  const normalizedAttempts = Number.isFinite(attempts) ? Math.trunc(attempts) : 1
  const index = Math.max(0, Math.min(META_RETRY_DELAYS.length - 1, normalizedAttempts - 1))
  return META_RETRY_DELAYS[index]!
}

export async function recoverPendingMetaCapiDeliveries(
  env: MetaCapiQueueEnv,
): Promise<MetaCapiRecoveryResult> {
  if (!env.META_CAPI_QUEUE) return { scanned: 0, enqueued: 0, failed: 0, reason: 'missing_queue' }

  const stale = await env.DB.prepare(`
    SELECT id
    FROM analytics_conversion_deliveries
    WHERE channel = 'meta_capi'
      AND status = 'pending'
      AND queue_enqueued_at IS NULL
      AND updated_at <= datetime('now', '-${META_RECOVERY_STALE_MINUTES} minutes')
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `).bind(META_RECOVERY_BATCH_SIZE).all<{ id: string }>()

  let enqueued = 0
  let failed = 0
  for (const delivery of stale.results) {
    const result = await enqueueMetaCapiDelivery(env, delivery.id, {}, { requireStale: true })
    if (result === 'enqueued') enqueued += 1
    else if (result === 'failed') failed += 1
  }
  return { scanned: stale.results.length, enqueued, failed }
}

export async function enqueueMetaCapiDelivery(
  env: MetaCapiQueueEnv,
  deliveryId: string,
  userData: MetaCapiQueueMessage['userData'],
  options: { requireStale?: boolean } = {},
): Promise<'enqueued' | 'failed' | 'not_pending'> {
  if (!env.META_CAPI_QUEUE) {
    await markQueueUnavailable(env.DB, deliveryId)
    return 'failed'
  }

  const staleCondition = options.requireStale
    ? `AND updated_at <= datetime('now', '-${META_RECOVERY_STALE_MINUTES} minutes')`
    : ''
  const claimed = await env.DB.prepare(`
    UPDATE analytics_conversion_deliveries
    SET
      queue_attempt_count = queue_attempt_count + 1,
      error_code = '',
      error_message = '',
      updated_at = datetime('now')
    WHERE id = ?
      AND channel = 'meta_capi'
      AND status = 'pending'
      AND queue_enqueued_at IS NULL
      ${staleCondition}
  `).bind(deliveryId).run()
  if (!d1Changed(claimed)) return 'not_pending'

  try {
    await env.META_CAPI_QUEUE.send({ schemaVersion: 1, deliveryId, userData })
  } catch {
    await markQueueSendFailed(env.DB, deliveryId)
    return 'failed'
  }

  try {
    await env.DB.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        queue_enqueued_at = datetime('now'),
        error_code = '',
        error_message = '',
        updated_at = datetime('now')
      WHERE id = ?
        AND channel = 'meta_capi'
        AND status = 'pending'
        AND queue_enqueued_at IS NULL
    `).bind(deliveryId).run()
    return 'enqueued'
  } catch {
    return 'failed'
  }
}

export async function handleMetaCapiBatch(
  batch: MessageBatch<MetaCapiQueueMessage>,
  env: Bindings,
) {
  const isDeadLetterQueue = batch.queue.endsWith('-dlq')
  for (const message of batch.messages) {
    if (isDeadLetterQueue) {
      try {
        await markRetryExhausted(env.DB, message.body.deliveryId)
        message.ack()
      } catch {
        console.error('[meta-capi] DLQ 回写失败', { deliveryId: message.body.deliveryId })
        message.retry({ delaySeconds: computeMetaRetryDelay(message.attempts) })
      }
      continue
    }

    try {
      await sendMetaCapiEvent(env, message.body.deliveryId, { userData: message.body.userData })
      message.ack()
    } catch (error) {
      if (error instanceof MetaCapiDeliveryError && !error.retryable) {
        console.error('[meta-capi] Queue 永久失败', { deliveryId: message.body.deliveryId })
        message.ack()
        continue
      }
      const delaySeconds = computeMetaRetryDelay(message.attempts)
      console.error('[meta-capi] Queue 安排重试', {
        deliveryId: message.body.deliveryId,
        errorCode: error instanceof MetaCapiDeliveryError ? error.code : 'meta_internal_error',
        attempts: message.attempts,
        delaySeconds,
      })
      message.retry({ delaySeconds })
    }
  }
}

async function markRetryExhausted(db: D1Database, deliveryId: string) {
  const delivery = await readMetaCapiDelivery(db, deliveryId)
  if (!delivery) return
  if (delivery.status === 'sent') {
    await recordDuplicateSuppressed(db, delivery)
    return
  }
  const persisted = await confirmDeliveryTransition(db, delivery, {
    status: 'failed',
    errorCode: 'retry_exhausted',
    errorMessage: 'Meta CAPI 请求失败',
  }, { allowAnyNonSent: true })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

async function markQueueUnavailable(db: D1Database, deliveryId: string) {
  await db.prepare(`
    UPDATE analytics_conversion_deliveries
    SET
      error_code = 'missing_queue',
      error_message = '',
      updated_at = datetime('now')
    WHERE id = ?
      AND channel = 'meta_capi'
      AND status = 'pending'
      AND queue_enqueued_at IS NULL
  `).bind(deliveryId).run()
}

async function markQueueSendFailed(db: D1Database, deliveryId: string) {
  try {
    await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET
        error_code = 'queue_send_failed',
        error_message = 'Meta CAPI Queue 发送失败',
        updated_at = datetime('now')
      WHERE id = ?
        AND channel = 'meta_capi'
        AND status = 'pending'
        AND queue_enqueued_at IS NULL
    `).bind(deliveryId).run()
  } catch {
    // 外部 Queue 失败后的诊断补记不能改变已提交转化的响应。
  }
}

function d1Changed(result: D1Result<unknown>) {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 1) > 0
}
