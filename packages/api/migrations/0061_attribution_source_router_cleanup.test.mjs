import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0061-'))
const database = join(tempDir, 'source-router-cleanup.sqlite')
const migrationDirectory = new URL('.', import.meta.url)
const preCleanupMigrations = readdirSync(migrationDirectory)
  .filter(file => /^\d{4}_.+\.sql$/.test(file) && file < '0061_')
  .sort()
  .map(file => read(`./${file}`))
  .join('\n')
const cleanupMigration = read('./0061_attribution_source_router_cleanup.sql')

before(() => {
  execute(`PRAGMA foreign_keys = ON; ${preCleanupMigrations}`)
  execute(`
    PRAGMA foreign_keys = ON;
    DELETE FROM attribution_outbox;
    DELETE FROM attribution_provider_receipts;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_event_bindings;
    DELETE FROM attribution_credentials;
    DELETE FROM attribution_incidents;
    DELETE FROM attribution_quality_snapshots;
    DELETE FROM attribution_conversion_facts;
    DELETE FROM attribution_platform_connections;

    INSERT OR REPLACE INTO site_settings (key, value) VALUES
      ('facebook_pixel_enabled', 'true'),
      ('facebook_pixel_id', '"123456789"'),
      ('meta_capi_rollout_percentage', '10'),
      ('site_name', '"MeiGallery"');

    INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled,
      public_config_json, attribution_window_days,
      rollout_target_percentage, rollout_effective_percentage,
      connection_revision, credential_revision
    ) VALUES (
      'conn_meta', 'meta', 1, 'production', 1, 1,
      '{"pixelId":"123456789"}', 30, 0, 0,
      'stable_outbox_scope', 'credential_new'
    );

    INSERT INTO attribution_event_bindings (
      id, connection_id, provider, canonical_event, enabled,
      browser_destination, server_destination, mapping_revision, config_json
    ) VALUES
      ('binding_meta_contact', 'conn_meta', 'meta', 'Contact', 1, 'Contact', 'Contact', 'mapping_1', '{}'),
      ('binding_meta_registration', 'conn_meta', 'meta', 'CompleteRegistration', 1, 'CompleteRegistration', 'CompleteRegistration', 'mapping_1', '{}');

    INSERT INTO attribution_credentials (
      id, connection_id, provider, credential_type, schema_version,
      key_id, iv, ciphertext, tag, fingerprint, credential_revision, updated_at
    ) VALUES
      ('credential_old', 'conn_meta', 'meta', 'access_token', 1, 'aaaaaaaaaaaaaaaa', 'iv-old', 'cipher-old', 'tag-old', 'fingerprint-old', 'credential_old', '2026-07-25 00:00:00'),
      ('credential_new', 'conn_meta', 'meta', 'access_token', 1, 'bbbbbbbbbbbbbbbb', 'iv-new', 'cipher-new', 'tag-new', 'fingerprint-new', 'credential_new', '2026-07-26 00:00:00');

    INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id,
      attribution_provider, attribution_source, attribution_context_id,
      occurred_at, dedupe_key, consent_snapshot_json, analytics_dimensions_json
    ) VALUES (
      'fact_meta_contact', 'Contact', 'live', 'mg3_meta_contact',
      'meta', 'click_id', 'ctx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-07-26T00:00:00.000Z', 'dedupe_meta_contact',
      '{"marketingAllowed":true}', '{"path":"/contact"}'
    );

    INSERT INTO attribution_deliveries (
      id, fact_id, connection_id, provider, transport, status, destination
    ) VALUES (
      'delivery_meta_contact', 'fact_meta_contact', 'conn_meta',
      'meta', 'server', 'queued', 'Contact'
    );

    INSERT INTO attribution_outbox (
      delivery_id, provider, schema_version, key_id, iv, ciphertext, tag, expires_at
    ) VALUES (
      'delivery_meta_contact', 'meta', 1, 'bbbbbbbbbbbbbbbb',
      'iv-outbox', 'cipher-outbox', 'tag-outbox', '2026-07-27T00:00:00.000Z'
    );
  `)
  execute(`PRAGMA foreign_keys = ON; ${cleanupMigration}`)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0061 来源路由归因瘦身 migration', () => {
  it('物理删除授权、rollout 和版本字段', () => {
    assert.deepEqual(columnNames('attribution_platform_connections'), [
      'id', 'provider', 'enabled', 'browser_enabled', 'server_enabled',
      'public_config_json', 'outbox_scope', 'created_at', 'updated_at',
    ])
    assert.deepEqual(columnNames('attribution_event_bindings'), [
      'id', 'connection_id', 'canonical_event', 'enabled',
      'browser_destination', 'server_destination', 'created_at', 'updated_at',
    ])
    assert.deepEqual(columnNames('attribution_credentials'), [
      'id', 'connection_id', 'credential_type', 'schema_version',
      'key_id', 'iv', 'ciphertext', 'tag', 'fingerprint',
      'encryption_context', 'created_by', 'created_at', 'updated_at',
    ])
    assert.equal(columnNames('attribution_conversion_facts').includes('consent_snapshot_json'), false)
    assert.deepEqual(rows(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'attribution_privacy_policy';
    `), [])
    assert.deepEqual(rows(`
      SELECT key FROM site_settings
      WHERE key IN (
        'facebook_pixel_enabled',
        'facebook_pixel_id',
        'meta_capi_rollout_percentage',
        'site_name'
      )
      ORDER BY key;
    `), [{ key: 'site_name' }])
  })

  it('保留有效连接、最新凭证、事实、投递与加密 Outbox', () => {
    assert.deepEqual(rows(`
      SELECT provider, outbox_scope
      FROM attribution_platform_connections;
    `), [{ provider: 'meta', outbox_scope: 'stable_outbox_scope' }])
    assert.deepEqual(rows(`
      SELECT id, encryption_context, ciphertext
      FROM attribution_credentials;
    `), [{
      id: 'credential_new',
      encryption_context: 'credential_new',
      ciphertext: 'cipher-new',
    }])
    assert.deepEqual(rows(`
      SELECT fact.id, fact.attribution_provider, delivery.status, outbox.ciphertext
      FROM attribution_conversion_facts AS fact
      JOIN attribution_deliveries AS delivery ON delivery.fact_id = fact.id
      JOIN attribution_outbox AS outbox ON outbox.delivery_id = delivery.id;
    `), [{
      id: 'fact_meta_contact',
      attribution_provider: 'meta',
      status: 'queued',
      ciphertext: 'cipher-outbox',
    }])
  })

  it('迁移后外键与平台隔离约束完整', () => {
    assert.deepEqual(rows('PRAGMA foreign_key_check;'), [])
    assert.throws(() => execute(`
      INSERT INTO attribution_deliveries (
        id, fact_id, connection_id, provider, transport, status, destination
      ) VALUES (
        'delivery_cross_platform', 'fact_meta_contact', 'conn_meta',
        'tiktok', 'browser', 'planned', 'Contact'
      );
    `), /ATTRIBUTION_PROVIDER_MISMATCH/)
  })
})

function read(file) {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
}

function execute(sql) {
  return execFileSync('sqlite3', [database], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function rows(sql) {
  const output = execFileSync('sqlite3', ['-json', database, sql], {
    encoding: 'utf8',
  }).trim()
  return output ? JSON.parse(output) : []
}

function columnNames(table) {
  return rows(`PRAGMA table_info(${table});`).map(column => column.name)
}
