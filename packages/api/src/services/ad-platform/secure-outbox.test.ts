import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { enqueueAttributionDelivery, purgeExpiredAttributionOutbox } from './secure-outbox'

let miniflare: Miniflare
let db: D1Database
beforeAll(async () => { miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'secure-outbox' } }); db = (await miniflare.getBindings<{ DB: D1Database }>()).DB; await db.exec(schema()) })
afterAll(async () => { await miniflare.dispose() })
beforeEach(async () => { await db.exec('DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries;') })

describe('统一归因安全 Outbox', () => {
  it('仅发送最小 Queue message，密文继续留在 D1 等待 consumer 终态清理', async () => {
    await seed()
    const send = vi.fn()
    await expect(enqueueAttributionDelivery({ DB: db, AD_META_QUEUE: { send } }, { provider: 'meta', deliveryId: 'delivery_meta' })).resolves.toBe('enqueued')
    expect(send).toHaveBeenCalledWith({ schemaVersion: 1, deliveryId: 'delivery_meta', provider: 'meta' })
    expect(await db.prepare('SELECT ciphertext FROM attribution_outbox').first()).not.toBeNull()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('queued')
  })

  it('Queue 发送失败后不回滚事实或删除 Outbox，并标记为 retrying', async () => {
    await seed()
    await expect(enqueueAttributionDelivery({ DB: db, AD_META_QUEUE: { send: async () => { throw new Error('network') } } }, { provider: 'meta', deliveryId: 'delivery_meta' })).resolves.toBe('failed')
    expect(await db.prepare('SELECT ciphertext FROM attribution_outbox').first()).not.toBeNull()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('retrying')
  })

  it('过期密文转为 rejected 后删除，不再保留可解密数据', async () => {
    await seed("datetime('now', '-1 minute')")
    await expect(purgeExpiredAttributionOutbox(db)).resolves.toBe(1)
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('rejected')
  })
})

async function seed(expiresAt = "'2099-01-01T00:00:00.000Z'") {
  await db.batch([
    db.prepare("INSERT INTO attribution_deliveries (id, provider, transport, status) VALUES ('delivery_meta', 'meta', 'server', 'planned')"),
    db.prepare(`INSERT INTO attribution_outbox VALUES ('delivery_meta', 'meta', 1, '0123456789abcdef', 'AQIDBAUGBwgJCgsM', 'cipher', 'AQIDBAUGBwgJCgsMDQ4PEA', ${expiresAt}, datetime('now'), datetime('now'))`),
  ])
}
function schema() { return `CREATE TABLE attribution_deliveries (id TEXT PRIMARY KEY, provider TEXT NOT NULL, transport TEXT NOT NULL, status TEXT NOT NULL, queue_attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '', queued_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE TABLE attribution_outbox (delivery_id TEXT PRIMARY KEY, provider TEXT NOT NULL, schema_version INTEGER NOT NULL, key_id TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);` }
