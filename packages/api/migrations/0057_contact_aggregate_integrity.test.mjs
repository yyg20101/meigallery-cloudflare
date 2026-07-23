import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0057-'))
const database = join(tempDir, 'integrity.sqlite')
const migration = readFileSync(new URL('./0057_contact_aggregate_integrity.sql', import.meta.url), 'utf8')

before(() => {
  execute(setupSql())
  execute(migration)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0057 有效联系聚合完整性 migration', () => {
  it('按北京时间从关键原始事实重建事件趋势并保留其他事件', () => {
    assert.deepEqual(rows(`
      SELECT date, event_name, entity_id, event_count, visitor_count, session_count, user_count
      FROM analytics_daily_events
      ORDER BY event_name, date, entity_id;
    `), [
      {
        date: '2026-07-02',
        event_name: 'contact_method_click',
        entity_id: 'email',
        event_count: 1,
        visitor_count: 1,
        session_count: 1,
        user_count: 0,
      },
      {
        date: '2026-07-02',
        event_name: 'contact_method_click',
        entity_id: 'telegram',
        event_count: 2,
        visitor_count: 2,
        session_count: 2,
        user_count: 1,
      },
      {
        date: '2026-07-02',
        event_name: 'contact_method_click',
        entity_id: 'whatsapp',
        event_count: 1,
        visitor_count: 1,
        session_count: 1,
        user_count: 0,
      },
      {
        date: '2026-07-01',
        event_name: 'page_view',
        entity_id: '',
        event_count: 9,
        visitor_count: 8,
        session_count: 8,
        user_count: 0,
      },
    ])
  })

  it('来源点击日报排除纯 direct，并精确重建来源和去重人数', () => {
    assert.deepEqual(rows(`
      SELECT
        date, source_channel, source_name, element_id, location, target_id,
        raw_click_count, effective_click_count, duplicate_click_count,
        visitor_count, session_count, user_count, exposure_session_count
      FROM analytics_source_click_daily
      ORDER BY source_channel, source_name;
    `), [
      {
        date: '2026-07-02',
        source_channel: 'ad',
        source_name: 'managed-meta',
        element_id: 'contact_method_click',
        location: 'floating_contact',
        target_id: 'telegram',
        raw_click_count: 2,
        effective_click_count: 2,
        duplicate_click_count: 0,
        visitor_count: 2,
        session_count: 2,
        user_count: 1,
        exposure_session_count: 0,
      },
      {
        date: '2026-07-02',
        source_channel: 'referral',
        source_name: 'partner',
        element_id: 'contact_method_click',
        location: '/gallery/example',
        target_id: 'email',
        raw_click_count: 1,
        effective_click_count: 1,
        duplicate_click_count: 0,
        visitor_count: 1,
        session_count: 1,
        user_count: 0,
        exposure_session_count: 0,
      },
      {
        date: '2026-07-01',
        source_channel: 'search',
        source_name: 'google',
        element_id: 'gallery_card_click',
        location: 'home',
        target_id: 'gallery-1',
        raw_click_count: 3,
        effective_click_count: 3,
        duplicate_click_count: 0,
        visitor_count: 2,
        session_count: 2,
        user_count: 0,
        exposure_session_count: 0,
      },
    ])
  })

  it('重复执行仍得到同一组确定性聚合', () => {
    const beforeRows = rows(`
      SELECT date, event_name, entity_id, event_count
      FROM analytics_daily_events
      ORDER BY event_name, date, entity_id;
    `)
    execute(migration)
    assert.deepEqual(rows(`
      SELECT date, event_name, entity_id, event_count
      FROM analytics_daily_events
      ORDER BY event_name, date, entity_id;
    `), beforeRows)
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
  const output = execFileSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' }).trim()
  return output ? JSON.parse(output) : []
}

function setupSql() {
  return `
  CREATE TABLE analytics_daily_events (
    date TEXT NOT NULL,
    event_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    visitor_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    user_count INTEGER NOT NULL,
    value_total REAL NOT NULL,
    updated_at TEXT,
    UNIQUE (date, event_name, entity_type, entity_id)
  );
  CREATE TABLE analytics_session_summaries (
    session_id TEXT PRIMARY KEY,
    source_channel TEXT NOT NULL,
    source_name TEXT NOT NULL,
    invite_code_id TEXT NOT NULL
  );
  CREATE TABLE analytics_events (
    event_name TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_id INTEGER,
    route_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_props TEXT NOT NULL,
    value REAL
  );
  CREATE TABLE analytics_source_click_daily (
    date TEXT NOT NULL,
    source_channel TEXT NOT NULL,
    source_name TEXT NOT NULL,
    invite_code_id TEXT NOT NULL,
    element_id TEXT NOT NULL,
    element_type TEXT NOT NULL,
    location TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    raw_click_count INTEGER NOT NULL,
    effective_click_count INTEGER NOT NULL,
    duplicate_click_count INTEGER NOT NULL,
    visitor_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    user_count INTEGER NOT NULL,
    exposure_session_count INTEGER NOT NULL,
    updated_at TEXT,
    UNIQUE (
      date, source_channel, source_name, invite_code_id,
      element_id, location, target_type, target_id
    )
  );

  INSERT INTO analytics_daily_events VALUES
    ('2026-07-01', 'contact_method_click', 'contact_method', 'telegram', 99, 99, 99, 0, 0, datetime('now')),
    ('2026-07-01', 'page_view', 'page', '', 9, 8, 8, 0, 0, datetime('now'));
  INSERT INTO analytics_source_click_daily VALUES
    ('2026-07-01', 'ad', 'managed-meta', '', 'contact_method_click', 'old', 'old', 'contact', 'telegram', 99, 99, 0, 99, 99, 0, 0, datetime('now')),
    ('2026-07-01', 'search', 'google', '', 'gallery_card_click', 'card', 'home', 'gallery', 'gallery-1', 3, 3, 0, 2, 2, 0, 0, datetime('now'));

  INSERT INTO analytics_session_summaries VALUES
    ('session-ad-1', 'ad', 'managed-meta', ''),
    ('session-ad-2', 'ad', 'managed-meta', ''),
    ('session-direct', 'direct', 'direct', ''),
    ('session-referral', 'referral', 'partner', '');

  INSERT INTO analytics_events VALUES
    ('contact_method_click', '2026-07-01T16:30:00.000Z', 'visitor-1', 'session-ad-1', 42, '/', 'contact_method', 'telegram', '{"location":"floating_contact"}', NULL),
    ('contact_method_click', '2026-07-01T16:31:00.000Z', 'visitor-2', 'session-ad-2', 42, '/', 'contact_method', 'telegram', '{"location":"floating_contact"}', NULL),
    ('contact_method_click', '2026-07-01T16:32:00.000Z', 'visitor-3', 'session-direct', NULL, '/', 'contact_method', 'whatsapp', '{}', NULL),
    ('contact_method_click', '2026-07-01T16:33:00.000Z', 'visitor-4', 'session-referral', NULL, '/gallery/example', 'contact_method', 'email', '{}', NULL);
  `
}
