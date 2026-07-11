import type { MetaCapiQueueMessage } from '@meigallery/shared'
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
  recordDuplicateSuppressed,
  sendMetaCapiEvent,
  transitionDeliveryStatus,
  type MetaCapiDeliveryRow,
  type TransitionDeliveryStatusInput,
} from './meta-capi'
import {
  deleteSecureMetaCapiOutbox,
  enqueueSecureMetaCapiDelivery,
  type SecureOutboxEnv,
} from './meta-capi-secure-outbox'
import { requireVerifiedMetaConnection } from './meta-connection'
import {
  createMetaIncidentTrigger,
  openMetaCapiIncidentSafely,
} from './meta-capi-circuit-breaker'

const META_RETRY_DELAYS = [60, 300, 900, 1800] as const
const META_RECOVERY_STALE_MINUTES = 5
const META_RECOVERY_BATCH_SIZE = 25
const SECURE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000
const ACTIVE_META_EVENTS = new Set(['Contact', 'CompleteRegistration'])
const QUEUE_MESSAGE_FIELDS = new Set(['schemaVersion', 'deliveryId', 'envelope'])
const ENVELOPE_FIELDS = new Set(['keyId', 'iv', 'ciphertext', 'tag', 'expiresAt'])
const QUEUE_TRANSITION_MAX_ATTEMPTS = 3
const UNKNOWN_DELIVERY_ID = 'unknown'
const INTERNAL_DELIVERY_ID_PATTERN = /^cdlv_[a-z0-9]+(?:_[a-z0-9]+)*$/
const MISSING_DATA_PROPERTY = Symbol('missing_data_property')

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
    try {
      await handleMetaCapiMessage(message, env, isDeadLetterQueue)
    } catch {
      retryMessage(message, UNKNOWN_DELIVERY_ID, 'meta_internal_error')
    }
  }
}

async function handleMetaCapiMessage(
  message: Message<MetaCapiQueueMessage>,
  env: Bindings,
  isDeadLetterQueue: boolean,
) {
  let body: unknown
  try {
    body = message.body
  } catch {
    console.error('[meta-capi] Queue 消息安全终止', {
      deliveryId: UNKNOWN_DELIVERY_ID,
      errorCode: 'legacy_message_unsupported',
    })
    ackMessage(message)
    return
  }

  const parsed = parseQueueMessage(body)
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
  message: Message<MetaCapiQueueMessage>,
  db: D1Database,
  parsed: QueueMessageParseResult,
) {
  let logDeliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = parsed.deliveryId
      ? await readMetaCapiDelivery(db, parsed.deliveryId)
      : null
    if (delivery) {
      logDeliveryId = delivery.id
      if (parsed.errorCode === 'secure_context_invalid') {
        if (delivery.status === 'sent') await recordDuplicateSuppressed(db, delivery)
        else if (!isTerminalDelivery(delivery)) await markSecureContextInvalid(db, delivery)
        await deleteSecureMetaCapiOutbox(db, delivery.id)
      } else {
        await terminateUnsupportedMessage(db, delivery)
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
  message: Message<MetaCapiQueueMessage>,
  db: D1Database,
  candidateDeliveryId: string,
) {
  let logDeliveryId = UNKNOWN_DELIVERY_ID
  try {
    const delivery = await readMetaCapiDelivery(db, candidateDeliveryId)
    if (delivery) {
      logDeliveryId = delivery.id
      await markRetryExhausted(db, delivery)
      await deleteSecureMetaCapiOutbox(db, delivery.id)
    }
    ackMessage(message)
  } catch {
    retryMessage(message, logDeliveryId, 'meta_delivery_state_conflict')
  }
}

async function consumeSecureMessage(
  queueMessage: Message<MetaCapiQueueMessage>,
  env: Bindings,
  body: MetaCapiQueueMessage,
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
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      ackMessage(queueMessage)
      return
    }
    if (isTerminalDelivery(delivery)) {
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      ackMessage(queueMessage)
      return
    }
    if (isSecureContextExpired(delivery.created_at)) {
      await markSkipped(env.DB, delivery, 'secure_context_expired')
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      ackMessage(queueMessage)
      return
    }
    if (!ACTIVE_META_EVENTS.has(delivery.event_name)) {
      await markSkipped(env.DB, delivery, 'unsupported_event')
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      ackMessage(queueMessage)
      return
    }
    try {
      const connection = await requireVerifiedMetaConnection(env)
      if (delivery.tracking_mode !== connection.trackingMode
        || delivery.meta_connection_revision !== connection.revision) {
        throw new Error('connection_unverified')
      }
    }
    catch {
      await markSkipped(env.DB, delivery, 'connection_unverified')
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      ackMessage(queueMessage)
      return
    }

    let sensitiveContext
    let keys: Awaited<ReturnType<typeof loadMetaCapiCryptoKeys>>
    try {
      if (delivery.encryption_key_id !== body.envelope.keyId) throw new Error('secure_context_invalid')
      keys = await loadMetaCapiCryptoKeys(env)
    } catch {
      await markSecureContextInvalid(env.DB, delivery)
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      console.error('[meta-capi] Queue 消息安全终止', {
        deliveryId: logDeliveryId,
        errorCode: 'secure_context_invalid',
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
      if (error instanceof MetaCapiCryptoError
        && error.code === 'META_CAPI_AUTHENTICATION_FAILED') {
        await openMetaCapiIncidentSafely(
          env,
          createMetaIncidentTrigger('secure_context_decryption_failed'),
        )
      }
      await markSecureContextInvalid(env.DB, delivery)
      await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
      console.error('[meta-capi] Queue 消息安全终止', {
        deliveryId: logDeliveryId,
        errorCode: 'secure_context_invalid',
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
        await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
        ackMessage(queueMessage)
        return
      }
      retryMessage(queueMessage, deliveryId, 'meta_delivery_state_conflict')
    } catch (error) {
      if (error instanceof MetaCapiDeliveryError && !error.retryable) {
        await deleteSecureMetaCapiOutbox(env.DB, deliveryId)
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

async function terminateUnsupportedMessage(db: D1Database, delivery: MetaCapiDeliveryRow) {
  if (delivery.status === 'sent') await recordDuplicateSuppressed(db, delivery)
  else if (!isTerminalDelivery(delivery)) {
    await markSkipped(db, delivery, 'legacy_message_unsupported')
  }
  await deleteSecureMetaCapiOutbox(db, delivery.id)
}

async function markSecureContextInvalid(db: D1Database, delivery: MetaCapiDeliveryRow) {
  const persisted = await confirmQueueTerminalTransition(db, delivery, {
    status: 'failed',
    errorCode: 'secure_context_invalid',
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

type QueueMessageParseResult = {
  deliveryId: string
  errorCode: 'legacy_message_unsupported' | 'secure_context_invalid'
  message?: MetaCapiQueueMessage
}

function parseQueueMessage(value: unknown): QueueMessageParseResult {
  try {
    if (!isPlainRecord(value)) return { deliveryId: '', errorCode: 'legacy_message_unsupported' }
    const deliveryId = safeDeliveryId(readOwnDataProperty(value, 'deliveryId'))
    const schemaVersion = readOwnDataProperty(value, 'schemaVersion')
    if (schemaVersion !== 2 || !deliveryId) {
      return { deliveryId, errorCode: 'legacy_message_unsupported' }
    }
    const envelope = readOwnDataProperty(value, 'envelope')
    if (!hasExactFields(value, QUEUE_MESSAGE_FIELDS) || !isPlainRecord(envelope)) {
      return { deliveryId, errorCode: 'secure_context_invalid' }
    }
    if (!hasExactFields(envelope, ENVELOPE_FIELDS)) {
      return { deliveryId, errorCode: 'secure_context_invalid' }
    }

    const keyId = readOwnDataProperty(envelope, 'keyId')
    const iv = readOwnDataProperty(envelope, 'iv')
    const ciphertext = readOwnDataProperty(envelope, 'ciphertext')
    const tag = readOwnDataProperty(envelope, 'tag')
    const expiresAt = readOwnDataProperty(envelope, 'expiresAt')
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
  } catch {
    return { deliveryId: '', errorCode: 'legacy_message_unsupported' }
  }
}

function retryMessage(message: Message<MetaCapiQueueMessage>, deliveryId: string, errorCode: string) {
  let attempts = 1
  try {
    if (typeof message.attempts === 'number') attempts = message.attempts
  } catch {
    // 毒消息的访问器不能中断同批次后续消息。
  }
  const delaySeconds = computeMetaRetryDelay(attempts)
  console.error('[meta-capi] Queue 安排重试', {
    deliveryId,
    errorCode,
    attempts,
    delaySeconds,
  })
  try {
    message.retry({ delaySeconds })
  } catch {
    // Queue runtime 无法操作该消息时继续处理同批次其余消息。
  }
}

function ackMessage(message: Message<MetaCapiQueueMessage>) {
  try {
    message.ack()
  } catch {
    // Queue runtime 无法操作该消息时继续处理同批次其余消息。
  }
}

function isTerminalDelivery(delivery: MetaCapiDeliveryRow) {
  if (delivery.status === 'skipped' || delivery.status === 'duplicate_suppressed') return true
  if (delivery.status !== 'failed') return false
  return !isRetryableMetaCapiErrorCode(delivery.error_code)
}

function isSecureContextExpired(createdAt: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)
    ? `${createdAt.replace(' ', 'T')}Z`
    : createdAt
  const timestamp = Date.parse(normalized)
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= SECURE_CONTEXT_TTL_MS
}

function safeDeliveryId(value: unknown) {
  return typeof value === 'string' && value.length <= 96 && INTERNAL_DELIVERY_ID_PATTERN.test(value)
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

function readOwnDataProperty(value: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : MISSING_DATA_PROPERTY
}
