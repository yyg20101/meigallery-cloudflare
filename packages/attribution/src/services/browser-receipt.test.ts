import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { clearAttributionRuntimeDatabase } from '../test/attribution-schema'
import { recordBrowserReceipt } from './browser-receipt'

const MIGRATIONS = [
  '../../migrations/0001_attribution_runtime.sql',
  '../../migrations/0002_event_delivery.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
const now = new Date('2026-07-24T00:01:00.000Z')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'browser-receipt' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const migration of MIGRATIONS) {
    await db.exec(migration.replace(/\s*\r?\n\s*/g, ' '))
  }
})

afterAll(async () => {
  await miniflare.dispose()
})

beforeEach(async () => {
  await clearAttributionRuntimeDatabase(db)
  await seedDeliveries()
})

describe('Browser delivery 回执', () => {
  it('重复回执幂等且保留首次 attempted_at', async () => {
    const first = await recordBrowserReceipt(environment(), {
      deliveryId: 'delivery_browser',
      attemptedAt: '2026-07-24T00:00:10.000Z',
    })
    const second = await recordBrowserReceipt(environment(), {
      deliveryId: 'delivery_browser',
      attemptedAt: '2026-07-24T00:00:20.000Z',
    })

    expect(second).toEqual(first)
    expect(await countReceipts()).toBe(1)
    expect(first.attemptedAt).toBe('2026-07-24T00:00:10.000Z')
    expect(await deliveryStatus('delivery_browser')).toBe('accepted')
  })

  it('拒绝把 Server delivery 伪装成 Browser 回执', async () => {
    await expect(recordBrowserReceipt(environment(), {
      deliveryId: 'delivery_server',
      attemptedAt: '2026-07-24T00:00:10.000Z',
    })).rejects.toThrow('ATTRIBUTION_BROWSER_RECEIPT_INVALID')

    expect(await countReceipts()).toBe(0)
  })
})

function environment() {
  return {
    db,
    now: () => now,
  }
}

async function seedDeliveries(): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO attribution_connections (
        id, provider, name, active_version_id
      ) VALUES ('conn_meta', 'meta', 'meta', 'ver_meta')
    `),
    db.prepare(`
      INSERT INTO attribution_connection_versions (
        id, connection_id, provider, status, public_config_json,
        config_hash, created_by, activated_at
      ) VALUES (
        'ver_meta', 'conn_meta', 'meta', 'active', '{}',
        'hash_meta', 1, '2026-07-24T00:00:00.000Z'
      )
    `),
    db.prepare(`
      INSERT INTO attribution_facts (
        id, event_id, event_name, fact_origin, dedupe_hash,
        event_fingerprint,
        connection_id, version_id, provider, external_event_id,
        occurred_at, consent_json, analytics_dimensions_json
      ) VALUES (
        'fact_1', 'evt_1', 'Contact', 'live',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'conn_meta', 'ver_meta', 'meta', 'attr1_event',
        '2026-07-24T00:00:00.000Z', '{}', '{}'
      )
    `),
    delivery('delivery_browser', 'browser'),
    delivery('delivery_server', 'server'),
  ])
}

function delivery(
  id: string,
  transport: 'browser' | 'server',
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO attribution_deliveries (
      id, fact_id, connection_id, version_id, provider,
      transport, destination, external_event_id, status
    ) VALUES (?, 'fact_1', 'conn_meta', 'ver_meta', 'meta', ?, ?, ?, 'planned')
  `).bind(
    id,
    transport,
    `meta_${transport}`,
    'attr1_event',
  )
}

async function countReceipts(): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS value
    FROM attribution_browser_receipts
  `).first<{ value: number }>()
  return Number(row?.value ?? 0)
}

async function deliveryStatus(id: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT status
    FROM attribution_deliveries
    WHERE id = ?
  `).bind(id).first<{ status: string }>()
  return row?.status ?? null
}
