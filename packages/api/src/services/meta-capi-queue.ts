// @ts-nocheck
// Task 14 删除前保留的历史模块；统一 Worker 运行时不会加载它。
import type { AdPlatformQueueMessage } from '@meigallery/shared'
import { ACTIVE_AD_PLATFORM_CONVERSION_EVENTS } from '@meigallery/shared/constants'
import type { Bindings } from '../index'
import {
  decryptMetaCapiContext,
  loadMetaCapiCryptoKeys,
  MetaCapiCryptoError,
} from '../utils/meta-capi-crypto'
import {
  MetaCapiDeliveryError,
  isRetryableMetaCapiErrorCode,
  readMetaCapiDelivery,
  sendMetaCapiEvent,
  type MetaCapiDeliveryRow,
} from './meta-capi'
import {
  recordDuplicateSuppressed,
  transitionDeliveryStatus,
  type TransitionDeliveryStatusInput,
} from './ad-platform/delivery-store'
import {
  deleteAdPlatformSecureOutbox,
  enqueueAdPlatformSecureDelivery,
  type SecureOutboxEnv,
} from './ad-platform/secure-outbox'
import { requireVerifiedMetaConnection } from './meta-connection'
import {
  createMetaIncidentTrigger,
  openMetaCapiIncidentSafely,
} from './meta-capi-circuit-breaker'
import {
  isSecureContextExpired,
  parseAdPlatformQueueMessage,
  safeQueueAck,
  safeQueueAttempts,
  safeQueueRetry,
  type AdPlatformQueueMessageParseResult,
} from './ad-platform/queue-message'

const META_RETRY_DELAYS = [60, 300, 900, 1800] as const
const META_RECOVERY_STALE_MINUTES = 5
const META_RECOVERY_BATCH_SIZE = 25
const SECURE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000
const META_CAPI_EVENT_NAMES = new Set<string>(ACTIVE_AD_PLATFORM_CONVERSION_EVENTS)
const QUEUE_TRANSITION_MAX_ATTEMPTS = 3
const UNKNOWN_DELIVERY_ID = 'unknown'
const SECURE_CONTEXT_AUTHENTICATION_FAILED = 'secure_context_authentication_failed'
const SECURE_CONTEXT_PAYLOAD_INVALID = 'secure_context_payload_invalid'

type MetaCapiQueueEnv = SecureOutboxEnv & Pick<Bindings, 'META_CAPI_QUEUE'>
type SecureContextFailureCode =
  | typeof SECURE_CONTEXT_AUTHENTICATION_FAILED
  | typeof SECURE_CONTEXT_PAYLOAD_INVALID

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
    SELECT d.id
    FROM analytics_conversion_deliveries d
    JOIN ad_platform_secure_outbox o
      ON o.delivery_id = d.id AND o.provider = 'meta' AND o.schema_version = 2
    WHERE d.provider = 'meta'
      AND d.transport = 'server'
      AND d.status = 'pending'
      AND d.event_name IN ('Contact', 'CompleteRegistration')
      AND d.queue_enqueued_at IS NULL
      AND d.updated_at <= datetime('now', '-${META_RECOVERY_STALE_MINUTES} minutes')
    ORDER BY d.updated_at ASC, d.id ASC
    LIMIT ?
  `).bind(META_RECOVERY_BATCH_SIZE).all<{ id: string }>()

  let enqueued = 0
  let failed = 0
  for (const delivery of stale.results) {
    const result = await enqueueAdPlatformSecureDelivery(env, {
      provider: 'meta',
      queue: env.META_CAPI_QUEUE,
      deliveryId: delivery.id,
      queueLabel: 'Meta CAPI',
      requireStale: true,
    })
    if (result === 'enqueued') enqueued += 1
    else if (result === 'failed') failed += 1
  }
  return { scanned: stale.results.length, enqueued, failed }
}

export async function handleMetaCapiBatch(
  batch: MessageBatch<AdPlatformQueueMessage>,
  env: Bindings,
) {
  const isDeadLetterQueue = batch.queue.endsWith('-dlq')
  for (const message of batch.messages) {
    try {
      await handleMetaCapiMessage(message, env, isDeadLetterQueue)
    } catch {
      retryMessage(message, UNKNOWN_DELIVERY_ID, 'meta_internal_error')
    }
  }
}

async function handleMetaCapiMessage(
  message: Message<AdPlatformQueueMessage>,
  env: Bindings,
  isDeadLetterQueue: boolean,
) {
  let body: unknown
  try {
    body = message.body
  } catch {
    console.error('[meta-capi] Queue 消息安全终止', {
      deliveryId: UNKNOWN_DELIVERY_ID,
      errorCode: 'queue_message_invalid',
    })
    ackMessage(message)
    return
  }

  const parsed = parseAdPlatformQueueMessage(body)
  if (!parsed.message) {
    await terminateInvalidQueueMessage(message, env.DB, parsed)
    return
  }

  if (isDeadLetterQueue) {
    await consumeDeadLetterMessage(message, env.DB, parsed.message.deliveryId)
    return
  }

  await consumeSecureMessage(message, env, parsed.message)
}

async function terminateInvalidQueueMessage(
  message: Message<AdPlatformQueueMessage>,
  db: D1Database,
  parsed: AdPlatformQueueMessageParseResult,
) {
  let logDeliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = parsed.deliveryId
      ? await readMetaCapiDelivery(db, parsed.deliveryId)
      : null
    if (delivery) {
      logDeliveryId = delivery.id
      if (parsed.errorCode === SECURE_CONTEXT_PAYLOAD_INVALID) {
        if (delivery.status === 'sent') await recordDuplicateSuppressed(db, delivery)
        else if (!isTerminalDelivery(delivery)) {
          await markSecureContextFailure(db, delivery, SECURE_CONTEXT_PAYLOAD_INVALID)
        }
        await deleteAdPlatformSecureOutbox(db, 'meta', delivery.id)
      } else {
        await terminateInvalidMessage(db, delivery)
      }
    }
    console.error('[meta-capi] Queue 消息安全终止', {
      deliveryId: logDeliveryId,
      errorCode: parsed.errorCode,
    })
    ackMessage(message)
  } catch {
    retryMessage(message, logDeliveryId, 'meta_delivery_state_conflict')
  }
}

async function consumeDeadLetterMessage(
  message: Message<AdPlatformQueueMessage>,
  db: D1Database,
  candidateDeliveryId: string,
) {
  let logDeliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = await readMetaCapiDelivery(db, candidateDeliveryId)
    if (delivery) {
      logDeliveryId = delivery.id
      await markRetryExhausted(db, delivery)
      await deleteAdPlatformSecureOutbox(db, 'meta', delivery.id)
    }
    ackMessage(message)
  } catch {
    retryMessage(message, logDeliveryId, 'meta_delivery_state_conflict')
  }
}

async function consumeSecureMessage(
  queueMessage: Message<AdPlatformQueueMessage>,
  env: Bindings,
  body: AdPlatformQueueMessage,
) {
  let logDeliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = await readMetaCapiDelivery(env.DB, body.deliveryId)
    if (!delivery) {
      ackMessage(queueMessage)
      return
    }
    const deliveryId = delivery.id
    logDeliveryId = deliveryId

    if (delivery.status === 'sent') {
      await recordDuplicateSuppressed(env.DB, delivery)
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      ackMessage(queueMessage)
      return
    }
    if (isTerminalDelivery(delivery)) {
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      ackMessage(queueMessage)
      return
    }
    if (isSecureContextExpired(delivery.created_at, SECURE_CONTEXT_TTL_MS)) {
      await markSkipped(env.DB, delivery, 'secure_context_expired')
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      ackMessage(queueMessage)
      return
    }
    if (!META_CAPI_EVENT_NAMES.has(delivery.event_name)) {
      await markSkipped(env.DB, delivery, 'unsupported_event')
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      ackMessage(queueMessage)
      return
    }
    try {
      const connection = await requireVerifiedMetaConnection(env)
      if (delivery.tracking_mode !== connection.trackingMode
        || delivery.connection_revision !== connection.revision) {
        throw new Error('connection_unverified')
      }
    }
    catch {
      await markSkipped(env.DB, delivery, 'connection_unverified')
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      ackMessage(queueMessage)
      return
    }

    let sensitiveContext
    let keys: Awaited<ReturnType<typeof loadMetaCapiCryptoKeys>>
    try {
      if (delivery.encryption_key_id !== body.envelope.keyId) {
        throw new Error(SECURE_CONTEXT_PAYLOAD_INVALID)
      }
      keys = await loadMetaCapiCryptoKeys(env)
    } catch {
      await markSecureContextFailure(env.DB, delivery, SECURE_CONTEXT_PAYLOAD_INVALID)
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      console.error('[meta-capi] Queue 消息安全终止', {
        deliveryId: logDeliveryId,
        errorCode: SECURE_CONTEXT_PAYLOAD_INVALID,
      })
      ackMessage(queueMessage)
      return
    }
    try {
      sensitiveContext = await decryptMetaCapiContext({
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
    } catch (error) {
      const authenticationFailed = error instanceof MetaCapiCryptoError
        && error.code === 'META_CAPI_AUTHENTICATION_FAILED'
      const errorCode = authenticationFailed
        ? SECURE_CONTEXT_AUTHENTICATION_FAILED
        : SECURE_CONTEXT_PAYLOAD_INVALID
      if (authenticationFailed) {
        await openMetaCapiIncidentSafely(
          env,
          createMetaIncidentTrigger('secure_context_decryption_failed'),
        )
      }
      await markSecureContextFailure(env.DB, delivery, errorCode)
      await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
      console.error('[meta-capi] Queue 消息安全终止', {
        deliveryId: logDeliveryId,
        errorCode,
      })
      ackMessage(queueMessage)
      return
    }

    try {
      const result = await sendMetaCapiEvent(env, deliveryId, { userData: sensitiveContext })
      if (result.status === 'sent'
        || result.status === 'skipped'
        || result.status === 'failed'
        || result.status === 'duplicate_suppressed') {
        await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
        ackMessage(queueMessage)
        return
      }
      retryMessage(queueMessage, deliveryId, 'meta_delivery_state_conflict')
    } catch (error) {
      if (error instanceof MetaCapiDeliveryError && !error.retryable) {
        await deleteAdPlatformSecureOutbox(env.DB, 'meta', deliveryId)
        ackMessage(queueMessage)
        return
      }
      retryMessage(
        queueMessage,
        deliveryId,
        error instanceof MetaCapiDeliveryError ? error.code : 'meta_internal_error',
      )
    }
  } catch {
    retryMessage(queueMessage, logDeliveryId, 'meta_internal_error')
  }
}

async function terminateInvalidMessage(db: D1Database, delivery: MetaCapiDeliveryRow) {
  if (delivery.status === 'sent') await recordDuplicateSuppressed(db, delivery)
  else if (!isTerminalDelivery(delivery)) {
    await markSkipped(db, delivery, 'queue_message_invalid')
  }
  await deleteAdPlatformSecureOutbox(db, 'meta', delivery.id)
}

async function markSecureContextFailure(
  db: D1Database,
  delivery: MetaCapiDeliveryRow,
  errorCode: SecureContextFailureCode,
) {
  const persisted = await confirmQueueTerminalTransition(db, delivery, {
    status: 'failed',
    errorCode,
    errorMessage: '',
  })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

async function markSkipped(db: D1Database, delivery: MetaCapiDeliveryRow, reason: string) {
  const persisted = await confirmQueueTerminalTransition(db, delivery, {
    status: 'skipped',
    skipReason: reason,
  })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

async function markRetryExhausted(db: D1Database, delivery: MetaCapiDeliveryRow) {
  if (delivery.status === 'sent') {
    await recordDuplicateSuppressed(db, delivery)
    return
  }
  if (isTerminalDelivery(delivery)) return
  const persisted = await confirmQueueTerminalTransition(db, delivery, {
    status: 'failed',
    errorCode: 'retry_exhausted',
    errorMessage: 'Meta CAPI 请求失败',
  })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

async function confirmQueueTerminalTransition(
  db: D1Database,
  delivery: MetaCapiDeliveryRow,
  input: TransitionDeliveryStatusInput,
) {
  let current = delivery
  for (let attempt = 0; attempt < QUEUE_TRANSITION_MAX_ATTEMPTS; attempt += 1) {
    if (isTerminalDelivery(current)) return current
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
    const refreshed = await readMetaCapiDelivery(db, current.id)
    if (!refreshed) throw new Error('meta_delivery_state_conflict')
    current = refreshed
  }
  if (isTerminalDelivery(current)) return current
  throw new Error('meta_delivery_state_conflict')
}

function retryMessage(message: Message<AdPlatformQueueMessage>, deliveryId: string, errorCode: string) {
  const attempts = safeQueueAttempts(message)
  const delaySeconds = computeMetaRetryDelay(attempts)
  console.error('[meta-capi] Queue 安排重试', {
    deliveryId,
    errorCode,
    attempts,
    delaySeconds,
  })
  safeQueueRetry(message, delaySeconds)
}

function ackMessage(message: Message<AdPlatformQueueMessage>) {
  safeQueueAck(message)
}

function isTerminalDelivery(delivery: MetaCapiDeliveryRow) {
  if (delivery.status === 'skipped' || delivery.status === 'duplicate_suppressed') return true
  if (delivery.status !== 'failed') return false
  return !isRetryableMetaCapiErrorCode(delivery.error_code)
}
