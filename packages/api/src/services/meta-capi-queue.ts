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

export function computeMetaRetryDelay(attempts: number) {
  const normalizedAttempts = Number.isFinite(attempts) ? Math.trunc(attempts) : 1
  const index = Math.max(0, Math.min(META_RETRY_DELAYS.length - 1, normalizedAttempts - 1))
  return META_RETRY_DELAYS[index]!
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
  })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}
