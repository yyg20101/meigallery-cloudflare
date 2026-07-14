import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { Miniflare } from 'miniflare'
import { unstable_splitSqlQuery } from 'wrangler'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'

vi.mock('../../services/meta-connection', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/meta-connection')>(),
  getMetaConnectionStatusWithUsage: vi.fn(async () => ({
    status: { state: 'verified' },
    usage: { rowsRead: 0, rowsWritten: 0, queryCount: 0 },
  })),
}))

const COMMIT = 'a'.repeat(40)
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000043' },
    d1Persist: false,
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await execSql(`
    CREATE TABLE ad_platform_connections (
      provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, mode TEXT NOT NULL,
      browser_enabled INTEGER NOT NULL, server_enabled INTEGER NOT NULL,
      destination_id TEXT NOT NULL, debug_enabled INTEGER NOT NULL,
      rollout_percentage INTEGER NOT NULL, credential_secret_name TEXT NOT NULL,
      revision TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE meta_capi_incidents (
      id TEXT PRIMARY KEY, environment TEXT, status TEXT, severity TEXT, trigger_code TEXT,
      target_rollout_percentage INTEGER, effective_rollout_percentage INTEGER,
      opened_at TEXT, last_observed_at TEXT
    );
    CREATE TABLE meta_connection_verifications (
      environment TEXT PRIMARY KEY, verified_commit TEXT, invalidated_at TEXT, revision TEXT
    );
    CREATE TABLE analytics_release_verifications (
      id TEXT PRIMARY KEY, commit_sha TEXT, environment TEXT, verification_type TEXT,
      status TEXT, summary TEXT, verified_at TEXT, expires_at TEXT
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'meta',
      transport TEXT NOT NULL DEFAULT 'server', status TEXT, error_code TEXT,
      created_at TEXT, rollout_target_percentage INTEGER
    );
    CREATE TABLE admin_audit_logs (
      id TEXT PRIMARY KEY, admin_id INTEGER, action TEXT, target_type TEXT,
      target_id TEXT, before_value TEXT, after_value TEXT
    );
  `)
}, 30_000)

afterAll(async () => miniflare.dispose())

describe('production rollout D1 原子条件', () => {
  it('快照后 mode 并发改为 test 时 UPDATE changes=0 并返回 409', async () => {
    await seedProductionGate()
    const dbWithConcurrentModeChange = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.prepare("UPDATE ad_platform_connections SET mode = 'test' WHERE provider = 'meta'").run()
        return db.batch(statements)
      },
    } as unknown as D1Database
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
    app.use('*', async (c, next) => {
      c.set('userId', 1)
      c.set('userRole', 'owner')
      await next()
    })
    app.route('/api/admin', adminRoutes)

    const response = await app.request('/api/admin/attribution/meta/rollout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percentage: 10, force: false }),
    }, {
      DB: dbWithConcurrentModeChange,
      APP_ENV: 'production',
      RELEASE_COMMIT: COMMIT,
    } as unknown as Bindings)

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('META_CAPI_ROLLOUT_CONFLICT')
    expect(await connectionValue('rollout_percentage')).toBe(0)
    expect(await connectionValue('mode')).toBe('test')
    expect((await db.prepare('SELECT COUNT(*) AS count FROM admin_audit_logs').first<{ count: number }>())?.count).toBe(0)
  })
})

async function seedProductionGate() {
  await db.exec(`
    DELETE FROM ad_platform_connections;
    DELETE FROM meta_capi_incidents;
    DELETE FROM meta_connection_verifications;
    DELETE FROM analytics_release_verifications;
    DELETE FROM analytics_conversion_deliveries;
    DELETE FROM admin_audit_logs;
  `)
  await db.prepare(`
    INSERT INTO ad_platform_connections
      (provider, enabled, mode, browser_enabled, server_enabled, destination_id,
       debug_enabled, rollout_percentage, credential_secret_name, revision)
    VALUES ('meta', 1, 'production', 1, 1, '1234567890', 0, 0,
            'META_CAPI_ACCESS_TOKEN', ?)
  `).bind('1'.repeat(32)).run()
  await db.prepare(`
    INSERT INTO meta_connection_verifications (environment, verified_commit, invalidated_at, revision)
    VALUES ('production', ?, NULL, ?)
  `).bind(COMMIT, '1'.repeat(32)).run()
  await db.prepare(`
    INSERT INTO analytics_release_verifications
      (id, commit_sha, environment, verification_type, status, summary, verified_at, expires_at)
    VALUES ('full', ?, 'production', 'meta_resources', 'passed', ?, datetime('now'), datetime('now', '+1 day'))
  `).bind(COMMIT, JSON.stringify(fullResourceSummary())).run()
  await db.prepare(`
    INSERT INTO analytics_release_verifications
      (id, commit_sha, environment, verification_type, status, summary, verified_at, expires_at)
    VALUES ('live', ?, 'production', 'meta_live', 'passed', '{}', datetime('now'), datetime('now', '+1 day'))
  `).bind(COMMIT).run()
  const inserts = Array.from({ length: 100 }, (_, index) => (
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries
        (id, provider, transport, status, error_code, created_at, rollout_target_percentage)
      VALUES (?, 'meta', 'server', 'sent', '', datetime('now'), 0)
    `).bind(`delivery_${index}`)
  ))
  await db.batch(inserts)
}

async function connectionValue(key: 'rollout_percentage' | 'mode') {
  return (await db.prepare(`SELECT ${key} AS value FROM ad_platform_connections WHERE provider = 'meta'`).first<{ value: number | string }>())?.value
}

async function execSql(sql: string) {
  for (const statement of unstable_splitSqlQuery(sql)) await db.prepare(statement).run()
}

function fullResourceSummary() {
  return {
    schemaVersion: 3,
    verificationPhase: 'full',
    bootstrapReady: false,
    liveAttestation: true,
    migrationsReady: true,
    d1Ready: true,
    r2Ready: true,
    queuesReady: true,
    secretsReady: true,
    migrationsCurrent: true,
    migrationsApplied: true,
    connectionVerified: true,
    capiEnabled: false,
    initialMetaRollout: false,
    noOpenCriticalIncident: true,
    initialRolloutZero: true,
    secureOutboxReady: true,
    previousKeyReferencesExplainable: true,
    rolloutZero: true,
    environmentIsolation: {
      d1: true, r2: true, queue: true, dlq: true,
      pixel: true, token: true, dataKey: true,
    },
  }
}
