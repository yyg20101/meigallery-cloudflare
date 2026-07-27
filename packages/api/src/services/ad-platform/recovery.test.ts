import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { recoverAttributionOutbox } from './recovery'

const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const CLEANUP_MIGRATION = readFileSync(new URL('../../../migrations/0061_attribution_source_router_cleanup.sql', import.meta.url), 'utf8')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'recovery' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
  await db.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY);')
  await db.exec(CLEANUP_MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})
afterAll(async () => { await miniflare.dispose() })
beforeEach(async () => { await db.exec('DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_platform_connections;') })

describe('归因 Outbox 恢复', () => {
  it('重新入队 planned 与长时间未完成的 queued/retrying，跳过新鲜状态', async () => {
    await seed('planned', 'planned')
    await seed('queued', 'queued_stale', "datetime('now', '-6 minutes')")
    await seed('retrying', 'retrying_stale', "datetime('now', '-6 minutes')")
    await seed('queued', 'queued_fresh')
    const send = vi.fn()
    const report = await recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send } } as never, 100)
    expect(report).toEqual({ scanned: 3, enqueued: 3, failed: 0, expired: 0 })
    expect(send).toHaveBeenNthCalledWith(1, { schemaVersion: 1, deliveryId: 'delivery_planned', provider: 'meta' })
    expect(send).toHaveBeenNthCalledWith(2, { schemaVersion: 1, deliveryId: 'delivery_queued_stale', provider: 'meta' })
    expect(send).toHaveBeenNthCalledWith(3, { schemaVersion: 1, deliveryId: 'delivery_retrying_stale', provider: 'meta' })
  })

  it('重叠 Cron 依靠 stale CAS，同一 Delivery 只发送一次', async () => {
    await seed('planned', 'overlap')
    const sendGate = deferred<void>()
    const send = vi.fn(() => sendGate.promise)
    const first = recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send } } as never, 100)
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    await expect(recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send } } as never, 100)).resolves.toEqual({ scanned: 0, enqueued: 0, failed: 0, expired: 0 })
    sendGate.resolve()
    await first
    expect(send).toHaveBeenCalledOnce()
  })

  it('Queue 发送失败不回滚事实或密文，stale 后下一轮可恢复', async () => {
    await seed('planned', 'retry')
    const failed = await recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send: async () => { throw new Error('network') } } } as never, 100)
    expect(failed.failed).toBe(1)
    expect(await db.prepare("SELECT delivery_id FROM attribution_outbox WHERE delivery_id = 'delivery_retry'").first()).not.toBeNull()
    await db.prepare("UPDATE attribution_deliveries SET updated_at = datetime('now', '-6 minutes') WHERE id = 'delivery_retry'").run()
    const send = vi.fn()
    await expect(recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send } } as never, 100)).resolves.toMatchObject({ enqueued: 1 })
  })

  it.each([
    ['过期', "datetime('now', '-1 minute')"],
    ['不可解析', "'not-a-date'"],
  ])('%s Outbox 变为 rejected 并删除密文', async (_name, expiresAt) => {
    await seed('planned', `expiry_${_name}`, undefined, expiresAt)
    await expect(recoverAttributionOutbox({ DB: db, AD_META_QUEUE: { send: vi.fn() } } as never, 100)).resolves.toMatchObject({ expired: 1 })
    const id = `delivery_expiry_${_name}`
    expect((await db.prepare('SELECT status FROM attribution_deliveries WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('rejected')
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox WHERE delivery_id = ?').bind(id).first()).toBeNull()
  })
})

async function seed(status: 'planned' | 'queued' | 'retrying', suffix: string, updatedAt = "datetime('now')", expiresAt = "'2099-01-01T00:00:00.000Z'") {
  const connectionId = 'conn_meta'
  const factId = `fact_${suffix}`
  const deliveryId = `delivery_${suffix}`
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO attribution_platform_connections (id, provider, public_config_json, outbox_scope) VALUES (?, 'meta', '{}', 'outbox_scope_1')").bind(connectionId),
    db.prepare("INSERT INTO attribution_conversion_facts (id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source, occurred_at, dedupe_key, analytics_dimensions_json) VALUES (?, 'Contact', 'live', ?, 'meta', 'click_id', '2026-07-15T00:00:00.000Z', ?, '{}')").bind(factId, `mg3_${suffix}`, `dedupe_${suffix}`),
    db.prepare(`INSERT INTO attribution_deliveries (id, fact_id, connection_id, provider, transport, status, updated_at) VALUES (?, ?, ?, 'meta', 'server', ?, ${updatedAt})`).bind(deliveryId, factId, connectionId, status),
    db.prepare(`INSERT INTO attribution_outbox (delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES (?, 'meta', 1, '0123456789abcdef', 'AQIDBAUGBwgJCgsM', 'cipher', 'AQIDBAUGBwgJCgsMDQ4PEA', ${expiresAt})`).bind(deliveryId),
  ])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolver => { resolve = resolver })
  return { promise, resolve }
}
