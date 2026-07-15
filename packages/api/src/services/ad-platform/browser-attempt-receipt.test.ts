import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { loadAttributionCryptoKeys } from '../../utils/attribution-crypto'
import {
  issueBrowserAttemptReceiptToken,
  recordBrowserAttemptReceipt,
  verifyBrowserAttemptReceiptToken,
} from './browser-attempt-receipt'

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const ROTATED_KEY = Buffer.alloc(32, 9).toString('base64')
const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const identity = { deliveryId: 'delivery_meta_browser', provider: 'meta' as const, externalEventId: 'mg3_contact_123' }
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'browser-attempt-receipt' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM attribution_provider_receipts;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_conversion_facts;
    DELETE FROM attribution_platform_connections;
  `)
  await db.batch([
    db.prepare(`INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled, public_config_json,
      rollout_target_percentage, rollout_effective_percentage, connection_revision, credential_revision
    ) VALUES ('conn_meta', 'meta', 1, 'production', 1, 1, '{}', 100, 100, 'rev_1', 'cred_1')`),
    db.prepare(`INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id, attribution_provider,
      attribution_source, occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
    ) VALUES ('fact_meta', 'Contact', 'live', ?, 'meta', 'context', '2026-07-15T00:00:00.000Z', 'dedupe_meta', '{}', '{}')`).bind(identity.externalEventId),
    db.prepare(`INSERT INTO attribution_deliveries (
      id, fact_id, connection_id, provider, transport, status, destination
    ) VALUES (?, 'fact_meta', 'conn_meta', 'meta', 'browser', 'planned', 'Contact')`).bind(identity.deliveryId),
  ])
})

afterAll(async () => miniflare.dispose())

describe('Browser attempt 签名幂等回执', () => {
  it('只接受与 provider、delivery 和 external event 绑定的签名', async () => {
    const keys = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const receiptToken = await issueBrowserAttemptReceiptToken(keys, identity)

    await expect(verifyBrowserAttemptReceiptToken(keys, { ...identity, receiptToken })).resolves.toBe(true)
    await expect(verifyBrowserAttemptReceiptToken(keys, {
      ...identity,
      deliveryId: 'delivery_tampered',
      receiptToken,
    })).resolves.toBe(false)
  })

  it('主密钥轮换后仍可验证 previous 签发的在途指令', async () => {
    const beforeRotation = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const receiptToken = await issueBrowserAttemptReceiptToken(beforeRotation, identity)
    const rotated = await loadAttributionCryptoKeys({
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: ROTATED_KEY,
      AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS: MASTER_KEY,
    })

    await expect(verifyBrowserAttemptReceiptToken(rotated, { ...identity, receiptToken })).resolves.toBe(true)
  })

  it('超过 10 分钟后拒绝过期回执', async () => {
    const keys = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const receiptToken = await issueBrowserAttemptReceiptToken(keys, identity, 1_783_600_000)

    await expect(verifyBrowserAttemptReceiptToken(keys, { ...identity, receiptToken }, 1_783_600_600)).resolves.toBe(true)
    await expect(verifyBrowserAttemptReceiptToken(keys, { ...identity, receiptToken }, 1_783_600_601)).resolves.toBe(false)
  })

  it('重复回执只写入一次，不把 planned 直接当 attempted', async () => {
    const keys = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const receiptToken = await issueBrowserAttemptReceiptToken(keys, identity)

    await expect(recordBrowserAttemptReceipt({ db, keys, ...identity, receiptToken })).resolves.toMatchObject({ accepted: true, created: true })
    await expect(recordBrowserAttemptReceipt({ db, keys, ...identity, receiptToken })).resolves.toMatchObject({ accepted: true, created: false })
    expect((await db.prepare(`SELECT COUNT(*) AS count FROM attribution_provider_receipts`).first<{ count: number }>())?.count).toBe(1)
    expect((await db.prepare(`SELECT status FROM attribution_deliveries WHERE id = ?`).bind(identity.deliveryId).first<{ status: string }>())?.status).toBe('planned')
  })

  it('跨平台或伪造 token fail closed', async () => {
    const keys = await loadAttributionCryptoKeys({ AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY })
    const receiptToken = await issueBrowserAttemptReceiptToken(keys, identity)

    await expect(recordBrowserAttemptReceipt({ db, keys, deliveryId: identity.deliveryId, provider: 'tiktok', receiptToken })).resolves.toEqual({ accepted: false, created: false })
    await expect(recordBrowserAttemptReceipt({ db, keys, ...identity, receiptToken: `${receiptToken}x` })).resolves.toEqual({ accepted: false, created: false })
  })
})
