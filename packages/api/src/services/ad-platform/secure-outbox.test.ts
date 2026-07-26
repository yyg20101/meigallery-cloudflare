import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { enqueueAttributionDelivery, purgeExpiredAttributionOutbox } from './secure-outbox'

const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const CLEANUP_MIGRATION = readFileSync(new URL('../../../migrations/0061_attribution_source_router_cleanup.sql', import.meta.url), 'utf8')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'secure-outbox' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
  await db.exec(CLEANUP_MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})
afterAll(async () => { await miniflare.dispose() })
beforeEach(async () => { await db.exec('DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_platform_connections;') })

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

  it('Queue send 与诊断 UPDATE 连续失败也吞掉，留给 recovery', async () => {
    await seed()
    const diagnosticFailureDb = {
      prepare(sql: string) {
        if (sql.includes("SET status = 'retrying'")) throw new Error('D1 diagnostic unavailable')
        return db.prepare(sql)
      },
      batch: db.batch.bind(db),
    } as unknown as D1Database
    await expect(enqueueAttributionDelivery({ DB: diagnosticFailureDb, AD_META_QUEUE: { send: async () => { throw new Error('queue unavailable') } } }, { provider: 'meta', deliveryId: 'delivery_meta' })).resolves.toBe('failed')
    expect(await db.prepare('SELECT ciphertext FROM attribution_outbox').first()).not.toBeNull()
  })

  it.each([
    ['过期', "datetime('now', '-1 minute')"],
    ['不可解析', "'not-a-date'"],
  ])('%s 密文转为 rejected 后删除，不再保留可解密数据', async (_name, expiresAt) => {
    await seed(expiresAt)
    await expect(purgeExpiredAttributionOutbox(db)).resolves.toBe(1)
    expect(await db.prepare('SELECT delivery_id FROM attribution_outbox').first()).toBeNull()
    expect((await db.prepare('SELECT status FROM attribution_deliveries').first<{ status: string }>())?.status).toBe('rejected')
  })
})

async function seed(expiresAt = "'2099-01-01T00:00:00.000Z'") {
  await db.batch([
    db.prepare("INSERT INTO attribution_platform_connections (id, provider, public_config_json, outbox_scope) VALUES ('conn_meta', 'meta', '{}', 'outbox_scope_1')"),
    db.prepare("INSERT INTO attribution_conversion_facts (id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source, occurred_at, dedupe_key, analytics_dimensions_json) VALUES ('fact_meta', 'Contact', 'live', 'mg3_fact_meta', 'meta', 'click_id', '2026-07-15T00:00:00.000Z', 'dedupe_meta', '{}')"),
    db.prepare("INSERT INTO attribution_deliveries (id, fact_id, connection_id, provider, transport, status) VALUES ('delivery_meta', 'fact_meta', 'conn_meta', 'meta', 'server', 'planned')"),
    db.prepare(`INSERT INTO attribution_outbox (delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at) VALUES ('delivery_meta', 'meta', 1, '0123456789abcdef', 'AQIDBAUGBwgJCgsM', 'cipher', 'AQIDBAUGBwgJCgsMDQ4PEA', ${expiresAt})`),
  ])
}
