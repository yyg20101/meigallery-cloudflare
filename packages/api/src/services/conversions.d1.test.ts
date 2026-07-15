import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { recordRegistration } from './conversions'
import { readAttributionConnectionSnapshot } from './ad-platform/connections'

const MASTER_KEY = Buffer.alloc(32).toString('base64')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-05-26', d1Databases: { DB: 'test' } })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(`
    CREATE TABLE attribution_platform_connections (id TEXT PRIMARY KEY, provider TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL, mode TEXT NOT NULL, browser_enabled INTEGER NOT NULL, server_enabled INTEGER NOT NULL, public_config_json TEXT NOT NULL, attribution_window_days INTEGER NOT NULL DEFAULT 30, rollout_target_percentage INTEGER NOT NULL, rollout_effective_percentage INTEGER NOT NULL, connection_revision TEXT NOT NULL, credential_revision TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE attribution_event_bindings (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL, canonical_event TEXT NOT NULL, enabled INTEGER NOT NULL, browser_destination TEXT NOT NULL, server_destination TEXT NOT NULL, mapping_revision TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE attribution_credentials (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL, credential_type TEXT NOT NULL, schema_version INTEGER NOT NULL, key_id TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, fingerprint TEXT NOT NULL, credential_revision TEXT NOT NULL, created_by INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE attribution_conversion_facts (id TEXT PRIMARY KEY, canonical_event TEXT NOT NULL, fact_origin TEXT NOT NULL, external_event_id TEXT UNIQUE, attribution_provider TEXT, attribution_source TEXT NOT NULL, attribution_context_id TEXT, occurred_at TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, consent_snapshot_json TEXT NOT NULL, analytics_dimensions_json TEXT NOT NULL, created_at TEXT);
    CREATE TABLE attribution_deliveries (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, connection_id TEXT NOT NULL, provider TEXT NOT NULL, transport TEXT NOT NULL, status TEXT NOT NULL, destination TEXT NOT NULL, match_signals_json TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, queue_attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '', queued_at TEXT, accepted_at TEXT, processed_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(fact_id, provider, transport));
    CREATE TABLE attribution_outbox (delivery_id TEXT PRIMARY KEY, provider TEXT NOT NULL, schema_version INTEGER NOT NULL, key_id TEXT NOT NULL, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE attribution_fact_audit_logs (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT);
  `)
})

beforeEach(async () => {
  await db.exec(`DELETE FROM attribution_fact_audit_logs; DELETE FROM attribution_outbox; DELETE FROM attribution_deliveries; DELETE FROM attribution_conversion_facts; DELETE FROM attribution_credentials; DELETE FROM attribution_event_bindings; DELETE FROM attribution_platform_connections;`)
  await db.batch([
    db.prepare(`INSERT INTO attribution_platform_connections VALUES ('conn_google', 'google', 1, 'production', 1, 1, '{"tagId":"G-1","customerId":"1","cloudProjectId":"project"}', 30, 100, 100, 'revision_1', 'credential_1', '', '')`),
    db.prepare(`INSERT INTO attribution_event_bindings VALUES ('bind_contact', 'conn_google', 'google', 'Contact', 1, 'contact', 'contact', 'revision_1', '{}', '', '')`),
    db.prepare(`INSERT INTO attribution_event_bindings VALUES ('bind_registration', 'conn_google', 'google', 'CompleteRegistration', 1, 'registration', 'registration', 'revision_1', '{}', '', '')`),
    db.prepare(`INSERT INTO attribution_credentials VALUES ('cred_google', 'conn_google', 'google', 'service_account_json', 1, '0123456789abcdef', 'iv', 'cipher', 'tag', 'fingerprint', 'credential_1', NULL, '', '')`),
  ])
})

afterAll(async () => { await miniflare.dispose() })

describe('统一事实 D1 原子写入', () => {
  it('Fact、Browser/Server Delivery、加密 Outbox 和审计在单个 batch 中写入', async () => {
    expect(await readAttributionConnectionSnapshot(db, 'google')).toMatchObject({ state: 'ready' })
    const result = await recordRegistration({ DB: db, AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY }, {
      userId: 42, visitorId: 'visitor_42', sessionId: 'session_42', occurredAt: '2026-07-15T00:00:00.000Z', consentState: 'granted',
      attributionSource: 'context', attributionContext: { provider: 'google', contextId: 'ctx_0123456789abcdef0123456789abcdef', source: 'click_id' },
    })
    const fact = await db.prepare(`SELECT external_event_id FROM attribution_conversion_facts WHERE id = ?`).bind(result.id).first<{ external_event_id: string }>()
    expect(fact?.external_event_id).toMatch(/^mg3_/)
    expect(result.trackingInstructions).toHaveLength(1)
    expect(result.trackingInstructions[0]?.externalEventId).toBe(fact?.external_event_id)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_deliveries`).first<{ count: number }>())?.count).toBe(2)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_outbox`).first<{ count: number }>())?.count).toBe(1)
    expect((await db.prepare(`SELECT count(*) AS count FROM attribution_fact_audit_logs`).first<{ count: number }>())?.count).toBe(1)
  })
})
