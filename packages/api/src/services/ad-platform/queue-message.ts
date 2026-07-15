// @ts-nocheck
// Task 14 删除前保留的历史消息校验；新 Queue 只使用 schemaVersion 1 最小消息。
import type { AdPlatformQueueMessage } from '@meigallery/shared'

const QUEUE_MESSAGE_FIELDS = new Set(['schemaVersion', 'deliveryId', 'envelope'])
const ENVELOPE_FIELDS = new Set(['keyId', 'iv', 'ciphertext', 'tag', 'expiresAt'])
const INTERNAL_DELIVERY_ID_PATTERN = /^cdlv_[a-z0-9]+(?:_[a-z0-9]+)*$/
const MISSING_DATA_PROPERTY = Symbol('missing_data_property')

export type AdPlatformQueueMessageParseResult = {
  deliveryId: string
  errorCode: 'queue_message_invalid' | 'secure_context_payload_invalid'
  message?: AdPlatformQueueMessage
}

export function parseAdPlatformQueueMessage(value: unknown): AdPlatformQueueMessageParseResult {
  try {
    if (!isPlainRecord(value)) return invalidMessage()
    const deliveryId = safeDeliveryId(readOwnDataProperty(value, 'deliveryId'))
    const schemaVersion = readOwnDataProperty(value, 'schemaVersion')
    if (schemaVersion !== 2 || !deliveryId) return invalidMessage(deliveryId)
    const envelope = readOwnDataProperty(value, 'envelope')
    if (!hasExactFields(value, QUEUE_MESSAGE_FIELDS) || !isPlainRecord(envelope)) {
      return invalidPayload(deliveryId)
    }
    if (!hasExactFields(envelope, ENVELOPE_FIELDS)) return invalidPayload(deliveryId)

    const keyId = readOwnDataProperty(envelope, 'keyId')
    const iv = readOwnDataProperty(envelope, 'iv')
    const ciphertext = readOwnDataProperty(envelope, 'ciphertext')
    const tag = readOwnDataProperty(envelope, 'tag')
    const expiresAt = readOwnDataProperty(envelope, 'expiresAt')
    if ([keyId, iv, ciphertext, tag, expiresAt].some(value => typeof value !== 'string')) {
      return invalidPayload(deliveryId)
    }
    return {
      deliveryId,
      errorCode: 'secure_context_payload_invalid',
      message: {
        schemaVersion: 2,
        deliveryId,
        envelope: {
          keyId: keyId as string,
          iv: iv as string,
          ciphertext: ciphertext as string,
          tag: tag as string,
          expiresAt: expiresAt as string,
        },
      },
    }
  }
  catch {
    return invalidMessage()
  }
}

export function isSecureContextExpired(createdAt: string, ttlMs: number) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)
    ? `${createdAt.replace(' ', 'T')}Z`
    : createdAt
  const timestamp = Date.parse(normalized)
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= ttlMs
}

export function safeQueueAck(message: Message<AdPlatformQueueMessage>) {
  try {
    message.ack()
  }
  catch {
    // 单条消息的运行时错误不能中断同批次后续消息。
  }
}

export function safeQueueAttempts(message: Message<AdPlatformQueueMessage>) {
  try {
    return typeof message.attempts === 'number' && Number.isFinite(message.attempts)
      ? message.attempts
      : 1
  }
  catch {
    return 1
  }
}

export function safeQueueRetry(message: Message<AdPlatformQueueMessage>, delaySeconds: number) {
  try {
    message.retry({ delaySeconds })
  }
  catch {
    // 单条消息的运行时错误不能中断同批次后续消息。
  }
}

function invalidMessage(deliveryId = ''): AdPlatformQueueMessageParseResult {
  return { deliveryId, errorCode: 'queue_message_invalid' }
}

function invalidPayload(deliveryId: string): AdPlatformQueueMessageParseResult {
  return { deliveryId, errorCode: 'secure_context_payload_invalid' }
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
