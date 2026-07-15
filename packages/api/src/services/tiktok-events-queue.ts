// @ts-nocheck
// Task 14 删除前保留的历史模块；统一 Worker 运行时不会加载它。
import type { AdPlatformQueueMessage } from '@meigallery/shared'
import { ACTIVE_AD_PLATFORM_CONVERSION_EVENTS } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import {
  decryptTikTokEventsContext,
  loadTikTokEventsCryptoKeys,
  TikTokEventsCryptoError,
} from '../utils/tiktok-events-crypto'
import {
  readAdPlatformServerDelivery,
  recordDuplicateSuppressed,
  transitionDeliveryStatus,
  type AdPlatformServerDeliveryRow,
  type TransitionDeliveryStatusInput,
} from './ad-platform/delivery-store'
import { isRetryableAdPlatformDeliveryErrorCode } from './ad-platform/delivery-errors'
import {
  isSecureContextExpired,
  parseAdPlatformQueueMessage,
  safeQueueAck,
  safeQueueAttempts,
  safeQueueRetry,
  type AdPlatformQueueMessageParseResult,
} from './ad-platform/queue-message'
import {
  deleteAdPlatformSecureOutbox,
  enqueueAdPlatformSecureDelivery,
  type SecureOutboxEnv,
} from './ad-platform/secure-outbox'
import { requireVerifiedTikTokConnection } from './tiktok-connection'
import {
  sendTikTokEventsDelivery,
  TikTokEventsDeliveryError,
} from './tiktok-events-delivery'

const RETRY_DELAYS = [60, 300, 900, 1_800] as const
const RECOVERY_STALE_MINUTES = 5
const RECOVERY_BATCH_SIZE = 25
const SECURE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000
const TRANSITION_MAX_ATTEMPTS = 3
const EVENT_NAMES = new Set<string>(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS)
const UNKNOWN_DELIVERY_ID = 'unknown'

type TikTokQueueEnv = SecureOutboxEnv & Pick<Bindings, 'TIKTOK_EVENTS_QUEUE'>

export interface TikTokEventsRecoveryResult {
  scanned: number
  enqueued: number
  failed: number
  reason?: 'missing_queue'
}

export function computeTikTokRetryDelay(attempts: number) {
  const normalized = Number.isFinite(attempts) ? Math.trunc(attempts) : 1
  return RETRY_DELAYS[Math.max(0, Math.min(RETRY_DELAYS.length - 1, normalized - 1))]!
}

export async function recoverPendingTikTokEventsDeliveries(
  env: TikTokQueueEnv,
): Promise<TikTokEventsRecoveryResult> {
  if (!env.TIKTOK_EVENTS_QUEUE) return { scanned: 0, enqueued: 0, failed: 0, reason: 'missing_queue' }
  const stale = await env.DB.prepare(`
    SELECT d.id
    FROM analytics_conversion_deliveries d
    JOIN ad_platform_secure_outbox o
      ON o.delivery_id = d.id AND o.provider = 'tiktok' AND o.schema_version = 2
    WHERE d.provider = 'tiktok'
      AND d.transport = 'server'
      AND d.status = 'pending'
      AND d.event_name IN ('Contact', 'CompleteRegistration')
      AND d.queue_enqueued_at IS NULL
      AND d.updated_at <= datetime('now', '-${RECOVERY_STALE_MINUTES} minutes')
    ORDER BY d.updated_at ASC, d.id ASC
    LIMIT ?
  `).bind(RECOVERY_BATCH_SIZE).all<{ id: string }>()

  let enqueued = 0
  let failed = 0
  for (const delivery of stale.results) {
    const result = await enqueueAdPlatformSecureDelivery(env, {
      provider: 'tiktok',
      queue: env.TIKTOK_EVENTS_QUEUE,
      deliveryId: delivery.id,
      queueLabel: 'TikTok Events',
      requireStale: true,
    })
    if (result === 'enqueued') enqueued += 1
    else if (result === 'failed') failed += 1
  }
  return { scanned: stale.results.length, enqueued, failed }
}

export async function handleTikTokEventsBatch(
  batch: MessageBatch<AdPlatformQueueMessage>,
  env: Bindings,
) {
  const isDeadLetterQueue = batch.queue.endsWith('-dlq')
  for (const message of batch.messages) {
    try {
      await handleMessage(message, env, isDeadLetterQueue)
    }
    catch {
      retryMessage(message, UNKNOWN_DELIVERY_ID, 'tiktok_internal_error')
    }
  }
}

async function handleMessage(
  message: Message<AdPlatformQueueMessage>,
  env: Bindings,
  isDeadLetterQueue: boolean,
) {
  let body: unknown
  try {
    body = message.body
  }
  catch {
    logTerminal(UNKNOWN_DELIVERY_ID, 'queue_message_invalid')
    safeQueueAck(message)
    return
  }

  const parsed = parseAdPlatformQueueMessage(body)
  if (!parsed.message) {
    await terminateInvalidMessage(message, env.DB, parsed)
    return
  }
  if (isDeadLetterQueue) {
    await consumeDeadLetterMessage(message, env.DB, parsed.deliveryId)
    return
  }
  await consumeSecureMessage(message, env, parsed.message)
}

async function terminateInvalidMessage(
  message: Message<AdPlatformQueueMessage>,
  db: D1Database,
  parsed: AdPlatformQueueMessageParseResult,
) {
  let deliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = parsed.deliveryId
      ? await readAdPlatformServerDelivery(db, 'tiktok', parsed.deliveryId)
      : null
    if (delivery) {
      deliveryId = delivery.id
      if (delivery.status === 'sent') await recordDuplicateSuppressed(db, delivery)
      else if (!isTerminalDelivery(delivery)) {
        await confirmTerminalTransition(db, delivery, {
          status: 'failed',
          errorCode: parsed.errorCode,
        })
      }
      await deleteAdPlatformSecureOutbox(db, 'tiktok', delivery.id)
    }
    logTerminal(deliveryId, parsed.errorCode)
    safeQueueAck(message)
  }
  catch {
    retryMessage(message, deliveryId, 'tiktok_delivery_state_conflict')
  }
}

async function consumeDeadLetterMessage(
  message: Message<AdPlatformQueueMessage>,
  db: D1Database,
  candidateDeliveryId: string,
) {
  let deliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = await readAdPlatformServerDelivery(db, 'tiktok', candidateDeliveryId)
    if (delivery) {
      deliveryId = delivery.id
      if (delivery.status === 'sent') await recordDuplicateSuppressed(db, delivery)
      else if (!isTerminalDelivery(delivery)) {
        await confirmTerminalTransition(db, delivery, {
          status: 'failed',
          errorCode: 'retry_exhausted',
          errorMessage: 'TikTok Events API 请求失败',
        })
      }
      await deleteAdPlatformSecureOutbox(db, 'tiktok', delivery.id)
    }
    safeQueueAck(message)
  }
  catch {
    retryMessage(message, deliveryId, 'tiktok_delivery_state_conflict')
  }
}

async function consumeSecureMessage(
  message: Message<AdPlatformQueueMessage>,
  env: Bindings,
  body: AdPlatformQueueMessage,
) {
  let deliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = await readAdPlatformServerDelivery(env.DB, 'tiktok', body.deliveryId)
    if (!delivery) {
      safeQueueAck(message)
      return
    }
    deliveryId = delivery.id
    if (delivery.status === 'sent') {
      await recordDuplicateSuppressed(env.DB, delivery)
      return await finishMessage(message, env.DB, deliveryId)
    }
    if (isTerminalDelivery(delivery)) return await finishMessage(message, env.DB, deliveryId)
    if (isSecureContextExpired(delivery.created_at, SECURE_CONTEXT_TTL_MS)) {
      await confirmTerminalTransition(env.DB, delivery, { status: 'skipped', skipReason: 'secure_context_expired' })
      return await finishMessage(message, env.DB, deliveryId)
    }
    if (!EVENT_NAMES.has(delivery.event_name)) {
      await confirmTerminalTransition(env.DB, delivery, { status: 'skipped', skipReason: 'unsupported_event' })
      return await finishMessage(message, env.DB, deliveryId)
    }
    try {
      const connection = await requireVerifiedTikTokConnection(env)
      if (delivery.tracking_mode !== connection.trackingMode
        || delivery.connection_revision !== connection.revision) throw new Error('connection_unverified')
    }
    catch {
      await confirmTerminalTransition(env.DB, delivery, { status: 'skipped', skipReason: 'connection_unverified' })
      return await finishMessage(message, env.DB, deliveryId)
    }

    let keys: Awaited<ReturnType<typeof loadTikTokEventsCryptoKeys>>
    try {
      if (delivery.encryption_key_id !== body.envelope.keyId) throw new Error('secure_context_payload_invalid')
      keys = await loadTikTokEventsCryptoKeys(env)
    }
    catch {
      await failSecureContext(env.DB, delivery, 'secure_context_payload_invalid')
      logTerminal(deliveryId, 'secure_context_payload_invalid')
      return await finishMessage(message, env.DB, deliveryId)
    }

    let userData
    try {
      userData = await decryptTikTokEventsContext({
        keys,
        aad: {
          deliveryId,
          externalEventId: delivery.external_event_id,
          eventName: delivery.event_name as 'Contact' | 'CompleteRegistration',
        },
        envelope: {
          schemaVersion: 2,
          keyId: body.envelope.keyId,
          iv: body.envelope.iv,
          ciphertext: body.envelope.ciphertext,
          tag: body.envelope.tag,
        },
      })
    }
    catch (error) {
      const code = error instanceof TikTokEventsCryptoError
        && error.code === 'TIKTOK_EVENTS_AUTHENTICATION_FAILED'
        ? 'secure_context_authentication_failed'
        : 'secure_context_payload_invalid'
      await failSecureContext(env.DB, delivery, code)
      logTerminal(deliveryId, code)
      return await finishMessage(message, env.DB, deliveryId)
    }

    try {
      const result = await sendTikTokEventsDelivery(env, deliveryId, { userData })
      if (result.status === 'sent'
        || result.status === 'skipped'
        || result.status === 'failed'
        || result.status === 'duplicate_suppressed') {
        return await finishMessage(message, env.DB, deliveryId)
      }
      retryMessage(message, deliveryId, 'tiktok_delivery_state_conflict')
    }
    catch (error) {
      if (error instanceof TikTokEventsDeliveryError && !error.retryable) {
        return await finishMessage(message, env.DB, deliveryId)
      }
      retryMessage(
        message,
        deliveryId,
        error instanceof TikTokEventsDeliveryError ? error.code : 'tiktok_internal_error',
      )
    }
  }
  catch {
    retryMessage(message, deliveryId, 'tiktok_internal_error')
  }
}

async function failSecureContext(db: D1Database, delivery: AdPlatformServerDeliveryRow, errorCode: string) {
  if (delivery.status === 'sent') return recordDuplicateSuppressed(db, delivery)
  if (isTerminalDelivery(delivery)) return
  await confirmTerminalTransition(db, delivery, { status: 'failed', errorCode })
}

async function confirmTerminalTransition(
  db: D1Database,
  delivery: AdPlatformServerDeliveryRow,
  input: TransitionDeliveryStatusInput,
) {
  let current = delivery
  for (let attempt = 0; attempt < TRANSITION_MAX_ATTEMPTS; attempt += 1) {
    if (isTerminalDelivery(current) || current.status === 'sent') return current
    const transition = await transitionDeliveryStatus(db, current, input)
    if (transition.changed) {
      return {
        ...current,
        status: input.status,
        skip_reason: input.skipReason ?? '',
        error_code: input.errorCode ?? '',
        error_message: input.errorMessage ?? '',
      }
    }
    const refreshed = await readAdPlatformServerDelivery(db, 'tiktok', current.id)
    if (!refreshed) throw new Error('tiktok_delivery_state_conflict')
    current = refreshed
  }
  if (isTerminalDelivery(current) || current.status === 'sent') return current
  throw new Error('tiktok_delivery_state_conflict')
}

async function finishMessage(message: Message<AdPlatformQueueMessage>, db: D1Database, deliveryId: string) {
  await deleteAdPlatformSecureOutbox(db, 'tiktok', deliveryId)
  safeQueueAck(message)
}

function isTerminalDelivery(delivery: AdPlatformServerDeliveryRow) {
  if (delivery.status === 'skipped' || delivery.status === 'duplicate_suppressed') return true
  if (delivery.status !== 'failed') return false
  return !isRetryableAdPlatformDeliveryErrorCode(delivery.error_code)
}

function retryMessage(message: Message<AdPlatformQueueMessage>, deliveryId: string, errorCode: string) {
  const attempts = safeQueueAttempts(message)
  const delaySeconds = computeTikTokRetryDelay(attempts)
  console.error('[tiktok-events] Queue 安排重试', { deliveryId, errorCode, attempts, delaySeconds })
  safeQueueRetry(message, delaySeconds)
}

function logTerminal(deliveryId: string, errorCode: string) {
  console.error('[tiktok-events] Queue 消息安全终止', { deliveryId, errorCode })
}
