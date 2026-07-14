import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { AdPlatformQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import {
  encryptTikTokEventsContext,
  loadTikTokEventsCryptoKeys,
  tiktokConnectionFingerprint,
} from '../utils/tiktok-events-crypto'
import { handleTikTokEventsBatch } from './tiktok-events-queue'

const PIXEL_ID = 'C123456789ABCDEF'
const ACCESS_TOKEN = 'tiktok-queue-token-sensitive'
const REVISION = '2'.repeat(32)
const DATA_KEY = Buffer.alloc(32, 13).toString('base64')
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000349' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const statement of unstable_splitSqlQuery(schemaSql())) await db.prepare(statement).run()
})

beforeEach(async () => {
  for (const statement of unstable_splitSqlQuery(`
    DELETE FROM ad_platform_secure_outbox;
    DELETE FROM analytics_conversion_delivery_daily;
    DELETE FROM analytics_conversion_deliveries;
    DELETE FROM analytics_conversion_actions;
    DELETE FROM tiktok_connection_verifications;
    DELETE FROM ad_platform_connections;
  `)) await db.prepare(statement).run()
  const fingerprint = await tiktokConnectionFingerprint(PIXEL_ID, ACCESS_TOKEN)
  await db.batch([
    db.prepare(`
      INSERT INTO ad_platform_connections (
        provider, enabled, mode, browser_enabled, server_enabled, destination_id,
        debug_enabled, rollout_percentage, credential_secret_name, revision
      ) VALUES ('tiktok', 1, 'production', 1, 1, ?, 0, 100, 'TIKTOK_EVENTS_ACCESS_TOKEN', ?)
    `).bind(PIXEL_ID, REVISION),
    db.prepare(`
      INSERT INTO tiktok_connection_verifications (
        environment, pixel_id, credential_fingerprint, revision, verified_at,
        invalidated_at, invalidation_reason
      ) VALUES ('production', ?, ?, ?, '2026-07-13T00:00:00.000Z', NULL, '')
    `).bind(PIXEL_ID, fingerprint, REVISION),
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => miniflare.dispose())

describe('TikTok Events Queue 真实 D1', () => {
  it('解密匹配上下文、发送一次并确认消息', async () => {
    await seedDelivery('cdlv_tiktok_queue_success')
    const body = await encryptedMessage('cdlv_tiktok_queue_success')
    const message = queueMessage(body)
    const fetchFn = successfulFetch()
    vi.stubGlobal('fetch', fetchFn)

    await handleTikTokEventsBatch(messageBatch(message), queueEnv())

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      data: [{
        event_id: 'event_tiktok_queue_success',
        user: { ttclid: 'ttclid-queue', ttp: 'ttp-queue' },
      }],
    })
    expect(await ledger('cdlv_tiktok_queue_success')).toMatchObject({ status: 'sent', error_code: '' })
    expect(await outboxCount('cdlv_tiktok_queue_success')).toBe(0)
  })

  it('网络失败保留消息并按首次延迟重试', async () => {
    await seedDelivery('cdlv_tiktok_queue_retry')
    const message = queueMessage(await encryptedMessage('cdlv_tiktok_queue_retry'))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('network') }))

    await handleTikTokEventsBatch(messageBatch(message), queueEnv())

    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(await ledger('cdlv_tiktok_queue_retry')).toMatchObject({
      status: 'failed',
      error_code: 'tiktok_network_error',
    })
  })

  it('密文认证失败安全终止且不请求 TikTok', async () => {
    await seedDelivery('cdlv_tiktok_queue_tampered')
    const body = await encryptedMessage('cdlv_tiktok_queue_tampered')
    body.envelope.tag = `${body.envelope.tag.startsWith('A') ? 'B' : 'A'}${body.envelope.tag.slice(1)}`
    const message = queueMessage(body)
    const fetchFn = successfulFetch()
    vi.stubGlobal('fetch', fetchFn)

    await handleTikTokEventsBatch(messageBatch(message), queueEnv())

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await ledger('cdlv_tiktok_queue_tampered')).toMatchObject({
      status: 'failed',
      error_code: 'secure_context_authentication_failed',
    })
  })

  it('DLQ 消息标记 retry_exhausted 并删除密文', async () => {
    await seedDelivery('cdlv_tiktok_queue_dlq')
    const message = queueMessage(await encryptedMessage('cdlv_tiktok_queue_dlq'), 6)
    const fetchFn = successfulFetch()
    vi.stubGlobal('fetch', fetchFn)

    await handleTikTokEventsBatch(messageBatch(message, 'meigallery-tiktok-events-dlq'), queueEnv())

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await ledger('cdlv_tiktok_queue_dlq')).toMatchObject({
      status: 'failed',
      error_code: 'retry_exhausted',
      error_message: 'TikTok Events API 请求失败',
    })
    expect(await outboxCount('cdlv_tiktok_queue_dlq')).toBe(0)
  })

  it('可识别 delivery 的旧 schema 消息以 queue_message_invalid 终止', async () => {
    await seedDelivery('cdlv_tiktok_queue_legacy')
    const message = queueMessage({
      schemaVersion: 1,
      deliveryId: 'cdlv_tiktok_queue_legacy',
    } as unknown as AdPlatformQueueMessage)
    const fetchFn = successfulFetch()
    vi.stubGlobal('fetch', fetchFn)

    await handleTikTokEventsBatch(messageBatch(message), queueEnv())

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await ledger('cdlv_tiktok_queue_legacy')).toMatchObject({
      status: 'failed',
      error_code: 'queue_message_invalid',
    })
  })

  it('超过 24 小时的安全上下文标记过期，不再发送', async () => {
    await seedDelivery('cdlv_tiktok_queue_expired', '2000-01-01 00:00:00')
    const message = queueMessage(await encryptedMessage('cdlv_tiktok_queue_expired'))
    const fetchFn = successfulFetch()
    vi.stubGlobal('fetch', fetchFn)

    await handleTikTokEventsBatch(messageBatch(message), queueEnv())

    expect(message.ack).toHaveBeenCalledOnce()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await ledger('cdlv_tiktok_queue_expired')).toMatchObject({
      status: 'skipped',
      skip_reason: 'secure_context_expired',
    })
  })
})

async function seedDelivery(deliveryId: string, createdAt = new Date().toISOString()) {
  const actionId = deliveryId.replace('cdlv_', 'conv_')
  await db.batch([
    db.prepare(`
      INSERT INTO analytics_conversion_actions (id, occurred_at, date, path, metadata)
      VALUES (?, '2026-07-13T08:00:00.000Z', '2026-07-13', '/contact', '{}')
    `).bind(actionId),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, provider, transport, external_event_id, event_name,
        status, tracking_mode, connection_revision, created_at, updated_at
      ) VALUES (?, ?, 'tiktok', 'server', ?, 'Contact', 'pending', 'production', ?, ?, datetime('now'))
    `).bind(deliveryId, actionId, `event_${deliveryId.replace('cdlv_', '')}`, REVISION, createdAt),
    db.prepare(`
      INSERT INTO analytics_conversion_delivery_daily (
        date, provider, transport, event_name, status, skip_reason, delivery_count
      ) VALUES ('2026-07-13', 'tiktok', 'server', 'Contact', 'pending', '', 1)
    `),
  ])
}

async function encryptedMessage(deliveryId: string) {
  const keys = await loadTikTokEventsCryptoKeys({ TIKTOK_EVENTS_DATA_KEY_CURRENT: DATA_KEY })
  const envelope = await encryptTikTokEventsContext({
    keys,
    aad: {
      deliveryId,
      externalEventId: `event_${deliveryId.replace('cdlv_', '')}`,
      eventName: 'Contact',
    },
    value: {
      ttclid: 'ttclid-queue',
      ttp: 'ttp-queue',
      clientIpAddress: '203.0.113.20',
      clientUserAgent: 'Mozilla/5.0 TikTokQueueTest/1.0',
    },
  })
  const { schemaVersion: _schemaVersion, ...encrypted } = envelope
  await db.batch([
    db.prepare(`
      UPDATE analytics_conversion_deliveries SET encryption_key_id = ? WHERE id = ?
    `).bind(encrypted.keyId, deliveryId),
    db.prepare(`
      INSERT INTO ad_platform_secure_outbox (
        delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at
      ) VALUES (?, 'tiktok', 2, ?, ?, ?, ?, ?)
    `).bind(deliveryId, encrypted.keyId, encrypted.iv, encrypted.ciphertext, encrypted.tag, EXPIRES_AT),
  ])
  return {
    schemaVersion: 2,
    deliveryId,
    envelope: { ...encrypted, expiresAt: EXPIRES_AT },
  } satisfies AdPlatformQueueMessage
}

function queueMessage(body: AdPlatformQueueMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() }
}

function messageBatch(
  message: ReturnType<typeof queueMessage>,
  queue = 'meigallery-tiktok-events',
) {
  return { queue, messages: [message] } as unknown as MessageBatch<AdPlatformQueueMessage>
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    code: 0,
    message: 'OK',
    request_id: 'request-queue',
  }), { status: 200 }))
}

function queueEnv() {
  return {
    DB: db,
    APP_ENV: 'production',
    SITE_URL: 'https://616618.xyz',
    TIKTOK_EVENTS_ACCESS_TOKEN: ACCESS_TOKEN,
    TIKTOK_EVENTS_DATA_KEY_CURRENT: DATA_KEY,
    TIKTOK_EVENTS_QUEUE: { send: vi.fn(async () => undefined) },
  } as unknown as Bindings
}

function ledger(deliveryId: string) {
  return db.prepare(`
    SELECT status, skip_reason, error_code, error_message
    FROM analytics_conversion_deliveries WHERE id = ?
  `).bind(deliveryId).first<Record<string, unknown>>()
}

async function outboxCount(deliveryId: string) {
  return Number(await db.prepare(`
    SELECT COUNT(*) FROM ad_platform_secure_outbox WHERE delivery_id = ? AND provider = 'tiktok'
  `).bind(deliveryId).first<number>('COUNT(*)') ?? 0)
}

function schemaSql() {
  return `
    CREATE TABLE ad_platform_connections (
      provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, mode TEXT NOT NULL,
      browser_enabled INTEGER NOT NULL, server_enabled INTEGER NOT NULL,
      destination_id TEXT NOT NULL, debug_enabled INTEGER NOT NULL,
      rollout_percentage INTEGER NOT NULL, credential_secret_name TEXT NOT NULL,
      revision TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tiktok_connection_verifications (
      environment TEXT PRIMARY KEY, pixel_id TEXT NOT NULL, credential_fingerprint TEXT NOT NULL,
      revision TEXT NOT NULL, verified_at TEXT NOT NULL, invalidated_at TEXT,
      invalidation_reason TEXT NOT NULL, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE analytics_conversion_actions (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, date TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY, conversion_action_id TEXT NOT NULL,
      provider TEXT NOT NULL, transport TEXT NOT NULL,
      external_event_id TEXT NOT NULL, event_name TEXT NOT NULL, status TEXT NOT NULL,
      skip_reason TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '', attempt_count INTEGER NOT NULL DEFAULT 0,
      tracking_mode TEXT NOT NULL, connection_revision TEXT,
      duplicate_suppressed_at TEXT, encryption_key_id TEXT NOT NULL DEFAULT '',
      delivery_lease_token TEXT NOT NULL DEFAULT '', delivery_lease_expires_at TEXT,
      last_attempt_at TEXT, sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE ad_platform_secure_outbox (
      delivery_id TEXT PRIMARY KEY, provider TEXT NOT NULL, schema_version INTEGER NOT NULL,
      key_id TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
      tag TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE analytics_conversion_delivery_daily (
      date TEXT NOT NULL, provider TEXT NOT NULL, transport TEXT NOT NULL,
      event_name TEXT NOT NULL, status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '',
      delivery_count INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, provider, transport, event_name, status, skip_reason)
    );
  `
}
