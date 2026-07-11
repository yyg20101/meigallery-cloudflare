import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { metaConnectionFingerprint } from '../utils/meta-capi-crypto'
import {
  acquireMetaCapiDeliveryLease,
  sendMetaCapiEvent,
} from './meta-capi'

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
        date, channel, event_name, status, skip_reason, delivery_count
      ) VALUES ('2026-07-11', 'meta_capi', 'Contact', 'pending', '', 1)
      ON CONFLICT(date, channel, event_name, status, skip_reason)
      DO UPDATE SET delivery_count = delivery_count + 1
    `),
  ])
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
      external_event_id TEXT NOT NULL, event_name TEXT NOT NULL, status TEXT NOT NULL,
      skip_reason TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '', attempt_count INTEGER NOT NULL DEFAULT 0,
      tracking_mode TEXT NOT NULL, meta_connection_revision TEXT,
      duplicate_suppressed_at TEXT, encryption_key_id TEXT NOT NULL DEFAULT '',
      delivery_lease_token TEXT NOT NULL DEFAULT '', delivery_lease_expires_at TEXT,
      last_attempt_at TEXT, sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE analytics_conversion_delivery_daily (
      date TEXT NOT NULL, channel TEXT NOT NULL, event_name TEXT NOT NULL,
      status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '', delivery_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, channel, event_name, status, skip_reason)
    );
  `
}
