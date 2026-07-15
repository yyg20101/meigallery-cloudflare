import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { recoverAttributionOutbox } from './recovery'

let miniflare: Miniflare
let db: D1Database
beforeAll(async () => { miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'recovery' } }); db = (await miniflare.getBindings<{ DB: D1Database }>()).DB; await db.exec(schema()) })
afterAll(async () => { await miniflare.dispose() })
beforeEach(async () => { await db.exec('DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries;') })

describe('归因 Outbox 恢复', () => {
  it('重新入队 planned 与超时 queued，跳过新鲜 lease，并仅发送最小消息', async () => {
    await seed('planned', 'delivery_planned')
    await seed('queued', 'delivery_stale', "datetime('now', '-6 minutes')")
    await seed('queued', 'delivery_fresh')
    const send = vi.fn()
    const report = await recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send } } as never, 100)
    expect(report).toEqual({ scanned: 2, enqueued: 2, failed: 0, expired: 0 })
    expect(send).toHaveBeenNthCalledWith(1, { schemaVersion: 1, deliveryId: 'delivery_planned', provider: 'meta' })
    expect(send).toHaveBeenNthCalledWith(2, { schemaVersion: 1, deliveryId: 'delivery_stale', provider: 'meta' })
  })

  it('Queue 发送失败不回滚事实或密文，下一轮可恢复', async () => {
    await seed('planned', 'delivery_retry')
    const failed = await recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send: async () => { throw new Error('network') } } } as never, 100)
    expect(failed.failed).toBe(1)
    expect(await db.prepare("SELECT delivery_id FROM attribution_outbox WHERE delivery_id = 'delivery_retry'").first()).not.toBeNull()
    await db.prepare("UPDATE attribution_deliveries SET updated_at = datetime('now', '-6 minutes') WHERE id = 'delivery_retry'").run()
    const send = vi.fn()
    await expect(recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send } } as never, 100)).resolves.toMatchObject({ enqueued: 1 })
  })

  it('过期 Outbox 变为 rejected 并删除密文', async () => {
    await seed('planned', 'delivery_expired', undefined, "datetime('now', '-1 minute')")
    await expect(recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send: vi.fn() } } as never, 100)).resolves.toMatchObject({ expired: 1 })
    expect((await db.prepare("SELECT status FROM attribution_deliveries WHERE id = 'delivery_expired'").first<{ status: string }>())?.status).toBe('rejected')
    expect(await db.prepare("SELECT delivery_id FROM attribution_outbox WHERE delivery_id = 'delivery_expired'").first()).toBeNull()
  })
})

async function seed(status: string, id: string, updatedAt = "datetime('now')", expiresAt = "'2099-01-01T00:00:00.000Z'") {
  await db.batch([
    db.prepare(`INSERT INTO attribution_deliveries (id, provider, transport, status, updated_at) VALUES (?, 'meta', 'server', ?, ${updatedAt})`).bind(id, status),
    db.prepare(`INSERT INTO attribution_outbox VALUES (?, 'meta', 1, '0123456789abcdef', 'AQIDBAUGBwgJCgsM', 'cipher', 'AQIDBAUGBwgJCgsMDQ4PEA', ${expiresAt}, datetime('now'), datetime('now'))`).bind(id),
  ])
}
function schema() { return `CREATE TABLE attribution_deliveries (id TEXT PRIMARY KEY, provider TEXT NOT NULL, transport TEXT NOT NULL, status TEXT NOT NULL, queue_attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '', queued_at TEXT, updated_at TEXT NOT NULL); CREATE TABLE attribution_outbox (delivery_id TEXT PRIMARY KEY, provider TEXT NOT NULL, schema_version INTEGER NOT NULL, key_id TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);` }
