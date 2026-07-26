import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0060-'))
const database = join(tempDir, 'control-plane-cleanup.sqlite')
const cleanupMigration = readFileSync(
  new URL('./0060_attribution_control_plane_cleanup.sql', import.meta.url),
  'utf8',
)

before(() => {
  execute(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE attribution_conversion_facts (
      id TEXT PRIMARY KEY,
      fact_origin TEXT NOT NULL
    );
    CREATE TABLE attribution_platform_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'disabled',
      browser_enabled INTEGER NOT NULL DEFAULT 0,
      server_enabled INTEGER NOT NULL DEFAULT 0,
      public_config_json TEXT NOT NULL DEFAULT '{}',
      attribution_window_days INTEGER NOT NULL DEFAULT 30,
      rollout_target_percentage INTEGER NOT NULL DEFAULT 0,
      rollout_effective_percentage INTEGER NOT NULL DEFAULT 0,
      connection_revision TEXT NOT NULL DEFAULT 'scope',
      credential_revision TEXT NOT NULL DEFAULT 'credential'
    );
    CREATE TABLE attribution_event_bindings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE attribution_credentials (
      id TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL
    );
    CREATE TABLE attribution_privacy_policy (
      id TEXT PRIMARY KEY,
      policy_version INTEGER NOT NULL
    );
    CREATE TABLE analytics_tracking_sources (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      ad_provider TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE attribution_verifications (
      id TEXT PRIMARY KEY
    );
    CREATE INDEX idx_attribution_verifications_connection
      ON attribution_verifications(id);
    CREATE TABLE attribution_deliveries (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE attribution_outbox (
      delivery_id TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL
    );
    CREATE TABLE attribution_business_outbox (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE INDEX idx_attribution_business_outbox_due
      ON attribution_business_outbox(status);
    CREATE INDEX idx_attribution_business_outbox_completed
      ON attribution_business_outbox(status, id);
    CREATE INDEX idx_attribution_business_outbox_runtime_due
      ON attribution_business_outbox(status, id);
    CREATE TABLE attribution_runtime_cutover (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL
    );
    CREATE TABLE attribution_runtime_cutover_commands (
      idempotency_key TEXT PRIMARY KEY
    );
    INSERT INTO attribution_runtime_cutover (id, owner, owner_epoch)
      VALUES ('global', 'old', 1);
    CREATE TRIGGER attribution_runtime_fact_insert_guard
    BEFORE INSERT ON attribution_conversion_facts
    WHEN (SELECT owner FROM attribution_runtime_cutover WHERE id = 'global') <> 'old'
    BEGIN
      SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_FACT_WRITE_FORBIDDEN');
    END;
    CREATE TRIGGER attribution_runtime_connection_update_guard
    BEFORE UPDATE ON attribution_platform_connections
    WHEN (SELECT owner FROM attribution_runtime_cutover WHERE id = 'global') <> 'old'
    BEGIN
      SELECT RAISE(ABORT, 'ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN');
    END;
    INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled,
      rollout_target_percentage, rollout_effective_percentage
    ) VALUES ('conn_meta', 'meta', 1, 'test', 1, 1, 10, 10);
    INSERT INTO attribution_conversion_facts (id, fact_origin)
      VALUES ('fact_1', 'live');
    INSERT INTO attribution_deliveries (id, payload)
      VALUES ('delivery_1', 'preserved');
    INSERT INTO attribution_outbox (delivery_id, ciphertext)
      VALUES ('delivery_1', 'preserved');
  `)
  execute(`
    UPDATE attribution_runtime_cutover
    SET owner = 'new', owner_epoch = 2
    WHERE id = 'global';
  `)
  execute(cleanupMigration)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0060 归因控制面清理 migration', () => {
  it('删除旧 Worker 所有权、业务 Outbox 和验证工作流表', () => {
    const names = rows(`
      SELECT name
      FROM sqlite_master
      WHERE name IN (
        'attribution_business_outbox',
        'attribution_runtime_cutover',
        'attribution_runtime_cutover_commands',
        'attribution_verifications'
      )
      ORDER BY name;
    `)
    assert.deepEqual(names, [])
  })

  it('删除旧写入冻结触发器并恢复单一 API 运行时写入', () => {
    assert.deepEqual(rows(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'attribution_runtime_%';
    `), [])
    assert.doesNotThrow(() => execute(`
      INSERT INTO attribution_conversion_facts (id, fact_origin)
      VALUES ('fact_after_cleanup', 'live');
      UPDATE attribution_platform_connections
      SET browser_enabled = 0
      WHERE id = 'conn_meta';
    `))
  })

  it('保留事实、投递与加密 Outbox，并归零废弃 rollout 数据', () => {
    assert.deepEqual(rows(`
      SELECT id, fact_origin
      FROM attribution_conversion_facts
      WHERE id = 'fact_1';
    `), [{ id: 'fact_1', fact_origin: 'live' }])
    assert.deepEqual(rows(`
      SELECT delivery.id, delivery.payload, outbox.ciphertext
      FROM attribution_deliveries AS delivery
      JOIN attribution_outbox AS outbox ON outbox.delivery_id = delivery.id;
    `), [{ id: 'delivery_1', payload: 'preserved', ciphertext: 'preserved' }])
    assert.deepEqual(rows(`
      SELECT mode, rollout_target_percentage, rollout_effective_percentage
      FROM attribution_platform_connections
      WHERE id = 'conn_meta';
    `), [{
      mode: 'production',
      rollout_target_percentage: 0,
      rollout_effective_percentage: 0,
    }])
  })
})

function execute(sql) {
  return execFileSync('sqlite3', [database], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function rows(sql) {
  const output = execFileSync(
    'sqlite3',
    ['-json', database, sql],
    { encoding: 'utf8' },
  ).trim()
  return output ? JSON.parse(output) : []
}
