import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'meigallery-attribution-0055-'))
const database = join(tempDir, 'integrity.sqlite')
const migration = readFileSync(new URL('./0055_attribution_tracking_integrity.sql', import.meta.url), 'utf8')

before(() => {
  execute(setupSql())
  execute(migration)
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('0055 投放来源与聚合完整性 migration', () => {
  it('保留旧来源并允许统一 Google 平台', () => {
    assert.deepEqual(rows(`
      SELECT id, slug, ad_provider, status
      FROM analytics_tracking_sources
      ORDER BY id;
    `), [{
      id: 'source_meta',
      slug: 'ad-meta-a',
      ad_provider: 'meta',
      status: 'active',
    }])

    execute(`
      INSERT INTO analytics_tracking_sources (
        id, name, channel, slug, target_path, utm_source, utm_medium,
        utm_campaign, utm_content, ad_provider, status, note, created_by
      ) VALUES (
        'source_google', 'Google A', 'ad', 'ad-google-a', '/', 'ad-google-a',
        'paid_search', 'campaign-google', '', 'google', 'active', '', 1
      );
    `)
    assert.equal(rows(`
      SELECT COUNT(*) AS count
      FROM analytics_tracking_sources
      WHERE ad_provider = 'google';
    `)[0].count, 1)
    assert.throws(() => execute(`
      INSERT INTO analytics_tracking_sources (
        id, name, channel, slug, target_path, utm_source, utm_medium,
        utm_campaign, utm_content, ad_provider, status, note, created_by
      ) VALUES (
        'source_invalid', 'Invalid', 'ad', 'ad-invalid-a', '/', 'ad-invalid-a',
        'paid_social', '', '', 'unknown', 'active', '', 1
      );
    `), /CHECK constraint failed/)
  })

  it('只修正后台广告来源，不猜测普通流量', () => {
    assert.deepEqual(rows(`
      SELECT id, source_channel
      FROM analytics_sessions
      ORDER BY id;
    `), [
      { id: 'session_managed', source_channel: 'ad' },
      { id: 'session_organic', source_channel: 'referral' },
    ])
    assert.equal(rows(`
      SELECT first_source_channel
      FROM analytics_visitors
      WHERE id = 'visitor_managed';
    `)[0].first_source_channel, 'ad')
    assert.deepEqual(rows(`
      SELECT
        json_extract(analytics_dimensions_json, '$.sourceChannel') AS channel,
        json_extract(analytics_dimensions_json, '$.trackingSourceSlug') AS slug
      FROM attribution_conversion_facts
      WHERE id = 'fact_managed';
    `), [{ channel: 'ad', slug: 'ad-meta-a' }])
  })

  it('打开联系面板不再计为有效联系，页面和来源聚合保持一致', () => {
    assert.equal(rows(`
      SELECT contact_click_count
      FROM analytics_session_summaries
      WHERE session_id = 'session_managed';
    `)[0].contact_click_count, 1)
    assert.deepEqual(rows(`
      SELECT source_channel, source_name, contact_click_count
      FROM analytics_daily_sources
      WHERE source_name = 'ad-meta-a';
    `), [{ source_channel: 'ad', source_name: 'ad-meta-a', contact_click_count: 1 }])
    assert.equal(rows(`
      SELECT contact_click_count
      FROM analytics_daily_pages
      WHERE path = '/';
    `)[0].contact_click_count, 1)
    assert.deepEqual(rows(`
      SELECT source_channel, contact_click_count
      FROM analytics_source_page_daily
      WHERE source_name = 'ad-meta-a';
    `), [{ source_channel: 'ad', contact_click_count: 1 }])
  })

  it('来源点击旧渠道行迁移到 ad 且不重复保留', () => {
    assert.deepEqual(rows(`
      SELECT source_channel, source_name, raw_click_count, effective_click_count
      FROM analytics_source_click_daily;
    `), [{
      source_channel: 'ad',
      source_name: 'ad-meta-a',
      raw_click_count: 1,
      effective_click_count: 1,
    }])
  })

  it('邀请注册和会员转化按北京时间业务日重建', () => {
    assert.deepEqual(rows(`
      SELECT date, invite_code_id, register_count, contact_click_count, membership_grant_count
      FROM analytics_invite_daily;
    `), [{
      date: '2026-07-21',
      invite_code_id: 'invite_a',
      register_count: 1,
      contact_click_count: 1,
      membership_grant_count: 1,
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
  const output = execFileSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' }).trim()
  return output ? JSON.parse(output) : []
}

function setupSql() {
  return `
  PRAGMA foreign_keys = ON;

  CREATE TABLE users (id INTEGER PRIMARY KEY);
  INSERT INTO users (id) VALUES (1);

  CREATE TABLE analytics_tracking_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    target_path TEXT NOT NULL,
    utm_source TEXT NOT NULL UNIQUE,
    utm_medium TEXT NOT NULL,
    utm_campaign TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    utm_content TEXT NOT NULL DEFAULT '',
    ad_provider TEXT NOT NULL DEFAULT ''
      CHECK (ad_provider IN ('', 'meta', 'tiktok'))
  );
  CREATE INDEX idx_analytics_tracking_sources_status
    ON analytics_tracking_sources(status, created_at);
  CREATE INDEX idx_tracking_sources_ad_provider
    ON analytics_tracking_sources(ad_provider, status, created_at);

  CREATE TABLE analytics_visitors (
    id TEXT PRIMARY KEY,
    first_source_channel TEXT NOT NULL,
    first_source_name TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE analytics_sessions (
    id TEXT PRIMARY KEY,
    source_channel TEXT NOT NULL,
    source_name TEXT NOT NULL,
    utm_source TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE analytics_session_summaries (
    session_id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    source_channel TEXT NOT NULL,
    source_name TEXT NOT NULL,
    invite_code_id TEXT NOT NULL,
    page_view_count INTEGER NOT NULL,
    active_seconds INTEGER NOT NULL,
    contact_click_count INTEGER NOT NULL,
    register_success_count INTEGER NOT NULL,
    membership_grant_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE analytics_events (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    route_name TEXT NOT NULL,
    path TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    page_title TEXT NOT NULL,
    source_channel TEXT NOT NULL
  );
  CREATE TABLE analytics_page_summaries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    route_name TEXT NOT NULL,
    path TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    page_title TEXT NOT NULL,
    page_view_count INTEGER NOT NULL,
    is_entry INTEGER NOT NULL,
    is_exit INTEGER NOT NULL,
    is_bounce INTEGER NOT NULL,
    active_seconds INTEGER NOT NULL,
    max_scroll_depth INTEGER NOT NULL
  );
  CREATE TABLE attribution_conversion_facts (
    id TEXT PRIMARY KEY,
    analytics_dimensions_json TEXT NOT NULL
  );

  CREATE TABLE analytics_daily_sources (
    date TEXT NOT NULL,
    source_channel TEXT NOT NULL,
    source_name TEXT NOT NULL,
    invite_code_id TEXT NOT NULL,
    visitor_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    page_view_count INTEGER NOT NULL,
    gallery_detail_count INTEGER NOT NULL,
    contact_click_count INTEGER NOT NULL,
    register_count INTEGER NOT NULL,
    invite_register_count INTEGER NOT NULL,
    membership_grant_count INTEGER NOT NULL,
    active_seconds_total INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, source_channel, source_name, invite_code_id)
  );
  CREATE TABLE analytics_daily_pages (
    date TEXT NOT NULL,
    route_name TEXT NOT NULL,
    path TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    page_title TEXT NOT NULL,
    page_view_count INTEGER NOT NULL,
    visitor_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    entry_count INTEGER NOT NULL,
    exit_count INTEGER NOT NULL,
    bounce_count INTEGER NOT NULL,
    active_seconds_total INTEGER NOT NULL,
    max_scroll_depth INTEGER NOT NULL,
    register_count INTEGER NOT NULL,
    contact_click_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, route_name, path, entity_type, entity_id)
  );
  CREATE TABLE analytics_source_page_daily (
    date TEXT NOT NULL,
    source_channel TEXT NOT NULL,
    source_name TEXT NOT NULL,
    invite_code_id TEXT NOT NULL,
    route_name TEXT NOT NULL,
    path TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    page_title TEXT NOT NULL,
    visitor_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    page_view_count INTEGER NOT NULL,
    entry_count INTEGER NOT NULL,
    exit_count INTEGER NOT NULL,
    bounce_count INTEGER NOT NULL,
    active_seconds_total INTEGER NOT NULL,
    max_scroll_depth INTEGER NOT NULL,
    register_count INTEGER NOT NULL,
    contact_click_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (
      date, source_channel, source_name, invite_code_id,
      route_name, path, entity_type, entity_id
    )
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (
      date, source_channel, source_name, invite_code_id,
      element_id, location, target_type, target_id
    )
  );
  CREATE TABLE invite_codes (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL
  );
  CREATE TABLE invite_registrations (
    invite_code_id TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    first_membership_granted_at TEXT
  );
  CREATE TABLE analytics_invite_daily (
    date TEXT NOT NULL,
    invite_code_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    landing_count INTEGER NOT NULL,
    visitor_count INTEGER NOT NULL,
    session_count INTEGER NOT NULL,
    register_count INTEGER NOT NULL,
    contact_click_count INTEGER NOT NULL,
    membership_grant_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (date, invite_code_id)
  );

  INSERT INTO analytics_tracking_sources (
    id, name, channel, slug, target_path, utm_source, utm_medium,
    utm_campaign, utm_content, ad_provider, status, note, created_by
  ) VALUES (
    'source_meta', 'Meta A', 'ad', 'ad-meta-a', '/', 'ad-meta-a',
    'paid_social', 'campaign-meta', 'creative-a', 'meta', 'active', '', 1
  );

  INSERT INTO analytics_visitors VALUES
    ('visitor_managed', 'referral', 'ad-meta-a', datetime('now')),
    ('visitor_organic', 'referral', 'partner-site', datetime('now'));
  INSERT INTO analytics_sessions VALUES
    ('session_managed', 'referral', 'ad-meta-a', 'ad-meta-a', datetime('now')),
    ('session_organic', 'referral', 'partner-site', 'partner-site', datetime('now'));
  INSERT INTO analytics_session_summaries VALUES
    ('session_managed', '2026-07-21', 'visitor_managed', 'referral', 'ad-meta-a', 'invite_a', 1, 30, 2, 0, 0, datetime('now')),
    ('session_organic', '2026-07-21', 'visitor_organic', 'referral', 'partner-site', '', 1, 10, 0, 0, 0, datetime('now'));
  INSERT INTO analytics_page_summaries VALUES
    ('page_managed', '2026-07-21', 'visitor_managed', 'session_managed', '/', '/', 'page', '', '首页', 1, 1, 1, 0, 30, 80);
  INSERT INTO analytics_events VALUES
    ('event_panel', 'contact_panel_open', '2026-07-20T16:00:00.000Z', 'visitor_managed', 'session_managed', '/', '/', 'page', '', '首页', 'referral'),
    ('event_contact', 'contact_method_click', '2026-07-20T16:00:01.000Z', 'visitor_managed', 'session_managed', '/', '/', 'page', '', '首页', 'referral');
  INSERT INTO attribution_conversion_facts VALUES
    ('fact_managed', '{"sourceChannel":"referral","sourceName":"ad-meta-a"}');
  INSERT INTO invite_codes VALUES ('invite_a', 'meta-team');
  INSERT INTO invite_registrations VALUES
    ('invite_a', '2026-07-20T16:05:00.000Z', '2026-07-20T16:10:00.000Z');
  INSERT INTO analytics_daily_sources VALUES
    ('2026-07-21', 'referral', 'ad-meta-a', '', 1, 1, 1, 0, 2, 0, 0, 0, 30, datetime('now'));
  INSERT INTO analytics_daily_pages VALUES
    ('2026-07-21', '/', '/', 'page', '', '首页', 1, 1, 1, 1, 1, 0, 30, 80, 0, 0, datetime('now'));
  INSERT INTO analytics_source_page_daily VALUES
    ('2026-07-21', 'referral', 'ad-meta-a', '', '/', '/', 'page', '', '首页', 1, 1, 1, 1, 1, 0, 30, 80, 0, 0, datetime('now'));
  INSERT INTO analytics_source_click_daily VALUES
    ('2026-07-21', 'referral', 'ad-meta-a', '', 'contact_method_click', 'button', 'footer', 'contact', '', 1, 1, 0, 1, 1, 0, 1, datetime('now'));
`
}
