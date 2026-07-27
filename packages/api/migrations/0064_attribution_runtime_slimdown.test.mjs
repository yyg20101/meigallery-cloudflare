import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0064-'))
const database = join(tempDir, 'runtime-slimdown.sqlite')
const migrationDirectory = new URL('.', import.meta.url)
const migrationFiles = readdirSync(migrationDirectory)
  .filter(file => /^\d{4}_.+\.sql$/.test(file))
  .sort()
const contractFile = '0064_attribution_runtime_slimdown.sql'
const preContractMigrations = migrationFiles
  .filter(file => file < contractFile)
  .map(file => read(`./${file}`))
  .join('\n')
const contractMigration = read(`./${contractFile}`)

before(() => {
  execute(`PRAGMA foreign_keys = ON; ${preContractMigrations}`)
  execute(`
    PRAGMA foreign_keys = ON;
    INSERT INTO users (id, email, password_hash, role, status)
    VALUES (9001, 'runtime-slimdown@example.com', 'hash', 'owner', 'active');

    INSERT INTO invite_codes (
      id, code_hash, display_code, name, channel, status, created_by
    ) VALUES (
      'invite_0064', '${'a'.repeat(64)}', 'A1B2C3', '迁移验证', 'manual', 'active', 9001
    );

    INSERT INTO analytics_visitors (
      id, first_seen_at, last_seen_at, first_source_channel, first_source_name,
      first_landing_path, first_invite_code_id, user_id, consent_state
    ) VALUES (
      'visitor_0064', '2026-07-01 00:00:00', '2026-07-01 00:05:00',
      'ad', 'meta', '/', 'invite_0064', 9001, 'granted'
    );

    INSERT INTO analytics_sessions (
      id, visitor_id, user_id, started_at, ended_at, entry_path, exit_path,
      source_channel, source_name, device_type, page_view_count, event_count
    ) VALUES (
      'session_0064', 'visitor_0064', 9001, '2026-07-01 00:00:00',
      '2026-07-01 00:05:00', '/', '/', 'ad', 'meta', 'mobile', 1, 1
    );

    INSERT INTO analytics_page_summaries (
      id, date, visitor_id, session_id, user_id, route_name, path,
      first_viewed_at, page_view_count
    ) VALUES (
      'page_0064', '2026-07-01', 'visitor_0064', 'session_0064', 9001,
      'home', '/', '2026-07-01 00:00:00', 1
    );

    INSERT INTO analytics_session_summaries (
      session_id, date, visitor_id, user_id, started_at, ended_at,
      source_channel, source_name, entry_path, exit_path, page_view_count
    ) VALUES (
      'session_0064', '2026-07-01', 'visitor_0064', 9001,
      '2026-07-01 00:00:00', '2026-07-01 00:05:00',
      'ad', 'meta', '/', '/', 1
    );

    INSERT INTO analytics_events (
      id, event_name, occurred_at, visitor_id, session_id, user_id,
      route_name, path, source_channel, device_type, consent_state
    ) VALUES (
      'event_0064', 'contact_method_click', '2026-07-01 00:04:00',
      'visitor_0064', 'session_0064', 9001, 'home', '/', 'ad', 'mobile', 'granted'
    );

    INSERT INTO invite_registrations (
      id, invite_code_id, visitor_id, session_id, invited_user_id,
      source_channel, landing_path, registered_at
    ) VALUES (
      'registration_0064', 'invite_0064', 'visitor_0064', 'session_0064',
      9001, 'invite', '/', '2026-07-01 00:05:00'
    );

    INSERT INTO attribution_platform_connections (
      id, provider, enabled, browser_enabled, server_enabled,
      public_config_json, outbox_scope
    ) VALUES (
      'connection_meta_0064', 'meta', 1, 1, 1,
      '{"pixelId":"123456789"}', 'scope_meta_0064'
    );

    INSERT INTO attribution_quality_snapshots (
      id, connection_id, provider, canonical_event, metric_key,
      metric_value, collection_status, error_category, collected_at
    ) VALUES
      (
        'quality_success_0064', 'connection_meta_0064', 'meta', 'Contact',
        'emq_score', '8.5', 'success', '', '2026-07-01 00:00:00'
      ),
      (
        'quality_error_0064', 'connection_meta_0064', 'meta', 'Contact',
        'emq_score', NULL, 'error', 'invalid_request', '2026-07-02 00:00:00'
      );
  `)
  execute(`PRAGMA foreign_keys = ON; ${contractMigration}`)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0064 归因运行时瘦身 migration', () => {
  it('完整迁移链连续', () => {
    assert.deepEqual(
      migrationFiles.map(file => Number(file.slice(0, 4))),
      Array.from({ length: 64 }, (_, index) => index + 1),
    )
  })

  it('物理删除 consent 设置和字段', () => {
    assert.equal(rows(`
      SELECT COUNT(*) AS count
      FROM site_settings
      WHERE key = 'analytics_consent_mode';
    `)[0].count, 0)
    assert.doesNotMatch(columnNames('analytics_visitors').join(','), /consent_state/)
    assert.doesNotMatch(columnNames('analytics_events').join(','), /consent_state/)
  })

  it('保留分析与邀请数据和外键', () => {
    for (const [table, idColumn, id] of [
      ['analytics_visitors', 'id', 'visitor_0064'],
      ['analytics_sessions', 'id', 'session_0064'],
      ['analytics_page_summaries', 'id', 'page_0064'],
      ['analytics_session_summaries', 'session_id', 'session_0064'],
      ['analytics_events', 'id', 'event_0064'],
      ['invite_registrations', 'id', 'registration_0064'],
    ]) {
      assert.equal(rows(`SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} = '${id}';`)[0].count, 1)
    }
    assert.deepEqual(rows('PRAGMA foreign_key_check;'), [])
  })

  it('仅清除 Meta 失败质量快照', () => {
    assert.deepEqual(rows(`
      SELECT id, collection_status
      FROM attribution_quality_snapshots
      WHERE connection_id = 'connection_meta_0064'
      ORDER BY id;
    `), [{ id: 'quality_success_0064', collection_status: 'success' }])
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
