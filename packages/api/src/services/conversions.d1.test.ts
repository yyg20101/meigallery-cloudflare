import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { recordRegistration, type RecordRegistrationInput } from './conversions'
import { decryptAttributionValue, loadAttributionCryptoKeys } from '../utils/attribution-crypto'

const MASTER_KEY = Buffer.alloc(32).toString('base64')
const MIGRATION = readFileSync(new URL('../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const FBP_PRIVATE = 'fb.1.1700000000000.fbp_private'
const FBC_PRIVATE = 'fb.1.1700000000000.fbc_private'
const SENSITIVE_VALUES = ['fbclid_private', 'ttclid_private', 'gclid_private', 'gbraid_private', 'wbraid_private', FBP_PRIVATE, FBC_PRIVATE, 'ttp_private', '203.0.113.42', 'Private Browser/1.0', 'a'.repeat(64)]
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'test' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

beforeEach(async () => {
  await db.exec(`DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_credentials; DELETE FROM attribution_event_bindings; DELETE FROM attribution_platform_connections;`)
})

afterAll(async () => { await miniflare.dispose() })

describe('统一事实 D1 原子写入', () => {
  it('D1 batch 成功后立即尝试入队，入队失败不回滚事实或 Outbox', async () => {
    await seed('meta')
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'))
    const result = await recordRegistration({ ...env(), AD_META_QUEUE: { send } } as never, registrationInput('meta'))
    expect(send).toHaveBeenCalledWith({ schemaVersion: 1, deliveryId: expect.any(String), provider: 'meta' })
    expect((await db.prepare('SELECT id FROM attribution_conversion_facts WHERE id = ?').bind(result.id).first())?.id).toBe(result.id)
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).not.toBeNull()
    expect((await db.prepare("SELECT status FROM attribution_deliveries WHERE transport = 'server'").first<{ status: string }>())?.status).toBe('retrying')
  })

  it('事实事务提交后，即时入队读取异常不让请求失败', async () => {
    await seed('meta')
    const enqueueReadFailureDb = {
      prepare(sql: string) {
        if (sql.includes('FROM attribution_outbox AS o')) throw new Error('D1 enqueue read unavailable')
        return db.prepare(sql)
      },
      batch: db.batch.bind(db),
    } as unknown as D1Database
    const result = await recordRegistration({ ...env(), DB: enqueueReadFailureDb, AD_META_QUEUE: { send: vi.fn() } } as never, registrationInput('meta'))
    expect(result.created).toBe(true)
    expect((await db.prepare('SELECT id FROM attribution_conversion_facts WHERE id = ?').bind(result.id).first())?.id).toBe(result.id)
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).not.toBeNull()
  })

  it.each([
    ['meta', { fbp: FBP_PRIVATE, fbc: FBC_PRIVATE }, { clientIpAddress: '203.0.113.42', clientUserAgent: 'Private Browser/1.0' }],
    ['tiktok', { ttclid: 'ttclid_private', ttp: 'ttp_private' }, { clientIpAddress: '203.0.113.42', clientUserAgent: 'Private Browser/1.0' }],
    ['google', { gclid: 'gclid_private', gbraid: 'gbraid_private', wbraid: 'wbraid_private' }, {}],
  ] as const)('%s 只将允许的匹配信号写入加密 Outbox', async (provider, expectedMatchSignals, expectedNetworkContext) => {
    await seed(provider)
    const logs = vi.spyOn(console, 'log')
    const result = await recordRegistration(env(), registrationInput(provider))
    logs.mockRestore()

    const fact = await db.prepare(`SELECT * FROM attribution_conversion_facts WHERE id = ?`).bind(result.id).first()
    const deliveries = await db.prepare(`SELECT * FROM attribution_deliveries WHERE fact_id = ?`).bind(result.id).all()
    const outbox = await db.prepare(`SELECT key_id, iv, ciphertext, tag FROM attribution_outbox`).first<{ key_id: string; iv: string; ciphertext: string; tag: string }>()
    const payload = await decryptPayload(provider, result.id, outbox!)
    const publicOutput = JSON.stringify({ result, fact, deliveries, logs: logs.mock.calls })

    expect(result.trackingInstructions).toHaveLength(1)
    expect(payload).toMatchObject({
      canonicalEvent: 'CompleteRegistration',
      eventTime: 1_784_073_600,
      pageUrl: 'https://gallery.example.test/register',
      matchSignals: expectedMatchSignals,
      ...expectedNetworkContext,
      hashedEmail: 'a'.repeat(64),
      consent: {
        consentVersion: 1,
        marketingAllowed: true,
        adUserDataAllowed: true,
        adPersonalizationAllowed: true,
        decidedAt: '2026-07-15T00:00:00.000Z',
      },
    })
    expect(typeof payload.eventTime).toBe('number')
    expect(Object.keys(payload.matchSignals).sort()).toEqual(Object.keys(expectedMatchSignals).sort())
    for (const sensitive of SENSITIVE_VALUES) expect(publicOutput).not.toContain(sensitive)
  })

  it('Meta 只有 fbclid 时以 context issuedAt 构造 fbc', async () => {
    await seed('meta')
    const input = registrationInput('meta')
    input.adPlatformUserData = { fbp: FBP_PRIVATE, ttclid: 'ttclid_private', ttp: 'ttp_private', clientIpAddress: '203.0.113.42', clientUserAgent: 'Private Browser/1.0' }
    const result = await recordRegistration(env(), input)
    const outbox = await db.prepare(`SELECT key_id, iv, ciphertext, tag FROM attribution_outbox`).first<{ key_id: string; iv: string; ciphertext: string; tag: string }>()
    await expect(decryptPayload('meta', result.id, outbox!)).resolves.toMatchObject({ matchSignals: { fbp: FBP_PRIVATE, fbc: 'fb.1.1784534400000.fbclid_private' } })
  })

  it('缺少 Cookie、哈希身份和完整网络上下文时不创建无效 Server Delivery', async () => {
    await seed('meta')
    const input = registrationInput('meta')
    input.hashedEmail = undefined
    input.attributionContext = { ...input.attributionContext!, source: 'managed_link', identifiers: {} }
    input.adPlatformUserData = {}
    const result = await recordRegistration(env(), input)

    expect(result.trackingInstructions).toHaveLength(1)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_deliveries WHERE transport = 'server'`).first<{ count: number }>())?.count).toBe(0)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_outbox`).first<{ count: number }>())?.count).toBe(0)
  })

  it.each([undefined, 'ftp://gallery.example.test'])('SITE_URL 为 %s 时只写 Fact 与 Browser Delivery', async siteUrl => {
    await seed('meta')
    const result = await recordRegistration({ ...env(), SITE_URL: siteUrl }, registrationInput('meta'))
    expect(result.trackingInstructions).toHaveLength(1)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_conversion_facts`).first<{ count: number }>())?.count).toBe(1)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_deliveries WHERE transport = 'browser'`).first<{ count: number }>())?.count).toBe(1)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_deliveries WHERE transport = 'server'`).first<{ count: number }>())?.count).toBe(0)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_outbox`).first<{ count: number }>())?.count).toBe(0)
  })
})

function env() { return { DB: db, SITE_URL: 'https://gallery.example.test', AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY } }
function registrationInput(provider: 'meta' | 'tiktok' | 'google'): RecordRegistrationInput {
  return {
    userId: 42, visitorId: 'visitor_42', sessionId: 'session_42', occurredAt: '2026-07-15T00:00:00.000Z', path: '/register',
    consentSnapshot: { consentVersion: 1, marketingAllowed: true, adUserDataAllowed: true, adPersonalizationAllowed: true, decidedAt: '2026-07-15T00:00:00.000Z' },
    attributionSource: 'context', hashedEmail: 'a'.repeat(64),
    attributionContext: { version: 1, provider, contextId: 'ctx_0123456789abcdef0123456789abcdef', source: 'click_id', identifiers: { fbclid: 'fbclid_private', ttclid: 'ttclid_private', gclid: 'gclid_private', gbraid: 'gbraid_private', wbraid: 'wbraid_private' }, issuedAt: 1_784_534_400, expiresAt: 1_787_126_400 },
    adPlatformUserData: { fbp: FBP_PRIVATE, fbc: FBC_PRIVATE, ttclid: 'ttclid_private', ttp: 'ttp_private', clientIpAddress: '203.0.113.42', clientUserAgent: 'Private Browser/1.0' },
  }
}
async function seed(provider: 'meta' | 'tiktok' | 'google') {
  const config = provider === 'meta'
    ? '{"pixelId":"1234567890123456"}'
    : provider === 'tiktok'
      ? '{"pixelCode":"ABCDEF1234"}'
      : '{"tagId":"AW-12345","customerId":"1","cloudProjectId":"project"}'
  const credentialType = provider === 'google' ? 'service_account_json' : 'access_token'
  await db.batch([
    db.prepare(`INSERT INTO attribution_platform_connections VALUES (?, ?, 1, 'production', 1, 1, ?, 30, 100, 100, 'revision_1', 'credential_1', '', '')`).bind(`conn_${provider}`, provider, config),
    db.prepare(`INSERT INTO attribution_event_bindings VALUES (?, ?, ?, 'Contact', 1, 'contact', 'contact', 'revision_1', '{}', '', '')`).bind(`bind_contact_${provider}`, `conn_${provider}`, provider),
    db.prepare(`INSERT INTO attribution_event_bindings VALUES (?, ?, ?, 'CompleteRegistration', 1, 'registration', 'registration', 'revision_1', '{}', '', '')`).bind(`bind_registration_${provider}`, `conn_${provider}`, provider),
    db.prepare(`INSERT INTO attribution_credentials VALUES (?, ?, ?, ?, 1, '0123456789abcdef', 'iv', 'cipher', 'tag', 'fingerprint', 'credential_1', NULL, '', '')`).bind(`cred_${provider}`, `conn_${provider}`, provider, credentialType),
  ])
}
async function decryptPayload(provider: 'meta' | 'tiktok' | 'google', factId: string, outbox: { key_id: string; iv: string; ciphertext: string; tag: string }) {
  return JSON.parse(await decryptAttributionValue({
    keys: await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }),
    aad: { purpose: 'outbox', provider, subjectId: factId, revision: 'revision_1' },
    envelope: { schemaVersion: 1, keyId: outbox.key_id, iv: outbox.iv, ciphertext: outbox.ciphertext, tag: outbox.tag },
  })) as { eventTime: unknown; matchSignals: Record<string, string>; consent: Record<string, unknown>; clientIpAddress?: string; clientUserAgent?: string }
}
