import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0056-'))
const database = join(tempDir, 'integrity.sqlite')
const migration = readFileSync(new URL('./0056_attribution_fact_source_integrity.sql', import.meta.url), 'utf8')

before(() => {
  execute(setupSql())
  execute(migration)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0056 归因事实可信来源完整性 migration', () => {
  it('删除旧 UTM 推测事实并级联清除 Delivery 与 Receipt', () => {
    assert.deepEqual(rows(`
      SELECT id, attribution_provider, attribution_source
      FROM attribution_conversion_facts
      ORDER BY id;
    `), [
      { id: 'fact_meta', attribution_provider: 'meta', attribution_source: 'click_id' },
      { id: 'fact_none', attribution_provider: null, attribution_source: 'none' },
    ])
    assert.deepEqual(rows('SELECT id FROM attribution_deliveries ORDER BY id;'), [{ id: 'delivery_meta' }])
    assert.deepEqual(rows('SELECT id FROM attribution_provider_receipts ORDER BY id;'), [{ id: 'receipt_meta' }])
    assert.deepEqual(rows('SELECT delivery_id FROM attribution_outbox ORDER BY delivery_id;'), [{ delivery_id: 'delivery_meta' }])
  })

  it('数据库拒绝任何 provider 与来源不一致的新事实', () => {
    assert.throws(() => insertFact('fact_invalid_utm', 'tiktok', 'utm_alias'), /ATTRIBUTION_FACT_SOURCE_INVALID/)
    assert.throws(() => insertFact('fact_invalid_none', null, 'click_id'), /ATTRIBUTION_FACT_SOURCE_INVALID/)
    assert.throws(() => insertFact('fact_invalid_provider', 'unknown', 'managed_link'), /ATTRIBUTION_FACT_SOURCE_INVALID/)
    assert.doesNotThrow(() => insertFact('fact_tiktok', 'tiktok', 'managed_link'))
    assert.doesNotThrow(() => insertFact('fact_conflict', null, 'conflict'))
  })

  it('数据库拒绝把可信事实更新为推测来源', () => {
    assert.throws(() => execute(`
      UPDATE attribution_conversion_facts
      SET attribution_source = 'utm_alias'
      WHERE id = 'fact_meta';
    `), /ATTRIBUTION_FACT_SOURCE_INVALID/)
  })
})

function insertFact(id, provider, source) {
  const providerSql = provider === null ? 'NULL' : `'${provider}'`
  execute(`
    INSERT INTO attribution_conversion_facts (
      id, attribution_provider, attribution_source
    ) VALUES ('${id}', ${providerSql}, '${source}');
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
  const output = execFileSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' }).trim()
  return output ? JSON.parse(output) : []
}

function setupSql() {
  return `
  PRAGMA foreign_keys = ON;

  CREATE TABLE attribution_conversion_facts (
    id TEXT PRIMARY KEY,
    attribution_provider TEXT,
    attribution_source TEXT NOT NULL
  );
  CREATE TABLE attribution_deliveries (
    id TEXT PRIMARY KEY,
    fact_id TEXT NOT NULL REFERENCES attribution_conversion_facts(id) ON DELETE CASCADE
  );
  CREATE TABLE attribution_provider_receipts (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES attribution_deliveries(id) ON DELETE CASCADE
  );
  CREATE TABLE attribution_outbox (
    delivery_id TEXT PRIMARY KEY REFERENCES attribution_deliveries(id) ON DELETE CASCADE
  );

  INSERT INTO attribution_conversion_facts VALUES
    ('fact_meta', 'meta', 'click_id'),
    ('fact_none', NULL, 'none'),
    ('fact_tiktok_legacy', 'tiktok', 'utm_alias');
  INSERT INTO attribution_deliveries VALUES
    ('delivery_meta', 'fact_meta'),
    ('delivery_tiktok_legacy', 'fact_tiktok_legacy');
  INSERT INTO attribution_provider_receipts VALUES
    ('receipt_meta', 'delivery_meta'),
    ('receipt_tiktok_legacy', 'delivery_tiktok_legacy');
  INSERT INTO attribution_outbox VALUES
    ('delivery_meta'),
    ('delivery_tiktok_legacy');
  `
}
