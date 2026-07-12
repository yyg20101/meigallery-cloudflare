import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings } from '../index'
import {
  consumeMetaResourceAttestationTicket,
  issueMetaResourceAttestationTicket,
} from './meta-resource-attestation-ticket'

const COMMIT = 'a'.repeat(40)
const NONCE = `nonce_${'b'.repeat(64)}`
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000042' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec('CREATE TABLE ad_platform_connections (provider TEXT PRIMARY KEY, destination_id TEXT NOT NULL);')
  const sql = readFileSync(new URL('../../migrations/0042_meta_resource_attestation_tickets.sql', import.meta.url), 'utf8')
  for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run()
}, 30_000)

beforeEach(async () => {
  await db.prepare('DELETE FROM meta_resource_attestation_tickets').run()
  await db.prepare('DELETE FROM ad_platform_connections').run()
  await db.prepare("INSERT INTO ad_platform_connections (provider, destination_id) VALUES ('meta', '1234567890')").run()
})

afterAll(async () => miniflare.dispose())

describe('Meta resource attestation 一次性 ticket', () => {
  it('只持久化 ticket 摘要，最终消费绑定 owner/environment/commit/nonce 且原子一次性', async () => {
    const issued = await issueMetaResourceAttestationTicket(env(), 41, NONCE, {
      now: '2026-07-11T00:00:00.000Z',
      randomBytes: new Uint8Array(32).fill(7),
    })
    expect(issued.ticket).toMatch(/^mrat_[0-9a-f]{64}$/)
    expect(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt)).toBe(60_000)

    const row = await db.prepare('SELECT * FROM meta_resource_attestation_tickets').first<Record<string, unknown>>()
    expect(row).toMatchObject({ environment: 'production', commit_sha: COMMIT, nonce: NONCE, owner_user_id: 41, consumed_at: null })
    expect(JSON.stringify(row)).not.toContain(issued.ticket)

    const [first, second] = await Promise.allSettled([
      consumeMetaResourceAttestationTicket(env(), issued.ticket, NONCE, { now: '2026-07-11T00:00:30.000Z' }),
      consumeMetaResourceAttestationTicket(env(), issued.ticket, NONCE, { now: '2026-07-11T00:00:30.000Z' }),
    ])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    const success = first.status === 'fulfilled' ? first.value : second.status === 'fulfilled' ? second.value : null
    expect(success?.attestation).toMatchObject({ environment: 'production', commitSha: COMMIT, nonce: NONCE })
  })

  it('错误 nonce/environment/commit、过期和重放全部 fail closed', async () => {
    const issued = await issueMetaResourceAttestationTicket(env(), 41, NONCE, {
      now: '2026-07-11T00:00:00.000Z', randomBytes: new Uint8Array(32).fill(8),
    })
    await expect(consumeMetaResourceAttestationTicket(env(), issued.ticket, `nonce_${'c'.repeat(64)}`, { now: '2026-07-11T00:00:30.000Z' })).rejects.toThrow()
    await expect(consumeMetaResourceAttestationTicket(env({ APP_ENV: 'dev' }), issued.ticket, NONCE, { now: '2026-07-11T00:00:30.000Z' })).rejects.toThrow()
    await expect(consumeMetaResourceAttestationTicket(env({ RELEASE_COMMIT: 'd'.repeat(40) }), issued.ticket, NONCE, { now: '2026-07-11T00:00:30.000Z' })).rejects.toThrow()
    await expect(consumeMetaResourceAttestationTicket(env(), issued.ticket, NONCE, { now: '2026-07-11T00:01:00.000Z' })).rejects.toThrow()
  })
})

function env(overrides: Partial<Bindings> = {}) {
  return {
    DB: db,
    APP_ENV: 'production',
    RELEASE_COMMIT: COMMIT,
    META_CAPI_ACCESS_TOKEN: 'production-token',
    META_CAPI_TEST_EVENT_CODE: 'production-code',
    META_CAPI_DATA_KEY_CURRENT: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  } as unknown as Bindings
}
