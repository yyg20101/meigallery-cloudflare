import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import type { MetaCapiQueueMessage } from '@meigallery/shared'
import type { Bindings } from '../index'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import {
  acquireMetaCapiDeliveryLease,
  sendMetaCapiEvent,
} from './meta-capi'
import { handleMetaCapiBatch } from './meta-capi-queue'

const PIXEL_ID = '1234567890'
const ACCESS_TOKEN = 'lease-d1-access-token'
const RELEASE_COMMIT = 'a'.repeat(40)
const REVISION = '1'.repeat(32)

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000043' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const statement of schemaSql().split(';').map(value => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run()
  }
  const fingerprint = await metaConnectionFingerprint(PIXEL_ID, ACCESS_TOKEN)
  await db.batch([
    db.prepare("INSERT INTO site_settings (key, value) VALUES ('facebook_pixel_id', ?)").bind(JSON.stringify(PIXEL_ID)),
    db.prepare("INSERT INTO site_settings (key, value) VALUES ('meta_tracking_mode', '" + '"production"' + "')"),
    db.prepare(`
      INSERT INTO meta_connection_verifications (
        environment, pixel_id, token_fingerprint, graph_api_version,
        verified_event_name, verified_commit, dataset_quality_status,
        verified_at, invalidated_at, invalidation_reason, revision
      ) VALUES ('dev', ?, ?, 'v25.0', 'Contact', ?, 'not_checked', datetime('now'), NULL, '', ?)
    `).bind(PIXEL_ID, fingerprint, RELEASE_COMMIT, REVISION),
  ])
})

afterAll(async () => miniflare.dispose())
afterEach(async () => {
  vi.restoreAllMocks()
  await restoreConnectionRevision()
})

describe('Meta CAPI delivery lease 真实 D1', () => {
  it('并发消费者只有赢家请求 Graph，loser 不 fetch 且 sent 不回归', async () => {
    await seedDelivery('cdlv_d1_concurrent', 'event_d1_stable')
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const fetchFn = vi.fn(async () => {
      await barrier
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    })
    const env = deliveryEnv()

    const winnerPromise = sendMetaCapiEvent(env, 'cdlv_d1_concurrent', { fetchFn })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
    const loser = await sendMetaCapiEvent(env, 'cdlv_d1_concurrent', { fetchFn })
    release()
    const winner = await winnerPromise

    expect(winner.status).toBe('sent')
    expect(loser).toMatchObject({ status: 'pending', reason: 'delivery_lease_active' })
    expect(fetchFn).toHaveBeenCalledOnce()
    const row = await db.prepare(`
      SELECT status, external_event_id, delivery_lease_token, delivery_lease_expires_at
      FROM analytics_conversion_deliveries WHERE id = ?
    `).bind('cdlv_d1_concurrent').first<Record<string, unknown>>()
    expect(row).toEqual({
      status: 'sent',
      external_event_id: 'event_d1_stable',
      delivery_lease_token: '',
      delivery_lease_expires_at: null,
    })

    const repeated = await sendMetaCapiEvent(env, 'cdlv_d1_concurrent', { fetchFn })
    expect(repeated).toMatchObject({ status: 'duplicate_suppressed', reason: 'already_sent' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('消费者崩溃遗留的 lease 到期后可由新 token 接管且 event ID 不变', async () => {
    await seedDelivery('cdlv_d1_crash', 'event_d1_crash_stable')
    const first = await acquireMetaCapiDeliveryLease(db, 'cdlv_d1_crash')
    const blocked = await acquireMetaCapiDeliveryLease(db, 'cdlv_d1_crash')
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(blocked).toBeNull()

    await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET delivery_lease_expires_at = datetime('now', '-1 second')
      WHERE id = ?
    `).bind('cdlv_d1_crash').run()
    const takeover = await acquireMetaCapiDeliveryLease(db, 'cdlv_d1_crash')
    expect(takeover).toMatch(/^[0-9a-f]{32}$/)
    expect(takeover).not.toBe(first)
    const row = await db.prepare(`
      SELECT external_event_id FROM analytics_conversion_deliveries WHERE id = ?
    `).bind('cdlv_d1_crash').first<{ external_event_id: string }>()
    expect(row?.external_event_id).toBe('event_d1_crash_stable')
  })

  it.each([
    ['DLQ retry_exhausted', 'dlq'],
    ['connection drift', 'connection_drift'],
    ['legacy terminate', 'legacy'],
    ['security terminate', 'security'],
  ] as const)('%s 不能越过 active lease，winner 收到 events_received=1 后账本保持 sent', async (_label, scenario) => {
    const deliveryId = `cdlv_d1_fence_${scenario}`
    await seedDelivery(deliveryId, `event_d1_fence_${scenario}`)
    await seedOutbox(deliveryId)
    let releaseGraph!: () => void
    const graphBarrier = new Promise<void>(resolve => { releaseGraph = resolve })
    const fetchFn = vi.fn(async () => {
      await graphBarrier
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    })

    const winnerPromise = sendMetaCapiEvent(deliveryEnv(), deliveryId, { fetchFn })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
    if (scenario === 'connection_drift') {
      await db.prepare(`
        UPDATE meta_connection_verifications SET revision = ? WHERE environment = 'dev'
      `).bind('2'.repeat(32)).run()
    }

    const loser = queueMessage(loserBody(deliveryId, scenario), 6)
    await handleMetaCapiBatch(messageBatch(loser, scenario === 'dlq' ? 'meigallery-meta-capi-dlq' : 'meigallery-meta-capi'), queueEnv())

    const activeLeaseSnapshot = {
      acked: loser.ack.mock.calls.length,
      retried: loser.retry.mock.calls.length,
      outboxCount: await outboxCount(deliveryId),
      status: (await deliveryLedger(deliveryId)).status,
    }

    releaseGraph()
    const winner = await winnerPromise
    expect(activeLeaseSnapshot).toEqual({ acked: 0, retried: 1, outboxCount: 1, status: 'pending' })
    expect(winner).toMatchObject({ status: 'sent', eventsReceived: 1 })
    expect(await deliveryLedger(deliveryId)).toMatchObject({ status: 'sent', error_code: '', skip_reason: '' })
    expect(fetchFn).toHaveBeenCalledOnce()

    await handleMetaCapiBatch(messageBatch(loser, scenario === 'dlq' ? 'meigallery-meta-capi-dlq' : 'meigallery-meta-capi'), queueEnv())
    expect((await deliveryLedger(deliveryId)).status).toBe('sent')
  })

  it('lease 过期后无 token 的 DLQ 终态可原子接管，并且 sent 永不回归', async () => {
    const expiredId = 'cdlv_d1_fence_expired'
    await seedDelivery(expiredId, 'event_d1_fence_expired')
    await seedOutbox(expiredId)
    expect(await acquireMetaCapiDeliveryLease(db, expiredId)).toMatch(/^[0-9a-f]{32}$/)
    await db.prepare(`
      UPDATE analytics_conversion_deliveries
      SET delivery_lease_expires_at = datetime('now', '-1 second')
      WHERE id = ?
    `).bind(expiredId).run()
    const expiredMessage = queueMessage(validBody(expiredId), 6)

    await handleMetaCapiBatch(messageBatch(expiredMessage, 'meigallery-meta-capi-dlq'), queueEnv())

    expect(expiredMessage.ack).toHaveBeenCalledOnce()
    expect(expiredMessage.retry).not.toHaveBeenCalled()
    expect(await deliveryLedger(expiredId)).toMatchObject({ status: 'failed', error_code: 'retry_exhausted' })
    expect(await outboxCount(expiredId)).toBe(0)

    const sentId = 'cdlv_d1_fence_sent'
    await seedDelivery(sentId, 'event_d1_fence_sent')
    await db.prepare("UPDATE analytics_conversion_deliveries SET status = 'sent' WHERE id = ?").bind(sentId).run()
    await seedOutbox(sentId)
    const sentMessage = queueMessage(validBody(sentId), 6)
    await handleMetaCapiBatch(messageBatch(sentMessage, 'meigallery-meta-capi-dlq'), queueEnv())
    expect((await deliveryLedger(sentId)).status).toBe('sent')
  })
})

async function seedDelivery(deliveryId: string, eventId: string) {
  const actionId = deliveryId.replace('cdlv_', 'conv_')
  await db.batch([
    db.prepare(`
      INSERT INTO analytics_conversion_actions (id, occurred_at, date, path, metadata)
      VALUES (?, '2026-07-11T00:00:00.000Z', '2026-07-11', '/', '{}')
    `).bind(actionId),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, channel, external_event_id, event_name,
        status, tracking_mode, meta_connection_revision, created_at, updated_at
      ) VALUES (?, ?, 'meta_capi', ?, 'Contact', 'pending', 'production', ?, datetime('now'), datetime('now'))
    `).bind(deliveryId, actionId, eventId, REVISION),
    db.prepare(`
      INSERT INTO analytics_conversion_delivery_daily (
        date, provider, transport, channel, event_name, status, skip_reason, delivery_count
      ) VALUES ('2026-07-11', 'meta', 'server', 'meta_capi', 'Contact', 'pending', '', 1)
      ON CONFLICT(date, provider, transport, event_name, status, skip_reason)
      DO UPDATE SET delivery_count = delivery_count + 1
    `),
  ])
}

async function seedOutbox(deliveryId: string) {
  await db.prepare(`
    INSERT INTO meta_capi_secure_outbox (
      delivery_id, schema_version, key_id, iv, ciphertext, tag, expires_at
    ) VALUES (?, 2, '0123456789abcdef', 'iv', 'ciphertext', 'tag', '2099-01-01T00:00:00.000Z')
  `).bind(deliveryId).run()
}

function validBody(deliveryId: string): MetaCapiQueueMessage {
  return {
    schemaVersion: 2,
    deliveryId,
    envelope: {
      keyId: '0123456789abcdef',
      iv: 'iv',
      ciphertext: 'ciphertext',
      tag: 'tag',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  }
}

function loserBody(deliveryId: string, scenario: 'dlq' | 'connection_drift' | 'legacy' | 'security') {
  if (scenario === 'legacy') return { schemaVersion: 1, deliveryId } as unknown as MetaCapiQueueMessage
  if (scenario === 'security') {
    return { ...validBody(deliveryId), envelope: { ...validBody(deliveryId).envelope, tag: 42 } } as unknown as MetaCapiQueueMessage
  }
  return validBody(deliveryId)
}

function queueMessage(body: MetaCapiQueueMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() }
}

function messageBatch(message: ReturnType<typeof queueMessage>, queue: string) {
  return { queue, messages: [message] } as unknown as MessageBatch<MetaCapiQueueMessage>
}

function queueEnv() {
  return deliveryEnv() as unknown as Bindings
}

async function deliveryLedger(deliveryId: string) {
  return db.prepare(`
    SELECT status, error_code, skip_reason FROM analytics_conversion_deliveries WHERE id = ?
  `).bind(deliveryId).first<{ status: string; error_code: string; skip_reason: string }>() as Promise<{ status: string; error_code: string; skip_reason: string }>
}

async function outboxCount(deliveryId: string) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM meta_capi_secure_outbox WHERE delivery_id = ?')
    .bind(deliveryId).first<{ count: number }>()
  return row?.count ?? 0
}

async function restoreConnectionRevision() {
  await db.prepare(`
    UPDATE meta_connection_verifications SET revision = ? WHERE environment = 'dev'
  `).bind(REVISION).run()
}

function deliveryEnv() {
  return {
    DB: db,
    APP_ENV: 'dev',
    SITE_URL: 'https://616618.xyz',
    META_CAPI_ACCESS_TOKEN: ACCESS_TOKEN,
    META_CAPI_TEST_EVENT_CODE: 'unused-test-code',
    RELEASE_COMMIT,
  }
}

function schemaSql() {
  return `
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE meta_connection_verifications (
      environment TEXT PRIMARY KEY, pixel_id TEXT NOT NULL, token_fingerprint TEXT NOT NULL,
      graph_api_version TEXT NOT NULL, verified_event_name TEXT NOT NULL, verified_commit TEXT NOT NULL,
      dataset_quality_status TEXT NOT NULL, verified_at TEXT NOT NULL, verified_by_user_id INTEGER,
      invalidated_at TEXT, invalidation_reason TEXT NOT NULL, revision TEXT
    );
    CREATE TABLE analytics_conversion_actions (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, date TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY, conversion_action_id TEXT NOT NULL, channel TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'meta', transport TEXT NOT NULL DEFAULT 'server',
      external_event_id TEXT NOT NULL, event_name TEXT NOT NULL, status TEXT NOT NULL,
      skip_reason TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '', attempt_count INTEGER NOT NULL DEFAULT 0,
      tracking_mode TEXT NOT NULL, meta_connection_revision TEXT,
      duplicate_suppressed_at TEXT, encryption_key_id TEXT NOT NULL DEFAULT '',
      delivery_lease_token TEXT NOT NULL DEFAULT '', delivery_lease_expires_at TEXT,
      last_attempt_at TEXT, sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE meta_capi_secure_outbox (
      delivery_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, key_id TEXT NOT NULL,
      iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE analytics_conversion_delivery_daily (
      date TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'meta', transport TEXT NOT NULL DEFAULT 'server',
      channel TEXT NOT NULL, event_name TEXT NOT NULL,
      status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '', delivery_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, provider, transport, event_name, status, skip_reason)
    );
  `
}
