import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0063-'))
const database = join(tempDir, 'tracking-source-contract.sqlite')
const migrationDirectory = new URL('.', import.meta.url)
const migrationFiles = readdirSync(migrationDirectory)
  .filter(file => /^\d{4}_.+\.sql$/.test(file))
  .sort()
const contractFile = '0063_attribution_tracking_source_contract.sql'
const preContractMigrations = migrationFiles
  .filter(file => file < contractFile)
  .map(file => read(`./${file}`))
  .join('\n')
const contractMigration = read(`./${contractFile}`)
let expectedSources

before(() => {
  execute(`PRAGMA foreign_keys = ON; ${preContractMigrations}`)
  execute(`
    PRAGMA foreign_keys = ON;
    INSERT INTO users (id, email, password_hash, role, status)
    VALUES (9001, 'migration-contract@example.com', 'hash', 'owner', 'active');

    DELETE FROM analytics_tracking_sources;
    INSERT INTO analytics_tracking_sources (
      id, name, channel, slug, link_proof, target_path, utm_source, utm_medium,
      utm_campaign, utm_content, ad_provider, status, note,
      created_by, created_at, updated_at
    ) VALUES
      (
        'source_disabled', '历史停用广告', 'ad', 'ad-disabled-source',
        '${'a'.repeat(64)}', '/', 'ad-disabled-source', 'paid_social',
        'legacy', '', '', 'disabled', '保留停用来源',
        9001, '2026-07-01 01:00:00', '2026-07-02 01:00:00'
      ),
      (
        'source_referral', '合作来源', 'referral', 'referral-partner-source',
        '${'b'.repeat(64)}', '/gallery/example', 'referral-partner-source', 'referral',
        'partner', 'landing-a', '', 'active', '保留非广告来源',
        9001, '2026-07-03 01:00:00', '2026-07-04 01:00:00'
      ),
      (
        'source_meta', 'Meta 美国 BJ', 'ad', 'ad-meta-us-bj',
        '${'c'.repeat(64)}', '/', 'ad-meta-us-bj', 'paid_social',
        'meta-us-bj', 'bj', 'meta', 'active', '生产广告来源',
        9001, '2026-07-05 01:00:00', '2026-07-06 01:00:00'
      );
  `)
  expectedSources = sourceRows()
  execute(`PRAGMA foreign_keys = ON; ${contractMigration}`)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0063 推广来源最终契约 migration', () => {
  it('完整迁移链连续，并只保留当前归因结构', () => {
    assert.deepEqual(
      migrationFiles.map(file => Number(file.slice(0, 4))),
      Array.from({ length: 63 }, (_, index) => index + 1),
    )
    assert.equal(rows(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'attribution_platform_connections',
          'attribution_event_bindings',
          'attribution_credentials',
          'attribution_conversion_facts',
          'attribution_deliveries',
          'attribution_outbox',
          'attribution_provider_receipts',
          'attribution_incidents',
          'attribution_quality_snapshots'
        );
    `)[0].count, 9)
    assert.deepEqual(rows(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND (
          name LIKE 'meta_%'
          OR name LIKE 'tiktok_%'
          OR name LIKE 'attribution_runtime_%'
          OR name IN (
            'attribution_privacy_policy',
            'attribution_verifications',
            'attribution_business_outbox',
            'attribution_usage_daily'
          )
        )
      ORDER BY name;
    `), [])
  })

  it('逐字段保留全部推广来源，并物理删除 proof', () => {
    assert.deepEqual(sourceRows(), expectedSources)
    assert.deepEqual(columnNames('analytics_tracking_sources'), [
      'id', 'name', 'channel', 'slug', 'target_path', 'utm_source',
      'utm_medium', 'utm_campaign', 'utm_content', 'ad_provider',
      'status', 'note', 'created_by', 'created_at', 'updated_at',
    ])
    assert.doesNotMatch(tableSql('analytics_tracking_sources'), /link_proof|mg_proof/i)
  })

  it('保留唯一索引、平台约束与外键完整性', () => {
    assert.deepEqual(rows(`
      SELECT name, [unique] AS is_unique
      FROM pragma_index_list('analytics_tracking_sources')
      WHERE name IN (
        'idx_analytics_tracking_sources_status',
        'idx_analytics_tracking_sources_utm_source',
        'idx_tracking_sources_ad_provider'
      )
      ORDER BY name;
    `), [
      { name: 'idx_analytics_tracking_sources_status', is_unique: 0 },
      { name: 'idx_analytics_tracking_sources_utm_source', is_unique: 1 },
      { name: 'idx_tracking_sources_ad_provider', is_unique: 0 },
    ])
    execute(`
      INSERT INTO analytics_tracking_sources (
        id, name, channel, slug, target_path, utm_source, utm_medium,
        utm_campaign, utm_content, ad_provider, status, note, created_by
      ) VALUES (
        'source_google', 'Google 搜索', 'ad', 'ad-google-search', '/',
        'ad-google-search', 'paid_search', 'google-search', '',
        'google', 'active', '', 9001
      );
    `)
    assert.throws(() => execute(`
      INSERT INTO analytics_tracking_sources (
        id, name, channel, slug, target_path, utm_source, utm_medium,
        utm_campaign, utm_content, ad_provider, status, note, created_by
      ) VALUES (
        'source_invalid', '无效平台', 'ad', 'ad-invalid-provider', '/',
        'ad-invalid-provider', 'paid_social', '', '',
        'unknown', 'active', '', 9001
      );
    `), /CHECK constraint failed/)
    assert.throws(() => execute(`
      INSERT INTO analytics_tracking_sources (
        id, name, channel, slug, target_path, utm_source, utm_medium,
        utm_campaign, utm_content, ad_provider, status, note, created_by
      ) VALUES (
        'source_duplicate', '重复来源', 'ad', 'ad-meta-us-bj', '/',
        'ad-meta-us-bj-copy', 'paid_social', '', '',
        'meta', 'active', '', 9001
      );
    `), /UNIQUE constraint failed/)
    assert.deepEqual(rows('PRAGMA foreign_key_check;'), [])
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

function tableSql(table) {
  return rows(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = '${table}';
  `)[0].sql
}

function sourceRows() {
  return rows(`
    SELECT
      id, name, channel, slug, target_path, utm_source, utm_medium,
      utm_campaign, utm_content, ad_provider, status, note,
      created_by, created_at, updated_at
    FROM analytics_tracking_sources
    ORDER BY id;
  `)
}
