import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0059-'))
const database = join(tempDir, 'runtime-cutover.sqlite')
const businessOutboxMigration = readFileSync(
  new URL('./0058_attribution_business_outbox.sql', import.meta.url),
  'utf8',
)
const migration = readFileSync(
  new URL('./0059_attribution_runtime_cutover.sql', import.meta.url),
  'utf8',
)

before(() => {
  execute(`
    CREATE TABLE attribution_conversion_facts (
      id TEXT PRIMARY KEY,
      fact_origin TEXT NOT NULL
    );
    CREATE TABLE attribution_platform_connections (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
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
  `)
  execute(businessOutboxMigration)
  execute(`
    INSERT INTO attribution_business_outbox (
      id, event_id, dedupe_key, event_name, payload_json
    ) VALUES (
      'registration_existing',
      'registration_existing',
      'registration_existing',
      'CompleteRegistration',
      '{"schemaVersion":1,"eventId":"registration_existing","eventName":"CompleteRegistration","occurredAt":"2026-07-24T00:00:00.000Z","pagePath":"/register","dedupeKey":"registration_existing","sourceContextToken":null,"consent":{"marketingAllowed":false,"adUserDataAllowed":false,"adPersonalizationAllowed":false},"payload":{"userId":1}}'
    );
  `)
  execute(migration)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0059 归因运行时单写门禁 migration', () => {
  it('默认 old/epoch=1 且为既有注册 outbox 标记旧 owner', () => {
    assert.deepEqual(rows(`
      SELECT owner, owner_epoch, changed_by
      FROM attribution_runtime_cutover
      WHERE id = 'global';
    `), [{
      owner: 'old',
      owner_epoch: 1,
      changed_by: null,
    }])
    assert.deepEqual(rows(`
      SELECT routing_owner, owner_epoch
      FROM attribution_business_outbox
      WHERE id = 'registration_existing';
    `), [{
      routing_owner: 'old',
      owner_epoch: 1,
    }])
  })

  it('draining 禁止旧 live fact 但允许切换前注册历史补偿', () => {
    transition('draining', 2)
    assert.throws(() => execute(`
      INSERT INTO attribution_conversion_facts (id, fact_origin)
      VALUES ('fact_live_blocked', 'live');
    `), /ATTRIBUTION_RUNTIME_OLD_FACT_WRITE_FORBIDDEN/)
    assert.doesNotThrow(() => execute(`
      INSERT INTO attribution_conversion_facts (id, fact_origin)
      VALUES ('fact_history_draining', 'historical_backfill');
    `))
  })

  it('new 后旧事实表完全只读', () => {
    transition('new', 3)
    assert.throws(() => execute(`
      INSERT INTO attribution_conversion_facts (id, fact_origin)
      VALUES ('fact_history_blocked', 'historical_backfill');
    `), /ATTRIBUTION_RUNTIME_OLD_FACT_WRITE_FORBIDDEN/)
  })

  it('draining/new 冻结旧连接、凭证、映射、隐私和广告来源', () => {
    assert.throws(() => execute(`
      INSERT INTO attribution_platform_connections (id)
      VALUES ('connection_blocked');
    `), /ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN/)
    assert.throws(() => execute(`
      INSERT INTO attribution_event_bindings (id)
      VALUES ('binding_blocked');
    `), /ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN/)
    assert.throws(() => execute(`
      INSERT INTO attribution_credentials (id, ciphertext)
      VALUES ('credential_blocked', 'ciphertext');
    `), /ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN/)
    assert.throws(() => execute(`
      INSERT INTO attribution_privacy_policy (id, policy_version)
      VALUES ('global', 1);
    `), /ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN/)
    assert.throws(() => execute(`
      INSERT INTO analytics_tracking_sources (
        id, channel, ad_provider
      ) VALUES ('source_blocked', 'ad', 'meta');
    `), /ATTRIBUTION_RUNTIME_OLD_CONFIG_WRITE_FORBIDDEN/)

    assert.doesNotThrow(() => execute(`
      INSERT INTO analytics_tracking_sources (
        id, channel, ad_provider
      ) VALUES ('source_organic', 'organic', NULL);
    `))
  })
})

function transition(owner, epoch) {
  execute(`
    UPDATE attribution_runtime_cutover
    SET
      owner = ${quote(owner)},
      owner_epoch = ${Number(epoch)},
      changed_by = 1,
      changed_at = '2026-07-24T00:0${Number(epoch)}:00.000Z'
    WHERE id = 'global';
  `)
}

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

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
