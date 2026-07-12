import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

const migrationDir = dirname(fileURLToPath(import.meta.url))
const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-meta-0035-'))
const database = join(tempDir, 'migration.sqlite')

before(() => {
  executeSql(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE analytics_conversion_actions (id TEXT PRIMARY KEY);
    INSERT INTO analytics_conversion_actions (id) VALUES ('conv_legacy');
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY,
      conversion_action_id TEXT NOT NULL REFERENCES analytics_conversion_actions(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      skip_reason TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      has_fbp INTEGER NOT NULL DEFAULT 0,
      has_fbc INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_analytics_conversion_deliveries_external
      ON analytics_conversion_deliveries(channel, external_event_id);
    CREATE INDEX idx_analytics_conversion_deliveries_status
      ON analytics_conversion_deliveries(status, updated_at);
    INSERT INTO analytics_conversion_deliveries (
      id, conversion_action_id, channel, external_event_id, event_name, status,
      attempt_count, has_fbp, has_fbc, sent_at, created_at, updated_at
    ) VALUES (
      'cdlv_legacy', 'conv_legacy', 'meta_capi', 'event_legacy', 'Contact', 'sent',
      2, 1, 1, '2026-07-09 00:01:00', '2026-07-09 00:00:00', '2026-07-09 00:01:00'
    );
  `)
  executeSql(readFileSync(join(migrationDir, '0035_meta_capi_delivery_recovery.sql'), 'utf8'))
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0035 Meta CAPI delivery recovery migration', () => {
  it('保留既有 delivery 全部业务字段', () => {
    const row = queryJson(`
      SELECT id, conversion_action_id, channel, external_event_id, event_name,
        status, attempt_count, has_fbp, has_fbc, sent_at, created_at, updated_at
      FROM analytics_conversion_deliveries WHERE id = 'cdlv_legacy';
    `)[0]

    assert.deepEqual(row, {
      id: 'cdlv_legacy',
      conversion_action_id: 'conv_legacy',
      channel: 'meta_capi',
      external_event_id: 'event_legacy',
      event_name: 'Contact',
      status: 'sent',
      attempt_count: 2,
      has_fbp: 1,
      has_fbc: 1,
      sent_at: '2026-07-09 00:01:00',
      created_at: '2026-07-09 00:00:00',
      updated_at: '2026-07-09 00:01:00',
    })
  })

  it('保留既有索引并新增 pending recovery 索引', () => {
    const names = queryJson("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analytics_conversion_deliveries' ORDER BY name;")
      .map(row => row.name)

    assert.deepEqual(names, [
      'idx_analytics_conversion_deliveries_external',
      'idx_analytics_conversion_deliveries_recovery',
      'idx_analytics_conversion_deliveries_status',
      'sqlite_autoindex_analytics_conversion_deliveries_1',
    ])
  })

  it('旧数据与新写入都使用保守默认值且不要求持久化 userData', () => {
    const columns = queryJson('PRAGMA table_info(analytics_conversion_deliveries);')
    const byName = new Map(columns.map(column => [column.name, column]))
    assert.equal(byName.get('tracking_mode')?.dflt_value, "'disabled'")
    assert.equal(byName.get('queue_attempt_count')?.dflt_value, '0')

    executeSql(`
      INSERT INTO analytics_conversion_actions (id) VALUES ('conv_new');
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, channel, external_event_id, event_name
      ) VALUES ('cdlv_new', 'conv_new', 'meta_capi', 'event_new', 'Lead');
    `)
    const row = queryJson(`
      SELECT tracking_mode, queue_enqueued_at, queue_attempt_count, duplicate_suppressed_at
      FROM analytics_conversion_deliveries WHERE id = 'cdlv_new';
    `)[0]
    assert.deepEqual(row, {
      tracking_mode: 'disabled',
      queue_enqueued_at: null,
      queue_attempt_count: 0,
      duplicate_suppressed_at: null,
    })
  })
})

function executeSql(sql) {
  execFileSync('sqlite3', [database], { input: sql, encoding: 'utf8' })
}

function queryJson(sql) {
  const output = execFileSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' })
  return JSON.parse(output || '[]')
}
