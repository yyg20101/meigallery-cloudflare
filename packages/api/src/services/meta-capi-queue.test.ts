import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdPlatformQueueMessage, ConversionDeliveryStatus } from '@meigallery/shared'
import type { Bindings } from '../index'
import {
  encryptMetaCapiContext,
  loadMetaCapiCryptoKeys,
  type MetaCapiSensitiveContext,
} from '../utils/meta-capi-crypto'
import { enqueueAdPlatformSecureDelivery } from './ad-platform/secure-outbox'
import { computeMetaRetryDelay, handleMetaCapiBatch, recoverPendingMetaCapiDeliveries } from './meta-capi-queue'

const CURRENT_KEY = Buffer.alloc(32, 7).toString('base64')
const PREVIOUS_KEY = Buffer.alloc(32, 9).toString('base64')
const EXPIRES_AT = '2026-07-12T10:00:00.000Z'
const RELEASE_COMMIT = 'a'.repeat(40)
const TOKEN_FINGERPRINT = 'c144f7bade446c762abc027132d8c31d80270f7ba5c41cd4ff9437655f939512'
const CONNECTION_REVISION = '1'.repeat(32)

function enqueueMetaSecureDelivery(env: Bindings, deliveryId: string) {
  return enqueueAdPlatformSecureDelivery(env, {
    provider: 'meta',
    queue: env.META_CAPI_QUEUE,
    deliveryId,
    queueLabel: 'Meta CAPI',
  })
}

type Call = { sql: string; params: unknown[] }
type Delivery = {
  id: string
  conversion_action_id: string
  provider: 'meta'
  transport: string
  external_event_id: string
  event_name: string
  status: ConversionDeliveryStatus
  skip_reason: string
  error_code: string
  error_message: string
  attempt_count: number
  tracking_mode: 'disabled' | 'test' | 'production'
  connection_revision: string | null
  queue_enqueued_at: string | null
  queue_attempt_count: number
  duplicate_suppressed_at: string | null
  encryption_key_id: string
  created_at: string
  occurred_at: string
  date: string
  path: string
  metadata: string
  updated_at: string
  delivery_lease_token: string
  delivery_lease_expires_at: string | null
}

type Outbox = AdPlatformQueueMessage['envelope'] & {
  delivery_id: string
  schema_version: 2
  expires_at: string
}

function createQueueDb(options: {
  status?: ConversionDeliveryStatus
  eventName?: string
  createdAt?: string
  cleanupBatchFailures?: number
  beforeFirstTransition?: (delivery: Delivery, daily: Map<string, number>) => void
  connectionVerified?: boolean
  connectionRevision?: string
  deliveryRevision?: string | null
} = {}) {
  const delivery: Delivery = {
    id: 'cdlv_1',
    conversion_action_id: 'conv_1',
    provider: 'meta',
    transport: 'server',
    external_event_id: 'event_1',
    event_name: options.eventName ?? 'Contact',
    status: options.status ?? 'pending',
    skip_reason: '',
    error_code: '',
    error_message: '',
    attempt_count: 0,
    tracking_mode: 'production',
    connection_revision: options.deliveryRevision === undefined ? CONNECTION_REVISION : options.deliveryRevision,
    queue_enqueued_at: null,
    queue_attempt_count: 0,
    duplicate_suppressed_at: null,
    encryption_key_id: '',
    created_at: options.createdAt ?? '2026-07-11 10:00:00',
    occurred_at: '2026-07-09T10:00:00.000Z',
    date: '2026-07-11',
    path: '/',
    metadata: '{}',
    updated_at: '2026-07-11 10:00:00',
    delivery_lease_token: '',
    delivery_lease_expires_at: null,
  }
  const calls: Call[] = []
  const daily = new Map<string, number>([[delivery.status, 1]])
  let outbox: Outbox | null = null
  let lastChanges = 1
  let cleanupBatchFailures = options.cleanupBatchFailures ?? 0
  let transitionHookCalled = false

  const db = {
    delivery,
    calls,
    daily,
    get outbox() { return outbox },
    set outbox(value: Outbox | null) { outbox = value },
    prepare(sql: string) {
      const call: Call = { sql, params: [] }
      return {
        __call: call,
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM ad_platform_secure_outbox')) {
            if (!outbox || call.params[0] !== delivery.id) return null
            return {
              delivery_id: outbox.delivery_id,
              provider: 'meta',
              schema_version: outbox.schema_version,
              key_id: outbox.keyId,
              iv: outbox.iv,
              ciphertext: outbox.ciphertext,
              tag: outbox.tag,
              expires_at: outbox.expires_at,
              status: delivery.status,
              skip_reason: delivery.skip_reason,
              error_code: delivery.error_code,
              queue_enqueued_at: delivery.queue_enqueued_at,
              queue_attempt_count: delivery.queue_attempt_count,
              updated_at: delivery.updated_at,
              date: delivery.date,
              event_name: delivery.event_name,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_deliveries')) {
            return call.params[0] === delivery.id ? ({ ...delivery } as T) : null
          }
          if (sql.includes('FROM ad_platform_connections')) return {
            provider: 'meta', enabled: 1, mode: delivery.tracking_mode,
            browser_enabled: 1, server_enabled: 1, destination_id: '1234567890',
            debug_enabled: 0, rollout_percentage: 100,
            credential_secret_name: 'META_CAPI_ACCESS_TOKEN', revision: CONNECTION_REVISION,
          } as T
          if (sql.includes('FROM meta_connection_verifications')) {
            if (options.connectionVerified === false) return null
            return {
              environment: 'dev',
              pixel_id: '1234567890',
              token_fingerprint: TOKEN_FINGERPRINT,
              graph_api_version: 'v25.0',
              verified_event_name: 'Contact',
              verified_commit: RELEASE_COMMIT,
              dataset_quality_status: 'not_checked',
              verified_at: '2026-07-11T00:00:00.000Z',
              verified_by_user_id: 1,
              invalidated_at: null,
              invalidation_reason: '',
              revision: options.connectionRevision ?? CONNECTION_REVISION,
            } as T
          }
          return null
        },
        async all<T>() {
          calls.push(call)
          if (sql.includes('analytics_conversion_deliveries') && sql.includes('queue_enqueued_at IS NULL')) {
            const rows = outbox && delivery.status === 'pending' && !delivery.queue_enqueued_at
              && ['Contact', 'CompleteRegistration'].includes(delivery.event_name)
              ? [{ id: delivery.id }]
              : []
            return { results: rows as T[] }
          }
          return { results: [] as T[] }
        },
        async run() {
          calls.push(call)
          return apply(call)
        },
      }
    },
    async batch(statements: Array<{ __call: Call }>) {
      if (statements.some(statement => statement.__call.sql.includes('queue_enqueued_at = datetime')) && cleanupBatchFailures > 0) {
        cleanupBatchFailures -= 1
        throw new Error('模拟 Queue 成功后 D1 batch 失败')
      }
      const results = []
      for (const statement of statements) {
        calls.push(statement.__call)
        results.push(apply(statement.__call))
      }
      return results
    },
  }

  function apply(call: Call) {
    const { sql, params } = call
    if (sql.includes('delivery_lease_expires_at = datetime')) {
      if (delivery.delivery_lease_token || !['pending', 'failed'].includes(delivery.status)) return result(0)
      delivery.delivery_lease_token = String(params[0])
      delivery.delivery_lease_expires_at = '2026-07-11 10:03:00'
      return result(1)
    }
    if (sql.includes("SET delivery_lease_token = ''")) {
      const matches = delivery.delivery_lease_token === String(params[2])
      if (matches) {
        delivery.delivery_lease_token = ''
        delivery.delivery_lease_expires_at = null
      }
      return result(matches ? 1 : 0)
    }
    if (sql.includes('queue_attempt_count = queue_attempt_count + 1')) {
      if (!outbox || delivery.status !== 'pending' || delivery.queue_enqueued_at) return result(0)
      if (delivery.queue_attempt_count !== Number(params[2])) return result(0)
      delivery.queue_attempt_count += 1
      delivery.updated_at = '2026-07-11 10:01:00'
      return result(1)
    }
    if (sql.includes('queue_enqueued_at = datetime')) {
      delivery.queue_enqueued_at = '2026-07-11 10:01:01'
      delivery.error_code = ''
      return result(1)
    }
    if (sql.includes("error_code = 'queue_send_failed'")) {
      delivery.error_code = 'queue_send_failed'
      return result(1)
    }
    if (sql.includes("error_code = 'missing_queue'")) {
      delivery.error_code = 'missing_queue'
      return result(1)
    }
    if (sql.includes('DELETE FROM ad_platform_secure_outbox')) {
      if (String(params[0]) === delivery.id) outbox = null
      return result(1)
    }
    if (sql.includes('duplicate_suppressed_at')) {
      const changed = delivery.status === 'sent' && !delivery.duplicate_suppressed_at
      if (changed) delivery.duplicate_suppressed_at = '2026-07-11 10:02:00'
      return result(changed ? 1 : 0)
    }
    if (sql.includes('UPDATE analytics_conversion_deliveries')) {
      const changesStatus = /SET\s+status\s*=\s*\?/m.test(sql)
      if (!transitionHookCalled) {
        transitionHookCalled = true
        options.beforeFirstTransition?.(delivery, daily)
      }
      const expectedStatus = String(params[changesStatus ? 6 : 4])
      if (delivery.status !== expectedStatus || delivery.status === 'sent') return result(0)
      if (sql.includes('AND delivery_lease_token = ?')
        && delivery.delivery_lease_token !== String(params.at(-1))) return result(0)
      if (sql.includes('AND skip_reason = ?')) {
        const expectedSkipReason = String(params[changesStatus ? 7 : 5] ?? '')
        if (delivery.skip_reason !== expectedSkipReason) return result(0)
      }
      if (sql.includes('AND error_code = ?')) {
        const expectedErrorCode = String(params[changesStatus ? 8 : 6] ?? '')
        if (delivery.error_code !== expectedErrorCode) return result(0)
      }
      const previous = delivery.status
      if (changesStatus) delivery.status = String(params[0]) as ConversionDeliveryStatus
      const offset = changesStatus ? 1 : 0
      delivery.skip_reason = String(params[offset] ?? '')
      delivery.error_code = String(params[offset + 1] ?? '')
      delivery.error_message = String(params[offset + 2] ?? '')
      delivery.attempt_count += 1
      if (changesStatus) {
        daily.set(previous, Math.max(0, (daily.get(previous) ?? 0) - 1))
        daily.set(delivery.status, (daily.get(delivery.status) ?? 0) + 1)
      }
      return result(1)
    }
    if (sql.includes('analytics_conversion_delivery_daily') && sql.includes('WHERE changes() = 1') && lastChanges !== 1) {
      return result(0)
    }
    return result(1)
  }

  function result(changes: number) {
    lastChanges = changes
    return { meta: { changes, rows_written: changes, rows_read: 0, duration: 1 } }
  }

  return db
}

async function encryptedMessage(
  db: ReturnType<typeof createQueueDb>,
  options: {
    encryptionKey?: string
    aadEventId?: string
    context?: MetaCapiSensitiveContext
  } = {},
) {
  const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: options.encryptionKey ?? CURRENT_KEY })
  const sealed = await encryptMetaCapiContext({
    keys,
    aad: {
      deliveryId: db.delivery.id,
      externalEventId: options.aadEventId ?? db.delivery.external_event_id,
      eventName: db.delivery.event_name as 'Contact' | 'CompleteRegistration',
    },
    value: options.context ?? {
      fbp: 'fb.1.1700000000000.123456789',
      fbc: 'fb.1.1700000000000.CLICK_abc-123',
      clientIpAddress: '203.0.113.24',
      clientUserAgent: 'MeiGallery Test Browser/1.0',
    },
  })
  const envelope = {
    keyId: sealed.keyId,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    tag: sealed.tag,
    expiresAt: EXPIRES_AT,
  }
  db.delivery.encryption_key_id = sealed.keyId
  db.outbox = {
    delivery_id: db.delivery.id,
    schema_version: 2,
    expires_at: EXPIRES_AT,
    ...envelope,
  }
  return { schemaVersion: 2, deliveryId: db.delivery.id, envelope } satisfies AdPlatformQueueMessage
}

async function encryptedRawMessage(
  db: ReturnType<typeof createQueueDb>,
  plaintext: Uint8Array,
) {
  const keys = await loadMetaCapiCryptoKeys({ META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY })
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    deliveryId: db.delivery.id,
    externalEventId: db.delivery.external_event_id,
    eventName: db.delivery.event_name,
  }))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData,
    tagLength: 128,
  }, keys.current.key, plaintext))
  const envelope = {
    keyId: keys.current.id,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(sealed.slice(0, -16)),
    tag: bytesToBase64Url(sealed.slice(-16)),
    expiresAt: EXPIRES_AT,
  }
  db.delivery.encryption_key_id = keys.current.id
  db.outbox = {
    delivery_id: db.delivery.id,
    schema_version: 2,
    expires_at: EXPIRES_AT,
    ...envelope,
  }
  return { schemaVersion: 2, deliveryId: db.delivery.id, envelope } satisfies AdPlatformQueueMessage
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function queueMessage(body: AdPlatformQueueMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() }
}

function batch(message: ReturnType<typeof queueMessage>, queue = 'meigallery-meta-capi') {
  return messageBatch([message], queue)
}

function messageBatch(messages: Array<ReturnType<typeof queueMessage>>, queue = 'meigallery-meta-capi') {
  return { queue, messages } as unknown as MessageBatch<AdPlatformQueueMessage>
}

function env(db: ReturnType<typeof createQueueDb>, overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'dev',
    SITE_URL: 'https://616618.xyz',
    META_CAPI_ACCESS_TOKEN: 'token_private',
    META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
    RELEASE_COMMIT,
    DB: db,
    ...overrides,
  } as unknown as Bindings
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Meta CAPI Queue V2', () => {
  it('消费前连接失效时安全终止、清理密文且不重试到新 Dataset', async () => {
    const db = createQueueDb({ connectionVerified: false })
    const body = await encryptedMessage(db)
    const message = queueMessage(body)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.delivery).toMatchObject({
      status: 'skipped',
      skip_reason: 'connection_unverified',
    })
    expect(db.outbox).toBeNull()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it.each(['pending', 'failed'] as const)('%s delivery 由 A 连接创建、B 连接重新验证后不解密、不 fetch 并安全 ack', async status => {
    const db = createQueueDb({
      status,
      deliveryRevision: 'a'.repeat(32),
      connectionRevision: 'b'.repeat(32),
    })
    if (status === 'failed') db.delivery.error_code = 'meta_http_500'
    const body = await encryptedMessage(db)
    const message = queueMessage(body)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db, { META_CAPI_DATA_KEY_CURRENT: undefined }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.delivery).toMatchObject({
      status: 'skipped',
      skip_reason: 'connection_unverified',
      connection_revision: 'a'.repeat(32),
    })
    expect(db.outbox).toBeNull()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('current 与 previous key 均可解密，并只把内存上下文发送给 Meta', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))

    for (const key of [CURRENT_KEY, PREVIOUS_KEY]) {
      const db = createQueueDb()
      const body = await encryptedMessage(db, { encryptionKey: key })
      const message = queueMessage(body)
      const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))
      vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFn)

      await handleMetaCapiBatch(batch(message), env(db, {
        META_CAPI_DATA_KEY_CURRENT: CURRENT_KEY,
        META_CAPI_DATA_KEY_PREVIOUS: key === PREVIOUS_KEY ? PREVIOUS_KEY : undefined,
      }))

      const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
      expect(payload.data[0].user_data).toEqual({
        fbp: 'fb.1.1700000000000.123456789',
        fbc: 'fb.1.1700000000000.CLICK_abc-123',
        client_ip_address: '203.0.113.24',
        client_user_agent: 'MeiGallery Test Browser/1.0',
      })
      expect(message.ack).toHaveBeenCalledOnce()
      expect(message.retry).not.toHaveBeenCalled()
      expect(db.delivery.status).toBe('sent')
      expect(db.outbox).toBeNull()
      vi.restoreAllMocks()
    }
  })

  it.each([
    ['unknown_key', 'secure_context_payload_invalid'],
    ['key_id_mismatch', 'secure_context_payload_invalid'],
    ['aad_mismatch', 'secure_context_authentication_failed'],
    ['auth_failed', 'secure_context_authentication_failed'],
  ] as const)('%s 按失败阶段持久互斥 error code 且日志不泄密', async (failure, errorCode) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb()
    const body = await encryptedMessage(db, { aadEventId: failure === 'aad_mismatch' ? 'wrong_event' : undefined })
    if (failure === 'unknown_key') {
      body.envelope.keyId = 'f'.repeat(16)
      db.delivery.encryption_key_id = body.envelope.keyId
    }
    if (failure === 'key_id_mismatch') db.delivery.encryption_key_id = 'f'.repeat(16)
    if (failure === 'auth_failed') {
      const replacement = body.envelope.tag[0] === 'A' ? 'B' : 'A'
      body.envelope.tag = `${replacement}${body.envelope.tag.slice(1)}`
    }
    const message = queueMessage(body)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db))

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.delivery).toMatchObject({ status: 'failed', error_code: errorCode })
    expect(db.outbox).toBeNull()
    expect(consoleError).toHaveBeenCalledWith('[meta-capi] Queue 消息安全终止', {
      deliveryId: db.delivery.id,
      errorCode,
    })
    const serializedLogs = JSON.stringify(consoleError.mock.calls)
    expect(serializedLogs).not.toContain(body.envelope.ciphertext)
    expect(serializedLogs).not.toContain('203.0.113.24')
    expect(serializedLogs).not.toContain('token_private')
  })

  it('schema V2 的畸形 envelope 归入 secure_context_payload_invalid 而不是旧消息兼容', async () => {
    const db = createQueueDb()
    const body = await encryptedMessage(db)
    const malformed = {
      ...body,
      envelope: { ...body.envelope, tag: 42 },
    } as unknown as AdPlatformQueueMessage
    const message = queueMessage(malformed)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await handleMetaCapiBatch(batch(message), env(db))

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(db.delivery).toMatchObject({ status: 'failed', error_code: 'secure_context_payload_invalid' })
    expect(consoleError).toHaveBeenCalledWith('[meta-capi] Queue 消息安全终止', {
      deliveryId: db.delivery.id,
      errorCode: 'secure_context_payload_invalid',
    })
  })

  it('secure_context_payload_invalid CAS 冲突刷新为 skipped 后保留终态及日报', async () => {
    const db = createQueueDb({
      beforeFirstTransition: (delivery, daily) => {
        delivery.status = 'skipped'
        delivery.skip_reason = 'missing_secret'
        daily.set('pending', 0)
        daily.set('skipped', 1)
      },
    })
    const body = await encryptedMessage(db)
    const message = queueMessage({
      ...body,
      envelope: { ...body.envelope, tag: 42 },
    } as unknown as AdPlatformQueueMessage)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await handleMetaCapiBatch(batch(message), env(db))

    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'missing_secret', error_code: '' })
    expect(db.daily.get('pending')).toBe(0)
    expect(db.daily.get('skipped')).toBe(1)
    expect(db.daily.get('failed') ?? 0).toBe(0)
    expect(db.outbox).toBeNull()
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('delivery 服务端 created_at 超过 24 小时时拒绝 Queue 密文，不信任 occurredAt 或 envelope expiresAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:01.000Z'))
    const db = createQueueDb({ createdAt: '2026-07-10 12:00:00' })
    db.delivery.occurred_at = '2026-07-11T11:59:59.000Z'
    const body = await encryptedMessage(db)
    body.envelope.expiresAt = '2099-01-01T00:00:00.000Z'
    const message = queueMessage(body)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'secure_context_expired' })
    expect(db.outbox).toBeNull()
  })

  it('secure_context_expired CAS 冲突刷新为 duplicate_suppressed 后不覆盖或搬移日报', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:01.000Z'))
    const db = createQueueDb({
      createdAt: '2026-07-10 12:00:00',
      beforeFirstTransition: (delivery, daily) => {
        delivery.status = 'duplicate_suppressed'
        delivery.skip_reason = 'already_sent'
        daily.set('pending', 0)
        daily.set('duplicate_suppressed', 1)
      },
    })
    const body = await encryptedMessage(db)
    const message = queueMessage(body)

    await handleMetaCapiBatch(batch(message), env(db))

    expect(db.delivery).toMatchObject({
      status: 'duplicate_suppressed',
      skip_reason: 'already_sent',
      error_code: '',
    })
    expect(db.daily.get('pending')).toBe(0)
    expect(db.daily.get('duplicate_suppressed')).toBe(1)
    expect(db.daily.get('skipped') ?? 0).toBe(0)
    expect(db.outbox).toBeNull()
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('sent 终态在密钥加载、解密和 fetch 前短路，并清理残留 outbox', async () => {
    const db = createQueueDb({ status: 'sent' })
    const body = await encryptedMessage(db)
    body.envelope = {
      keyId: 'not-a-key',
      iv: 'invalid',
      ciphertext: 'invalid',
      tag: 'invalid',
      expiresAt: 'invalid',
    }
    const message = queueMessage(body)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db, {
      META_CAPI_DATA_KEY_CURRENT: undefined,
      META_CAPI_DATA_KEY_PREVIOUS: undefined,
    }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(db.delivery.status).toBe('sent')
    expect(db.outbox).toBeNull()
  })

  it.each([1, 7])('非 V2 schema %s 不读取额外字段，安全 ack 并终止可识别 delivery', async schemaVersion => {
    const db = createQueueDb()
    const body = {
      schemaVersion,
      deliveryId: db.delivery.id,
      get userData(): never {
        throw new Error('consumer 读取了非法消息额外字段')
      },
    }
    db.outbox = {
      delivery_id: db.delivery.id,
      schema_version: 2,
      keyId: '0123456789abcdef',
      iv: 'iv',
      ciphertext: 'ciphertext',
      tag: 'tag',
      expiresAt: EXPIRES_AT,
      expires_at: EXPIRES_AT,
    }
    const message = queueMessage(body as unknown as AdPlatformQueueMessage)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(db.delivery).toMatchObject({ status: 'skipped', skip_reason: 'queue_message_invalid' })
    expect(db.outbox).toBeNull()
  })

  it('未知或非内部格式 deliveryId 在日志中固定为 unknown', async () => {
    const db = createQueueDb()
    const untrustedIds = [
      'token_private',
      'a'.repeat(64),
      'fb.1.1700000000000.123456789',
      'cdlv_not_in_db',
    ]
    const messages = untrustedIds.map(deliveryId => queueMessage({
      schemaVersion: 1,
      deliveryId,
      userData: {},
    } as unknown as AdPlatformQueueMessage))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await handleMetaCapiBatch(messageBatch(messages), env(db))

    expect(messages.every(message => message.ack.mock.calls.length === 1)).toBe(true)
    expect(consoleError).toHaveBeenCalledTimes(untrustedIds.length)
    for (const call of consoleError.mock.calls) {
      expect(call[1]).toMatchObject({ deliveryId: 'unknown' })
    }
    const serializedLogs = JSON.stringify(consoleError.mock.calls)
    for (const deliveryId of untrustedIds) expect(serializedLogs).not.toContain(deliveryId)
    expect(db.delivery).toMatchObject({ status: 'pending', skip_reason: '' })
  })

  it('own accessor 抛错时不触发 getter、不打断批次并继续消费下一条消息', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb()
    const validBody = await encryptedMessage(db)
    let getterReads = 0
    const poisonedBody = {
      schemaVersion: 2,
      get deliveryId(): never {
        getterReads += 1
        throw new Error('不应读取 accessor')
      },
      envelope: validBody.envelope,
    }
    const poisoned = queueMessage(poisonedBody as unknown as AdPlatformQueueMessage)
    const valid = queueMessage(validBody)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await expect(handleMetaCapiBatch(messageBatch([poisoned, valid]), env(db))).resolves.toBeUndefined()

    expect(getterReads).toBe(0)
    expect(poisoned.ack).toHaveBeenCalledOnce()
    expect(valid.ack).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(db.delivery.status).toBe('sent')
  })

  it('Proxy trap 抛错和异常 prototype 均安全终止且不影响后续消息', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb()
    const validBody = await encryptedMessage(db)
    let inheritedGetterReads = 0
    const inherited = Object.create({
      get deliveryId(): never {
        inheritedGetterReads += 1
        throw new Error('不应读取 prototype getter')
      },
    }) as Record<string, unknown>
    inherited.schemaVersion = 2
    inherited.envelope = validBody.envelope
    const poisoned = [
      queueMessage(new Proxy({}, {
        getPrototypeOf() { throw new Error('poison getPrototypeOf') },
      }) as unknown as AdPlatformQueueMessage),
      queueMessage(new Proxy({}, {
        ownKeys() { throw new Error('poison ownKeys') },
      }) as unknown as AdPlatformQueueMessage),
      queueMessage(inherited as unknown as AdPlatformQueueMessage),
    ]
    const valid = queueMessage(validBody)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await expect(handleMetaCapiBatch(messageBatch([...poisoned, valid]), env(db))).resolves.toBeUndefined()

    expect(inheritedGetterReads).toBe(0)
    expect(poisoned.every(message => message.ack.mock.calls.length === 1)).toBe(true)
    expect(valid.ack).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('retryable 失败保留消息密文并重试，永久失败删除残留 outbox', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const retryDb = createQueueDb()
    const retryBody = await encryptedMessage(retryDb)
    const retryMessage = queueMessage(retryBody, 2)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 500 }))

    await handleMetaCapiBatch(batch(retryMessage), env(retryDb))

    expect(retryMessage.retry).toHaveBeenCalledWith({ delaySeconds: 300 })
    expect(retryMessage.ack).not.toHaveBeenCalled()
    expect(retryDb.outbox).not.toBeNull()

    const permanentDb = createQueueDb()
    const permanentBody = await encryptedMessage(permanentDb)
    const permanentMessage = queueMessage(permanentBody)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 400 }))

    await handleMetaCapiBatch(batch(permanentMessage), env(permanentDb))

    expect(permanentMessage.ack).toHaveBeenCalledOnce()
    expect(permanentDb.delivery.status).toBe('failed')
    expect(permanentDb.outbox).toBeNull()
  })

  it('结构合法但认证失败的 AES-GCM envelope 打开解密 incident，并保留安全终态', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb()
    const body = await encryptedMessage(db)
    const tamperIndex = Math.floor(body.envelope.ciphertext.length / 2)
    const replacement = body.envelope.ciphertext[tamperIndex] === 'A' ? 'B' : 'A'
    body.envelope.ciphertext = `${body.envelope.ciphertext.slice(0, tamperIndex)}${replacement}${body.envelope.ciphertext.slice(tamperIndex + 1)}`
    const message = queueMessage(body)

    await handleMetaCapiBatch(batch(message), env(db))

    expect(db.delivery).toMatchObject({ status: 'failed', error_code: 'secure_context_authentication_failed' })
    expect(message.ack).toHaveBeenCalledOnce()
    const incident = db.calls.find(call => call.sql.includes('INSERT OR IGNORE INTO meta_capi_incidents'))
    expect(incident?.params).toContain('secure_context_decryption_failed')
    expect(JSON.stringify(incident)).not.toContain(body.envelope.ciphertext)
  })

  it('AES-GCM 解密成功但 payload 非法时保留 delivery failure，且不得打开解密 incident', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb()
    const body = await encryptedRawMessage(db, new TextEncoder().encode('{"payload":"secret"}'))
    const message = queueMessage(body)

    await handleMetaCapiBatch(batch(message), env(db))

    expect(db.delivery).toMatchObject({ status: 'failed', error_code: 'secure_context_payload_invalid' })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO meta_capi_incidents'))).toBe(false)
  })

  it('非终态但不可发送的 delivery 状态重试消息且保留密文', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb({ status: 'attempted' })
    const body = await encryptedMessage(db)
    db.delivery.status = 'attempted'
    const message = queueMessage(body)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await handleMetaCapiBatch(batch(message), env(db))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(db.outbox).not.toBeNull()
  })

  it('DLQ retry exhausted 写终态、删除密文并 ack', async () => {
    const db = createQueueDb({ status: 'failed' })
    const body = await encryptedMessage(db)
    db.delivery.status = 'failed'
    db.delivery.error_code = 'meta_http_500'
    db.daily.set('pending', 0)
    db.daily.set('failed', 1)
    const message = queueMessage(body, 6)

    await handleMetaCapiBatch(batch(message, 'meigallery-meta-capi-dlq'), env(db))

    expect(db.delivery).toMatchObject({ status: 'failed', error_code: 'retry_exhausted' })
    expect(db.outbox).toBeNull()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('retry_exhausted CAS 遇到 retryable failed 并发变为永久 failed 时保留原错误和日报', async () => {
    const db = createQueueDb({
      status: 'failed',
      beforeFirstTransition: (delivery) => {
        delivery.error_code = 'meta_http_400'
      },
    })
    db.delivery.error_code = 'meta_http_500'
    const body = await encryptedMessage(db)
    db.delivery.status = 'failed'
    db.delivery.error_code = 'meta_http_500'
    const message = queueMessage(body, 6)

    await handleMetaCapiBatch(batch(message, 'meigallery-meta-capi-dlq'), env(db))

    expect(db.delivery).toMatchObject({ status: 'failed', error_code: 'meta_http_400' })
    expect(db.daily.get('failed')).toBe(1)
    expect(db.daily.get('skipped') ?? 0).toBe(0)
    expect(db.outbox).toBeNull()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('DLQ 或畸形 V2 只清理既有永久终态，不覆盖原状态', async () => {
    const permanentDb = createQueueDb({ status: 'failed' })
    permanentDb.delivery.error_code = 'meta_http_400'
    const permanentBody = await encryptedMessage(permanentDb)
    permanentDb.delivery.status = 'failed'
    permanentDb.delivery.error_code = 'meta_http_400'
    const dlqMessage = queueMessage(permanentBody, 6)

    await handleMetaCapiBatch(batch(dlqMessage, 'meigallery-meta-capi-dlq'), env(permanentDb))

    expect(permanentDb.delivery).toMatchObject({ status: 'failed', error_code: 'meta_http_400' })
    expect(permanentDb.outbox).toBeNull()
    expect(dlqMessage.ack).toHaveBeenCalledOnce()

    const skippedDb = createQueueDb({ status: 'skipped' })
    skippedDb.delivery.skip_reason = 'missing_secret'
    const skippedBody = await encryptedMessage(skippedDb)
    skippedDb.delivery.status = 'skipped'
    skippedDb.delivery.skip_reason = 'missing_secret'
    const malformedMessage = queueMessage({
      ...skippedBody,
      envelope: { ...skippedBody.envelope, tag: 42 },
    } as unknown as AdPlatformQueueMessage)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await handleMetaCapiBatch(batch(malformedMessage), env(skippedDb))

    expect(skippedDb.delivery).toMatchObject({ status: 'skipped', skip_reason: 'missing_secret' })
    expect(skippedDb.outbox).toBeNull()
    expect(malformedMessage.ack).toHaveBeenCalledOnce()
  })

  it('scheduled recovery 从 D1 重放原密文，不再构造空匹配对象', async () => {
    const db = createQueueDb()
    const expected = await encryptedMessage(db)
    const sent: AdPlatformQueueMessage[] = []

    const result = await recoverPendingMetaCapiDeliveries({
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send: async message => { sent.push(message) } } as Queue<AdPlatformQueueMessage>,
    })

    expect(result).toEqual({ scanned: 1, enqueued: 1, failed: 0 })
    expect(sent).toEqual([expected])
    expect(JSON.stringify(sent)).not.toContain('userData')
  })

  it('入队清理失败可恢复出重复消息，但相同 external event ID 只发送成功一次', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const db = createQueueDb({ cleanupBatchFailures: 1 })
    await encryptedMessage(db)
    const queued: AdPlatformQueueMessage[] = []
    const producerEnv = {
      DB: db as unknown as D1Database,
      META_CAPI_QUEUE: { send: async message => { queued.push(message) } } as Queue<AdPlatformQueueMessage>,
    }

    expect(await enqueueMetaSecureDelivery(producerEnv, db.delivery.id)).toBe('failed')
    db.delivery.updated_at = '2026-07-11 10:00:00'
    expect(await enqueueMetaSecureDelivery(producerEnv, db.delivery.id)).toBe('enqueued')
    expect(queued).toHaveLength(2)
    expect(queued[0]).toEqual(queued[1])

    const first = queueMessage(queued[0]!)
    const second = queueMessage(queued[1]!)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }))

    await handleMetaCapiBatch(batch(first), env(db))
    await handleMetaCapiBatch(batch(second), env(db))

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(db.delivery.status).toBe('sent')
    expect(db.daily.get('sent')).toBe(1)
    expect(first.ack).toHaveBeenCalledOnce()
    expect(second.ack).toHaveBeenCalledOnce()
  })

  it('重试退避固定封顶', () => {
    expect([1, 2, 3, 4, 5, 6].map(computeMetaRetryDelay)).toEqual([60, 300, 900, 1800, 1800, 1800])
    expect(computeMetaRetryDelay(Number.NaN)).toBe(60)
  })
})
