import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { revokeAdAttributionContext } from './ad-attribution-consent'

let miniflare: Miniflare
let db: D1Database
const CONTEXT_ID = `ctx_${'a'.repeat(32)}`

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000404' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(`
    CREATE TABLE attribution_conversion_facts (id TEXT PRIMARY KEY, attribution_context_id TEXT);
    CREATE TABLE attribution_deliveries (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE attribution_outbox (delivery_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL);
  `)
})

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM attribution_outbox'),
    db.prepare('DELETE FROM attribution_deliveries'),
    db.prepare('DELETE FROM attribution_conversion_facts'),
    db.prepare(`INSERT INTO attribution_conversion_facts (id, attribution_context_id) VALUES ('fact_current', '${CONTEXT_ID}'), ('fact_other', 'ctx_other')`),
    db.prepare(`INSERT INTO attribution_deliveries (id, fact_id, status) VALUES
      ('planned', 'fact_current', 'planned'), ('queued', 'fact_current', 'queued'), ('retrying', 'fact_current', 'retrying'),
      ('accepted', 'fact_current', 'accepted'), ('processed', 'fact_current', 'processed'), ('other', 'fact_other', 'planned')`),
    db.prepare(`INSERT INTO attribution_outbox (delivery_id, ciphertext) VALUES
      ('planned', 'ciphertext'), ('queued', 'ciphertext'), ('retrying', 'ciphertext'),
      ('accepted', 'ciphertext'), ('processed', 'ciphertext'), ('other', 'ciphertext')`),
  ])
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('广告归因同意撤回', () => {
  it('原子取消尚未完成的投递并删除对应 Outbox，不篡改已接受历史', async () => {
    await expect(revokeAdAttributionContext(db, CONTEXT_ID)).resolves.toEqual({ cancelledDeliveryCount: 3 })

    const deliveries = await db.prepare('SELECT id, status FROM attribution_deliveries ORDER BY id').all<{ id: string; status: string }>()
    expect(deliveries.results).toEqual([
      { id: 'accepted', status: 'accepted' }, { id: 'other', status: 'planned' }, { id: 'planned', status: 'cancelled' },
      { id: 'processed', status: 'processed' }, { id: 'queued', status: 'cancelled' }, { id: 'retrying', status: 'cancelled' },
    ])
    const outbox = await db.prepare('SELECT delivery_id FROM attribution_outbox ORDER BY delivery_id').all<{ delivery_id: string }>()
    expect(outbox.results).toEqual([{ delivery_id: 'accepted' }, { delivery_id: 'other' }, { delivery_id: 'processed' }])
  })
})
