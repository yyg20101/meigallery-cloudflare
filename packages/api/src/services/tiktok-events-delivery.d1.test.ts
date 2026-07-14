import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import { tiktokConnectionFingerprint } from '../utils/tiktok-events-crypto'
import {
  sendTikTokEventsDelivery,
  TikTokEventsDeliveryError,
} from './tiktok-events-delivery'

const PIXEL_ID = 'C123456789ABCDEF'
const ACCESS_TOKEN = 'tiktok-delivery-token-sensitive'
const REVISION = '1'.repeat(32)
const EMAIL_HASH = 'a'.repeat(64)
const EXTERNAL_ID_HASH = 'b'.repeat(64)

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000249' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const statement of unstable_splitSqlQuery(schemaSql())) await db.prepare(statement).run()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  for (const statement of unstable_splitSqlQuery(`
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

afterAll(async () => miniflare.dispose())

describe('TikTok Events API 真实 D1 投递', () => {
  it('注册事件发送完整匹配字段且重复消费不再次请求 TikTok', async () => {
    await seedDelivery('cdlv_tiktok_registration', 'CompleteRegistration', '/register?invite=private')
    const fetchFn = successfulFetch()

    const sent = await sendTikTokEventsDelivery(deliveryEnv(), 'cdlv_tiktok_registration', {
      fetchFn,
      userData: matchingContext(),
    })
    const repeated = await sendTikTokEventsDelivery(deliveryEnv(), 'cdlv_tiktok_registration', {
      fetchFn,
      userData: matchingContext(),
    })

    expect(sent).toMatchObject({ status: 'sent', requestId: 'request-delivery' })
    expect(repeated).toMatchObject({ status: 'duplicate_suppressed', reason: 'already_sent' })
    expect(fetchFn).toHaveBeenCalledOnce()
    const [, init] = fetchFn.mock.calls[0]!
    const payload = JSON.parse(String(init?.body))
    expect(payload).toMatchObject({
      event_source: 'web',
      event_source_id: PIXEL_ID,
      data: [{
        event: 'CompleteRegistration',
        event_id: 'event_tiktok_registration',
        page: { url: 'https://616618.xyz/register' },
        user: {
          ttclid: 'ttclid-registration',
          ttp: 'ttp-registration',
          ip: '203.0.113.10',
          user_agent: 'Mozilla/5.0 TikTokDeliveryTest/1.0',
          email: EMAIL_HASH,
          external_id: EXTERNAL_ID_HASH,
        },
      }],
    })
    expect(payload).not.toHaveProperty('test_event_code')
    expect(await deliveryRow('cdlv_tiktok_registration')).toMatchObject({
      status: 'sent',
      error_code: '',
      attempt_count: 1,
      delivery_lease_token: '',
      delivery_lease_expires_at: null,
    })
  })

  it('Contact 仅发送点击与设备匹配字段，不发送注册身份摘要', async () => {
    await seedDelivery('cdlv_tiktok_contact', 'Contact', '/contact')
    const fetchFn = successfulFetch()

    await sendTikTokEventsDelivery(deliveryEnv(), 'cdlv_tiktok_contact', {
      fetchFn,
      userData: matchingContext(),
    })

    const payload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    expect(payload.data[0].user).toEqual({
      ttclid: 'ttclid-registration',
      ttp: 'ttp-registration',
      ip: '203.0.113.10',
      user_agent: 'Mozilla/5.0 TikTokDeliveryTest/1.0',
    })
  })

  it('可重试 TikTok code 写入稳定错误码并抛出 retryable 错误', async () => {
    await seedDelivery('cdlv_tiktok_retry', 'Contact', '/contact')
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      code: 40100,
      message: 'Internal processing error',
      request_id: 'request-retry',
    }), { status: 200 }))

    const error = await sendTikTokEventsDelivery(deliveryEnv(), 'cdlv_tiktok_retry', { fetchFn })
      .catch(value => value)

    expect(error).toBeInstanceOf(TikTokEventsDeliveryError)
    expect(error).toMatchObject({ code: 'tiktok_code_40100', retryable: true })
    expect(await deliveryRow('cdlv_tiktok_retry')).toMatchObject({
      status: 'failed',
      error_code: 'tiktok_code_40100',
      error_message: 'TikTok Events API 请求失败',
      attempt_count: 1,
      delivery_lease_token: '',
    })
  })

  it('无效 SITE_URL 直接终止，不请求 TikTok 且不会进入重试循环', async () => {
    await seedDelivery('cdlv_tiktok_payload', 'Contact', '/contact')
    const fetchFn = successfulFetch()

    const result = await sendTikTokEventsDelivery(deliveryEnv({ SITE_URL: 'invalid-url' }), 'cdlv_tiktok_payload', { fetchFn })

    expect(result).toEqual({
      deliveryId: 'cdlv_tiktok_payload',
      status: 'failed',
      reason: 'tiktok_payload_invalid',
    })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(await deliveryRow('cdlv_tiktok_payload')).toMatchObject({
      status: 'failed',
      error_code: 'tiktok_payload_invalid',
      attempt_count: 1,
    })
  })

  it('HTTP 401 即使没有 TikTok code 也会失效连接并关闭服务端放量', async () => {
    await seedDelivery('cdlv_tiktok_credential', 'Contact', '/contact')
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('Unauthorized', { status: 401 }))

    const result = await sendTikTokEventsDelivery(deliveryEnv(), 'cdlv_tiktok_credential', { fetchFn })

    expect(result).toMatchObject({ status: 'failed', reason: 'tiktok_http_401' })
    expect(await db.prepare(`
      SELECT invalidated_at, invalidation_reason
      FROM tiktok_connection_verifications WHERE environment = 'production'
    `).first<Record<string, unknown>>()).toMatchObject({
      invalidated_at: expect.any(String),
      invalidation_reason: 'credential_rejected',
    })
    expect(await db.prepare(`
      SELECT server_enabled, rollout_percentage, revision
      FROM ad_platform_connections WHERE provider = 'tiktok'
    `).first<Record<string, unknown>>()).toEqual({
      server_enabled: 0,
      rollout_percentage: 0,
      revision: null,
    })
  })

  it('连接 revision 漂移时跳过历史消息且不请求 TikTok', async () => {
    await seedDelivery('cdlv_tiktok_drift', 'Contact', '/contact', '2'.repeat(32))
    const fetchFn = successfulFetch()

    const result = await sendTikTokEventsDelivery(deliveryEnv(), 'cdlv_tiktok_drift', { fetchFn })

    expect(result).toMatchObject({ status: 'skipped', reason: 'connection_unverified' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

async function seedDelivery(
  deliveryId: string,
  eventName: 'Contact' | 'CompleteRegistration',
  path: string,
  revision = REVISION,
) {
  const actionId = deliveryId.replace('cdlv_', 'conv_')
  await db.batch([
    db.prepare(`
      INSERT INTO analytics_conversion_actions (id, occurred_at, date, path, metadata)
      VALUES (?, '2026-07-13T08:00:00.000Z', '2026-07-13', ?, '{}')
    `).bind(actionId, path),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, provider, transport, external_event_id, event_name,
        status, tracking_mode, connection_revision, created_at, updated_at
      ) VALUES (?, ?, 'tiktok', 'server', ?, ?, 'pending', 'production', ?, datetime('now'), datetime('now'))
    `).bind(deliveryId, actionId, `event_${deliveryId.replace('cdlv_', '')}`, eventName, revision),
    db.prepare(`
      INSERT INTO analytics_conversion_delivery_daily (
        date, provider, transport, event_name, status, skip_reason, delivery_count
      ) VALUES ('2026-07-13', 'tiktok', 'server', ?, 'pending', '', 1)
    `).bind(eventName),
  ])
}

function matchingContext() {
  return {
    ttclid: 'ttclid-registration',
    ttp: 'ttp-registration',
    clientIpAddress: '203.0.113.10',
    clientUserAgent: 'Mozilla/5.0 TikTokDeliveryTest/1.0',
    emailSha256: EMAIL_HASH,
    externalIdSha256: EXTERNAL_ID_HASH,
  }
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    code: 0,
    message: 'OK',
    request_id: 'request-delivery',
  }), { status: 200 }))
}

function deliveryEnv(overrides: Partial<Bindings> = {}) {
  return {
    DB: db,
    APP_ENV: 'production',
    SITE_URL: 'https://616618.xyz',
    TIKTOK_EVENTS_ACCESS_TOKEN: ACCESS_TOKEN,
    ...overrides,
  } as Pick<Bindings, 'DB' | 'APP_ENV' | 'SITE_URL' | 'TIKTOK_EVENTS_ACCESS_TOKEN'>
}

function deliveryRow(deliveryId: string) {
  return db.prepare(`
    SELECT status, error_code, error_message, attempt_count,
      delivery_lease_token, delivery_lease_expires_at
    FROM analytics_conversion_deliveries WHERE id = ?
  `).bind(deliveryId).first<Record<string, unknown>>()
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
    CREATE TABLE analytics_conversion_delivery_daily (
      date TEXT NOT NULL, provider TEXT NOT NULL, transport TEXT NOT NULL,
      event_name TEXT NOT NULL, status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '',
      delivery_count INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, provider, transport, event_name, status, skip_reason)
    );
  `
}
