import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import {
  consumeMetaLiveChallenge,
  createMetaLiveChallenge,
  isOpaqueSyntheticEventId,
} from './meta-live-challenge'

const COMMIT = 'a'.repeat(40)
const DATA_KEY = Buffer.alloc(32, 7).toString('base64')

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000041' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  await applyMigration('0041_meta_live_challenges.sql')
  await applyMigration('0045_meta_live_production.sql')
}, 30_000)

beforeEach(async () => {
  await db.prepare('DELETE FROM meta_live_challenges').run()
  await db.prepare('DELETE FROM site_settings').run()
  await db.prepare('DELETE FROM users').run()
  await db.prepare('INSERT INTO users (id) VALUES (1)').run()
  await db.prepare(`
    INSERT INTO site_settings (key, value) VALUES
      ('facebook_pixel_id', '"1234567890"'),
      ('meta_tracking_mode', '"test"')
  `).run()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('Meta live Worker challenge', () => {
  it('由 production Worker 持久化恰好两组 opaque ID，Browser 与 CAPI 使用同组 ID', async () => {
    const challenge = await createMetaLiveChallenge(env(), 1)
    expect(challenge.environment).toBe('production')
    expect(challenge.commitSha).toBe(COMMIT)
    expect(Object.keys(challenge.eventIds).sort()).toEqual(['CompleteRegistration', 'Contact'])
    expect(Object.values(challenge.eventIds).every(isOpaqueSyntheticEventId)).toBe(true)

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body))
      expect(payload.data).toHaveLength(2)
      expect(payload.data.map((event: { event_name: string }) => event.event_name).sort())
        .toEqual(['CompleteRegistration', 'Contact'])
      expect(payload.data.map((event: { event_id: string }) => event.event_id).sort())
        .toEqual(Object.values(challenge.eventIds).sort())
      expect(payload.test_event_code).toBe('test-code')
      return new Response(JSON.stringify({ events_received: 2 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(consumeMetaLiveChallenge(env(), 1, challenge.challengeId)).resolves.toMatchObject({
      challengeId: challenge.challengeId,
      eventsReceived: 2,
      eventDigests: {
        Contact: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        CompleteRegistration: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    })

    const row = await db.prepare('SELECT * FROM meta_live_challenges WHERE id = ?').bind(challenge.challengeId).first<Record<string, unknown>>()
    expect(row).toMatchObject({ status: 'server_sent', contact_event_id: null, complete_registration_event_id: null })
    expect(JSON.stringify(row)).not.toContain(challenge.eventIds.Contact)
    expect(JSON.stringify(row)).not.toContain(challenge.eventIds.CompleteRegistration)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    '13800138000',
    '+8613800138000',
    '138-0013-8000',
    '(138) 0013 8000',
    '0013800138000',
  ])('显式拒绝手机号形态 event ID：%s', value => {
    expect(isOpaqueSyntheticEventId(value)).toBe(false)
  })

  it('重放、错误 commit、过期和非会话 ID 均 fail closed 且不再次 fetch', async () => {
    const challenge = await createMetaLiveChallenge(env(), 1)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await consumeMetaLiveChallenge(env(), 1, challenge.challengeId)

    await expect(consumeMetaLiveChallenge(env(), 1, challenge.challengeId))
      .rejects.toMatchObject({ code: 'META_LIVE_CHALLENGE_INVALID' })
    await expect(consumeMetaLiveChallenge(env({ RELEASE_COMMIT: 'b'.repeat(40) }), 1, challenge.challengeId))
      .rejects.toMatchObject({ code: 'META_LIVE_CHALLENGE_INVALID' })
    await expect(consumeMetaLiveChallenge(env(), 1, 'not-a-session-id'))
      .rejects.toMatchObject({ code: 'META_LIVE_CHALLENGE_INVALID' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('Graph 失败时销毁 challenge，不能重试成成功', async () => {
    const challenge = await createMetaLiveChallenge(env(), 1)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 0 }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(consumeMetaLiveChallenge(env(), 1, challenge.challengeId))
      .rejects.toMatchObject({ code: 'META_LIVE_CHALLENGE_DELIVERY_FAILED' })
    expect(await db.prepare('SELECT id FROM meta_live_challenges WHERE id = ?').bind(challenge.challengeId).first()).toBeNull()
    await expect(consumeMetaLiveChallenge(env(), 1, challenge.challengeId))
      .rejects.toMatchObject({ code: 'META_LIVE_CHALLENGE_INVALID' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

function env(overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'production',
    DB: db,
    META_CAPI_ACCESS_TOKEN: 'production-token',
    META_CAPI_TEST_EVENT_CODE: 'test-code',
    META_CAPI_DATA_KEY_CURRENT: DATA_KEY,
    META_CAPI_QUEUE: { send: vi.fn() },
    RELEASE_COMMIT: COMMIT,
    ...overrides,
  } as unknown as Bindings
}

async function applyMigration(name: string) {
  const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
  for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run()
}
