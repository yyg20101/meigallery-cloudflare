import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { decryptMetaCapiContext, loadMetaCapiCryptoKeys } from '../utils/meta-capi-crypto'
import {
  MetaCapiDeliveryError,
  confirmDeliveryTransition,
  readMetaCapiDelivery,
  recordDuplicateSuppressed,
  sendMetaCapiEvent,
  type MetaCapiDeliveryRow,
} from './meta-capi'
import {
  deleteSecureMetaCapiOutbox,
  enqueueSecureMetaCapiDelivery,
  type SecureOutboxEnv,
} from './meta-capi-secure-outbox'

const META_RETRY_DELAYS = [60, 300, 900, 1800] as const
const META_RECOVERY_STALE_MINUTES = 5
const META_RECOVERY_BATCH_SIZE = 25
const SECURE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000
const ACTIVE_META_EVENTS = new Set(['Contact', 'CompleteRegistration'])
const QUEUE_MESSAGE_FIELDS = new Set(['schemaVersion', 'deliveryId', 'envelope'])
const ENVELOPE_FIELDS = new Set(['keyId', 'iv', 'ciphertext', 'tag', 'expiresAt'])

type MetaCapiQueueEnv = SecureOutboxEnv

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
    JOIN meta_capi_secure_outbox o ON o.delivery_id = d.id AND o.schema_version = 2
    WHERE d.channel = 'meta_capi'
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
    const result = await enqueueSecureMetaCapiDelivery(env, delivery.id, { requireStale: true })
    if (result === 'enqueued') enqueued += 1
    else if (result === 'failed') failed += 1
  }
  return { scanned: stale.results.length, enqueued, failed }
}

export async function handleMetaCapiBatch(
  batch: MessageBatch<MetaCapiQueueMessage>,
  env: Bindings,
) {
  const isDeadLetterQueue = batch.queue.endsWith('-dlq')
  for (const message of batch.messages) {
    const parsed = parseQueueMessage(message.body)
    if (!parsed.message) {
      try {
        if (parsed.deliveryId) {
          if (parsed.errorCode === 'secure_context_invalid') {
            const delivery = await readMetaCapiDelivery(env.DB, parsed.deliveryId)
            if (delivery?.status === 'sent') await recordDuplicateSuppressed(env.DB, delivery)
            else if (delivery && !isTerminalDelivery(delivery)) await markSecureContextInvalid(env.DB, delivery)
            await deleteSecureMetaCapiOutbox(env.DB, parsed.deliveryId)
          } else {
            await terminateUnsupportedMessage(env.DB, parsed.deliveryId)
          }
          console.error('[meta-capi] Queue 消息安全终止', {
            deliveryId: parsed.deliveryId,
            errorCode: parsed.errorCode,
          })
        }
        message.ack()
      } catch {
        retryMessage(message, parsed.deliveryId || 'unknown', 'meta_delivery_state_conflict')
      }
      continue
    }

    if (isDeadLetterQueue) {
      try {
        await markRetryExhausted(env.DB, parsed.message.deliveryId)
        await deleteSecureMetaCapiOutbox(env.DB, parsed.message.deliveryId)
        message.ack()
      } catch {
        retryMessage(message, parsed.message.deliveryId, 'meta_delivery_state_conflict')
      }
      continue
    }

    await consumeSecureMessage(message, env, parsed.message)
  }
}

async function consumeSecureMessage(
  queueMessage: Message<MetaCapiQueueMessage>,
  env: Bindings,
  body: MetaCapiQueueMessage,
) {
  const deliveryId = body.deliveryId
  try {
    const delivery = await readMetaCapiDelivery(env.DB, deliveryId)
    if (!delivery) {
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      queueMessage.ack()
      return
    }

    if (delivery.status === 'sent') {
      await recordDuplicateSuppressed(env.DB, delivery)
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      queueMessage.ack()
      return
    }
    if (isTerminalDelivery(delivery)) {
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      queueMessage.ack()
      return
    }
    if (isSecureContextExpired(delivery.created_at)) {
      await markSkipped(env.DB, delivery, 'secure_context_expired')
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      queueMessage.ack()
      return
    }
    if (!ACTIVE_META_EVENTS.has(delivery.event_name)) {
      await markSkipped(env.DB, delivery, 'unsupported_event')
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      queueMessage.ack()
      return
    }

    let sensitiveContext
    try {
      if (delivery.encryption_key_id !== body.envelope.keyId) throw new Error('secure_context_invalid')
      const keys = await loadMetaCapiCryptoKeys(env)
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
    } catch {
      await markSecureContextInvalid(env.DB, delivery)
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      console.error('[meta-capi] Queue 消息安全终止', {
        deliveryId,
        errorCode: 'secure_context_invalid',
      })
      queueMessage.ack()
      return
    }

    try {
      const result = await sendMetaCapiEvent(env, deliveryId, { userData: sensitiveContext })
      if (result.status === 'sent'
        || result.status === 'skipped'
        || result.status === 'failed'
        || result.status === 'duplicate_suppressed') {
        await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
        queueMessage.ack()
        return
      }
      retryMessage(queueMessage, deliveryId, 'meta_delivery_state_conflict')
    } catch (error) {
      if (error instanceof MetaCapiDeliveryError && !error.retryable) {
        await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
        queueMessage.ack()
        return
      }
      retryMessage(
        queueMessage,
        deliveryId,
        error instanceof MetaCapiDeliveryError ? error.code : 'meta_internal_error',
      )
    }
  } catch {
    retryMessage(queueMessage, deliveryId, 'meta_internal_error')
  }
}

async function terminateUnsupportedMessage(db: D1Database, deliveryId: string) {
  const delivery = await readMetaCapiDelivery(db, deliveryId)
  if (delivery?.status === 'sent') await recordDuplicateSuppressed(db, delivery)
  else if (delivery && !isTerminalDelivery(delivery)) {
    await markSkipped(db, delivery, 'legacy_message_unsupported')
  }
  await deleteSecureMetaCapiOutbox(db, deliveryId)
}

async function markSecureContextInvalid(db: D1Database, delivery: MetaCapiDeliveryRow) {
  const persisted = await confirmDeliveryTransition(db, delivery, {
    status: 'failed',
    errorCode: 'secure_context_invalid',
    errorMessage: '',
  }, { allowAnyNonSent: true })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

async function markSkipped(db: D1Database, delivery: MetaCapiDeliveryRow, reason: string) {
  const persisted = await confirmDeliveryTransition(db, delivery, {
    status: 'skipped',
    skipReason: reason,
  }, { allowAnyNonSent: true })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

async function markRetryExhausted(db: D1Database, deliveryId: string) {
  const delivery = await readMetaCapiDelivery(db, deliveryId)
  if (!delivery) return
  if (delivery.status === 'sent') {
    await recordDuplicateSuppressed(db, delivery)
    return
  }
  if (isTerminalDelivery(delivery)) return
  const persisted = await confirmDeliveryTransition(db, delivery, {
    status: 'failed',
    errorCode: 'retry_exhausted',
    errorMessage: 'Meta CAPI 请求失败',
  }, { allowAnyNonSent: true })
  if (persisted.status === 'sent') await recordDuplicateSuppressed(db, persisted)
}

function parseQueueMessage(value: unknown): {
  deliveryId: string
  errorCode: 'legacy_message_unsupported' | 'secure_context_invalid'
  message?: MetaCapiQueueMessage
} {
  if (!isPlainRecord(value)) return { deliveryId: '', errorCode: 'legacy_message_unsupported' }
  const deliveryId = safeDeliveryId(value.deliveryId)
  if (value.schemaVersion !== 2 || !deliveryId) return { deliveryId, errorCode: 'legacy_message_unsupported' }
  if (!hasExactFields(value, QUEUE_MESSAGE_FIELDS) || !isPlainRecord(value.envelope)) {
    return { deliveryId, errorCode: 'secure_context_invalid' }
  }
  if (!hasExactFields(value.envelope, ENVELOPE_FIELDS)) {
    return { deliveryId, errorCode: 'secure_context_invalid' }
  }

  const { keyId, iv, ciphertext, tag, expiresAt } = value.envelope
  if (
    typeof keyId !== 'string'
    || typeof iv !== 'string'
    || typeof ciphertext !== 'string'
    || typeof tag !== 'string'
    || typeof expiresAt !== 'string'
  ) return { deliveryId, errorCode: 'secure_context_invalid' }
  return {
    deliveryId,
    errorCode: 'secure_context_invalid',
    message: {
      schemaVersion: 2,
      deliveryId,
      envelope: { keyId, iv, ciphertext, tag, expiresAt },
    },
  }
}

function retryMessage(message: Message<MetaCapiQueueMessage>, deliveryId: string, errorCode: string) {
  const delaySeconds = computeMetaRetryDelay(message.attempts)
  console.error('[meta-capi] Queue 安排重试', {
    deliveryId,
    errorCode,
    attempts: message.attempts,
    delaySeconds,
  })
  message.retry({ delaySeconds })
}

function isTerminalDelivery(delivery: MetaCapiDeliveryRow) {
  if (delivery.status === 'skipped' || delivery.status === 'duplicate_suppressed') return true
  if (delivery.status !== 'failed') return false
  return !(
    delivery.error_code === 'meta_timeout'
    || delivery.error_code === 'meta_network_error'
    || delivery.error_code === 'meta_delivery_state_conflict'
    || delivery.error_code === 'meta_http_429'
    || /^meta_http_5\d\d$/.test(delivery.error_code)
  )
}

function isSecureContextExpired(createdAt: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)
    ? `${createdAt.replace(' ', 'T')}Z`
    : createdAt
  const timestamp = Date.parse(normalized)
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= SECURE_CONTEXT_TTL_MS
}

function safeDeliveryId(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/\p{Cc}/u.test(value)
    ? value
    : ''
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactFields(value: object, expected: Set<string>) {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every(key => typeof key === 'string' && expected.has(key))
}
