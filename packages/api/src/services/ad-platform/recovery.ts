import { enqueueAttributionDelivery, getAttributionQueue, listRecoverableAttributionOutbox, purgeExpiredAttributionOutbox, type AttributionQueueEnv } from './secure-outbox'

export async function recoverAttributionOutbox(env: AttributionQueueEnv, limit = 100): Promise<{ scanned: number; enqueued: number; failed: number; expired: number }> {
  const expired = await purgeExpiredAttributionOutbox(env.DB, limit)
  const rows = await listRecoverableAttributionOutbox(env.DB, limit)
  let enqueued = 0
  let failed = 0
  for (const row of rows) {
    const result = await enqueueAttributionDelivery(env, { ...row, queue: getAttributionQueue(env, row.provider) })
    if (result === 'enqueued') enqueued += 1
    else if (result === 'failed') failed += 1
  }
  return { scanned: rows.length, enqueued, failed, expired }
}
