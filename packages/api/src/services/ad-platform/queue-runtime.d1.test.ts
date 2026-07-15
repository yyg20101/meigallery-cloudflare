import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { encryptAttributionValue, loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import { handleAttributionQueueBatch } from './queue-runtime'

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'queue-runtime' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(schema())
})
afterAll(async () => { await miniflare.dispose() })
beforeEach(async () => { await db.exec('DELETE FROM attribution_provider_receipts; DELETE FROM attribution_incidents; DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_platform_connections;') })

describe('统一广告平台 Queue 运行时', () => {
  it('重复消费已接受 Delivery 时只 ack，不重复调用 Adapter', async () => {
    await seed('accepted')
    const deliver = vi.fn()
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env(), { deliver })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
  })

  it.each([
    ['queue', 'meigallery-ad-meta', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'tiktok' }],
    ['fact', 'meigallery-ad-meta', { schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' }, 'tiktok'],
  ] as const)('%s provider 不一致时写 critical incident、ack 且不调用 Adapter', async (_kind, queue, body, factProvider) => {
    await seed('queued', factProvider)
    const deliver = vi.fn()
    const message = queueMessage(body)
    await handleAttributionQueueBatch(batch([message], queue), env(), { deliver })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
    expect((await db.prepare("SELECT severity FROM attribution_incidents").first<{ severity: string }>())?.severity).toBe('critical')
  })

  it.each([
    ['connection', "UPDATE attribution_platform_connections SET provider = 'tiktok'"],
    ['outbox', "UPDATE attribution_outbox SET provider = 'tiktok'"],
  ])('%s provider 不一致时也安全终止，不会跨平台调用 Adapter', async (_kind, sql) => {
    await seed('queued')
    await db.prepare(sql).run()
    const message = queueMessage()
    const deliver = vi.fn()
    await handleAttributionQueueBatch(batch([message]), env(), { deliver })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
    expect((await db.prepare('SELECT severity FROM attribution_incidents').first<{ severity: string }>())?.severity).toBe('critical')
  })

  it('429/5xx 等 retryable 在三次消费中均 retry，DLQ 消费后终态清理密文', async () => {
    await seed('queued')
    const deliver = vi.fn().mockResolvedValue({ classification: 'retryable' })
    for (const attempts of [1, 2, 3]) {
      await db.prepare("UPDATE attribution_deliveries SET updated_at = datetime('now', '-6 minutes')").run()
      const message = queueMessage(undefined, attempts)
      await handleAttributionQueueBatch(batch([message]), env(), { deliver, readCredential: async () => 'secret' })
      expect(message.retry).toHaveBeenCalledOnce()
    }
    expect(deliver).toHaveBeenCalledTimes(3)
    const dlq = queueMessage()
    await handleAttributionQueueBatch(batch([dlq], 'meigallery-ad-meta-dlq'), env())
    expect(dlq.ack).toHaveBeenCalledOnce()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('dead_letter')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
  })

  it.each(['rejected', 'credential_invalid', 'destination_invalid'] as const)('%s 直接拒绝并清理 Outbox', async classification => {
    await seed('queued')
    const message = queueMessage()
    await handleAttributionQueueBatch(batch([message]), env(), { deliver: vi.fn().mockResolvedValue({ classification, receipt: { status: 400 } }), readCredential: async () => 'secret' })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('rejected')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
  })

  it('超时 lease 可被后续消费重新取得并完成投递', async () => {
    await seed('retrying')
    await db.prepare("UPDATE attribution_deliveries SET updated_at = datetime('now', '-6 minutes')").run()
    const message = queueMessage(undefined, 1)
    const deliver = vi.fn().mockResolvedValue({ classification: 'accepted', receipt: { status: 200 } })
    await handleAttributionQueueBatch(batch([message]), env(), { deliver, readCredential: async () => 'secret' })
    expect(deliver).toHaveBeenCalledOnce()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('accepted')
  })
})

function env() { return { DB: db, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY } }
function batch(messages: ReturnType<typeof queueMessage>[], queue = 'meigallery-ad-meta') { return { queue, messages } as unknown as MessageBatch<{ schemaVersion: 1; deliveryId: string; provider: 'meta' | 'tiktok' | 'google' }> }
function queueMessage(body = { schemaVersion: 1 as const, deliveryId: 'delivery_meta', provider: 'meta' as const }, attempts = 1) { return { body, attempts, ack: vi.fn(), retry: vi.fn() } }
async function seed(status: 'queued' | 'retrying' | 'accepted', factProvider = 'meta') {
  await db.batch([
    db.prepare("INSERT INTO attribution_platform_connections VALUES ('conn_meta', 'meta', '{\"pixelId\":\"12345\"}', 'revision_1', 'credential_1')"),
    db.prepare("INSERT INTO attribution_conversion_facts VALUES ('fact_meta', 'CompleteRegistration', ?, '2026-07-15T00:00:00.000Z')").bind(factProvider),
    db.prepare("INSERT INTO attribution_deliveries (id, fact_id, connection_id, provider, transport, status, destination, updated_at) VALUES ('delivery_meta', 'fact_meta', 'conn_meta', 'meta', 'server', ?, 'destination_1', datetime('now'))").bind(status),
    await encryptedOutboxStatement(),
  ])
}
async function encryptedOutboxStatement() {
  const envelope = await encryptAttributionValue({
    keys: await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }),
    aad: { purpose: 'outbox', provider: 'meta', subjectId: 'fact_meta', revision: 'revision_1' },
    plaintext: JSON.stringify({ canonicalEvent: 'CompleteRegistration', externalEventId: `mg3_${'a'.repeat(43)}`, eventTime: 1784073600, pageUrl: 'https://gallery.example.test/register', destination: 'destination_1', matchSignals: { fbp: 'fbp_1' } }),
  })
  return db.prepare('INSERT INTO attribution_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))').bind('delivery_meta', 'meta', envelope.schemaVersion, envelope.keyId, envelope.iv, envelope.ciphertext, envelope.tag, '2099-01-01T00:00:00.000Z')
}
function schema() { return `
  CREATE TABLE attribution_platform_connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, public_config_json TEXT NOT NULL, connection_revision TEXT NOT NULL, credential_revision TEXT NOT NULL);
  CREATE TABLE attribution_conversion_facts (id TEXT PRIMARY KEY, canonical_event TEXT NOT NULL, attribution_provider TEXT, occurred_at TEXT NOT NULL);
  CREATE TABLE attribution_deliveries (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL, transport TEXT NOT NULL, status TEXT NOT NULL, destination TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, queue_attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '', queued_at TEXT, accepted_at TEXT, processed_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE attribution_outbox (delivery_id TEXT PRIMARY KEY, provider TEXT NOT NULL, schema_version INTEGER NOT NULL, key_id TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE attribution_provider_receipts (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, provider TEXT NOT NULL, receipt_type TEXT NOT NULL, status TEXT NOT NULL, receipt_json TEXT NOT NULL, received_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE attribution_incidents (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL, trigger_code TEXT NOT NULL, summary TEXT NOT NULL, evidence_json TEXT NOT NULL, opened_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
` }
