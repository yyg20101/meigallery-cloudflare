import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0062-'))
const database = join(tempDir, 'garbage-cleanup.sqlite')
const migration = readFileSync(
  new URL('./0062_attribution_runtime_garbage_cleanup.sql', import.meta.url),
  'utf8',
)

before(() => {
  execute(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE attribution_platform_connections (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE attribution_quality_snapshots (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES attribution_platform_connections(id),
      collected_at TEXT NOT NULL
    );

    CREATE TABLE attribution_usage_daily (
      id TEXT PRIMARY KEY
    );

    INSERT INTO attribution_platform_connections (id, updated_at) VALUES
      ('conn_meta', '2026-07-23 06:33:27'),
      ('conn_tiktok', '2026-07-16 12:04:28');

    INSERT INTO attribution_quality_snapshots (id, connection_id, collected_at) VALUES
      ('meta_old', 'conn_meta', '2026-07-17T00:00:59.000Z'),
      ('meta_current', 'conn_meta', '2026-07-27T00:00:53.000Z'),
      ('tiktok_current', 'conn_tiktok', '2026-07-16T12:04:28.000Z');

    INSERT INTO attribution_usage_daily (id) VALUES ('unused');
  `)
  execute(migration)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0062 归因运行时垃圾清理 migration', () => {
  it('删除早于当前连接配置的质量快照', () => {
    assert.deepEqual(rows(`
      SELECT id
      FROM attribution_quality_snapshots
      ORDER BY id;
    `), [
      { id: 'meta_current' },
      { id: 'tiktok_current' },
    ])
  })

  it('删除未被运行时使用的 usage 表', () => {
    assert.deepEqual(rows(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'attribution_usage_daily';
    `), [])
  })

  it('保持外键完整', () => {
    assert.deepEqual(rows('PRAGMA foreign_key_check;'), [])
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
  const output = execFileSync('sqlite3', ['-json', database, sql], {
    encoding: 'utf8',
  }).trim()
  return output ? JSON.parse(output) : []
}
