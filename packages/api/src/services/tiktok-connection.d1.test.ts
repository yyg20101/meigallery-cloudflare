import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import { tiktokConnectionFingerprint } from '../utils/tiktok-events-crypto'
import {
  getTikTokConnectionStatus,
  requireVerifiedTikTokConnection,
  verifyTikTokConnection,
} from './tiktok-connection'
import { TIKTOK_EVENTS_API_ENDPOINT } from './tiktok-events'

const PIXEL_ID = 'C123456789ABCDEF'
const ACCESS_TOKEN = 'tiktok-events-access-token-sensitive'
const TEST_EVENT_CODE = 'TEST_TIKTOK_2026'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000149' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  const schema = `
    CREATE TABLE ad_platform_connections (
      provider TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      mode TEXT NOT NULL,
      browser_enabled INTEGER NOT NULL,
      server_enabled INTEGER NOT NULL,
      destination_id TEXT NOT NULL,
      debug_enabled INTEGER NOT NULL,
      rollout_percentage INTEGER NOT NULL,
      credential_secret_name TEXT NOT NULL,
      revision TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tiktok_connection_verifications (
      environment TEXT PRIMARY KEY,
      pixel_id TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL,
      revision TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      invalidated_at TEXT,
      invalidation_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `
  for (const statement of unstable_splitSqlQuery(schema)) await db.prepare(statement).run()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  const seed = `
    DELETE FROM tiktok_connection_verifications;
    DELETE FROM ad_platform_connections;
    INSERT INTO ad_platform_connections (
      provider, enabled, mode, browser_enabled, server_enabled, destination_id,
      debug_enabled, rollout_percentage, credential_secret_name, revision
    ) VALUES (
      'tiktok', 1, 'production', 1, 0, '${PIXEL_ID}',
      0, 0, 'TIKTOK_EVENTS_ACCESS_TOKEN', NULL
    );
  `
  for (const statement of unstable_splitSqlQuery(seed)) await db.prepare(statement).run()
})

afterAll(async () => miniflare.dispose())

describe('TikTok 生产连接验证', () => {
  it('发送 Contact 与 CompleteRegistration 测试事件后保存摘要和 revision', async () => {
    const fetchFn = successfulTikTokFetch()

    const result = await verifyTikTokConnection(connectionEnv(), { testEventCode: TEST_EVENT_CODE, fetchFn })

    expect(result).toMatchObject({ verified: true, idempotent: false })
    expect(result.revision).toMatch(/^[0-9a-f]{32}$/)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const payloads = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(payloads.map(payload => payload.data[0].event)).toEqual(['Contact', 'CompleteRegistration'])
    expect(payloads.every(payload => payload.event_source === 'web')).toBe(true)
    expect(payloads.every(payload => payload.event_source_id === PIXEL_ID)).toBe(true)
    expect(payloads.every(payload => payload.test_event_code === TEST_EVENT_CODE)).toBe(true)
    for (const [input, init] of fetchFn.mock.calls) {
      expect(String(input)).toBe(TIKTOK_EVENTS_API_ENDPOINT)
      expect(new Headers(init?.headers).get('Access-Token')).toBe(ACCESS_TOKEN)
    }

    const verification = await db.prepare(`
      SELECT pixel_id, credential_fingerprint, revision, invalidated_at
      FROM tiktok_connection_verifications WHERE environment = 'production'
    `).first<Record<string, unknown>>()
    expect(verification).toEqual({
      pixel_id: PIXEL_ID,
      credential_fingerprint: await tiktokConnectionFingerprint(PIXEL_ID, ACCESS_TOKEN),
      revision: result.revision,
      invalidated_at: null,
    })
    expect(await connectionRevision()).toBe(result.revision)
    const persisted = JSON.stringify(await db.prepare('SELECT * FROM tiktok_connection_verifications').all())
    expect(persisted).not.toContain(ACCESS_TOKEN)
    expect(persisted).not.toContain(TEST_EVENT_CODE)
  })

  it('已验证连接重复验证保持 revision 幂等并发送当次测试事件', async () => {
    const fetchFn = successfulTikTokFetch()
    const first = await verifyTikTokConnection(connectionEnv(), { testEventCode: TEST_EVENT_CODE, fetchFn })
    const second = await verifyTikTokConnection(connectionEnv(), { testEventCode: TEST_EVENT_CODE, fetchFn })

    expect(second).toEqual({
      verified: true,
      idempotent: true,
      revision: first.revision,
      verifiedAt: first.verifiedAt,
      testEventsSent: 2,
    })
    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(await connectionRevision()).toBe(first.revision)
  })

  it('token 变化后状态变为 configuration_changed 并阻断服务端投递', async () => {
    await verifyTikTokConnection(connectionEnv(), {
      testEventCode: TEST_EVENT_CODE,
      fetchFn: successfulTikTokFetch(),
    })

    const rotated = connectionEnv({ TIKTOK_EVENTS_ACCESS_TOKEN: 'rotated-token-sensitive' })
    await expect(getTikTokConnectionStatus(rotated)).resolves.toMatchObject({
      state: 'configuration_changed',
      pixelIdConfigured: true,
      tokenConfigured: true,
    })
    await expect(requireVerifiedTikTokConnection(rotated)).rejects.toThrow('TIKTOK_CONNECTION_UNVERIFIED')
  })

  it('拒绝 dev、非法测试码和 TikTok 未接受的测试事件', async () => {
    await expect(verifyTikTokConnection(connectionEnv({ APP_ENV: 'dev' }), {
      testEventCode: TEST_EVENT_CODE,
    })).rejects.toThrow('TIKTOK_VERIFICATION_PRODUCTION_ONLY')

    await expect(verifyTikTokConnection(connectionEnv(), {
      testEventCode: 'x',
    })).rejects.toThrow('TIKTOK_TEST_EVENT_CODE_INVALID')

    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      code: 40105,
      message: 'Unauthorized',
      request_id: 'request-rejected',
    }), { status: 401 }))
    await expect(verifyTikTokConnection(connectionEnv(), {
      testEventCode: TEST_EVENT_CODE,
      fetchFn,
    })).rejects.toThrow('TIKTOK_VERIFICATION_REJECTED')
    expect(await db.prepare('SELECT COUNT(*) AS count FROM tiktok_connection_verifications')
      .first<number>('count')).toBe(0)
  })
})

function successfulTikTokFetch() {
  let request = 0
  return vi.fn<typeof fetch>(async () => {
    request += 1
    return new Response(JSON.stringify({
      code: 0,
      message: 'OK',
      request_id: `request-${request}`,
    }), { status: 200 })
  })
}

function connectionEnv(overrides: Partial<Bindings> = {}) {
  return {
    DB: db,
    APP_ENV: 'production',
    SITE_URL: 'https://616618.xyz',
    TIKTOK_EVENTS_ACCESS_TOKEN: ACCESS_TOKEN,
    ...overrides,
  } as Pick<Bindings, 'DB' | 'APP_ENV' | 'SITE_URL' | 'TIKTOK_EVENTS_ACCESS_TOKEN'>
}

async function connectionRevision() {
  return db.prepare(`SELECT revision FROM ad_platform_connections WHERE provider = 'tiktok'`)
    .first<string>('revision')
}
