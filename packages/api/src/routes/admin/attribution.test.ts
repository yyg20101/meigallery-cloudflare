import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import type { Bindings, Variables } from '../../index'
import { adminAttributionRoutes } from './attribution'

const MIGRATION = readFileSync(new URL('../../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
const CLEANUP_MIGRATION = readFileSync(new URL('../../../migrations/0061_attribution_source_router_cleanup.sql', import.meta.url), 'utf8')
const LINK_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY);
  INSERT INTO users (id) VALUES (1);
  CREATE TABLE analytics_tracking_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    link_proof TEXT NOT NULL,
    target_path TEXT NOT NULL,
    utm_source TEXT NOT NULL,
    utm_medium TEXT NOT NULL,
    utm_campaign TEXT NOT NULL,
    utm_content TEXT NOT NULL,
    ad_provider TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
    active_seconds_total INTEGER NOT NULL
  );
`
const RANGE = 'from=2026-07-15&to=2026-07-15'
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'admin-attribution' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
  await db.exec(CLEANUP_MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
  await db.exec(LINK_SCHEMA.replace(/\s*\r?\n\s*/g, ' '))
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM analytics_daily_sources;
    DELETE FROM analytics_tracking_sources;
    DELETE FROM attribution_provider_receipts;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_conversion_facts;
    DELETE FROM attribution_platform_connections;
  `)
  await seed()
})

afterAll(async () => miniflare.dispose())

describe('统一归因后台 API', () => {
  it('summary、trends、quality 和 breakdown 统一支持三平台', async () => {
    const [summary, trends, quality, breakdown] = await Promise.all([
      request(`/summary?${RANGE}&provider=google`),
      request(`/trends?${RANGE}&provider=google&granularity=day`),
      request(`/quality?${RANGE}&provider=google`),
      request(`/breakdown?${RANGE}&provider=google&dimension=utm_campaign&limit=10`),
    ])

    expect(summary.status).toBe(200)
    expect((await summary.json()).data).toMatchObject({
      provider: 'google',
      business: { contactCount: 1, completeRegistrationCount: 1, factCount: 2 },
      delivery: { browserAttempted: 1, server: { accepted: 1, deadLetter: 1 }, queueRetryCount: 2 },
    })
    expect((await trends.json()).data.rows).toHaveLength(1)
    expect((await quality.json()).data).toMatchObject({
      provider: 'google',
      pairing: { summary: { numerator: 1, denominator: 2, rate: 0.5 } },
      match: { summary: { numerator: 1, denominator: 2, rate: 0.5 } },
    })
    expect((await breakdown.json()).data.rows[0]).toMatchObject({
      value: 'google-campaign', factCount: 2, contactCount: 1, completeRegistrationCount: 1,
    })
  })

  it('conversions 只返回最终 Fact、Delivery 和签名 Browser 回执口径', async () => {
    const response = await request(`/conversions?${RANGE}&provider=google`)
    const body = await response.json() as {
      data: { byEvent: Array<Record<string, unknown>>; bySource: Array<Record<string, unknown>>; samples: Array<Record<string, unknown>> }
    }

    expect(response.status).toBe(200)
    expect(body.data.byEvent).toEqual([
      expect.objectContaining({ canonical_event: 'CompleteRegistration', fact_count: 1 }),
      expect.objectContaining({ canonical_event: 'Contact', fact_count: 1 }),
    ])
    expect(body.data.bySource[0]).toMatchObject({ source_name: 'google-source', fact_count: 2 })
    expect(body.data.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical_event: 'Contact', browser_attempted: 1, server_status: 'accepted' }),
      expect.objectContaining({ canonical_event: 'CompleteRegistration', browser_attempted: 0, server_status: 'dead_letter', retry_count: 2 }),
    ]))
  })

  it('links 只返回当前平台投放链接，并使用最终事实计算有效联系和注册', async () => {
    await fact(
      'fact_google_unresolved',
      'Contact',
      'google',
      'google-source',
      'google-campaign',
      '',
    ).run()
    const response = await request(`/links?${RANGE}&provider=google`)
    const body = await response.json() as {
      data: {
        provider: string
        links: Array<Record<string, unknown>>
      }
    }

    expect(response.status).toBe(200)
    expect(body.data.provider).toBe('google')
    expect(body.data.links).toEqual([
      expect.objectContaining({
        sourceLabel: 'Google 广告 A',
        sourceCode: 'google-source',
        adProvider: 'google',
        sessionCount: 3,
        pageViewCount: 7,
        contactCount: 1,
        completeRegistrationCount: 1,
        trackingPath: expect.stringMatching(/[?&]mg_proof=[0-9a-f]{64}(?:&|$)/),
      }),
    ])
  })

  it.each(['sourceCode', 'sourceName', 'source'])('conversions 支持 %s 来源过滤且 all 等同未过滤', async (field) => {
    const [filtered, all] = await Promise.all([
      request(`/conversions?${RANGE}&provider=google&${field}=google-source`),
      request(`/conversions?${RANGE}&provider=google&${field}=all`),
    ])

    expect((await filtered.json()).data.samples).toHaveLength(2)
    expect((await all.json()).data.samples).toHaveLength(2)
  })

  it('容量按北京时间自然日汇总且标明内部估算', async () => {
    const response = await request('/capacity?date=2026-07-15')
    const body = await response.json() as { data: Record<string, unknown> }

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ date: '2026-07-15', timeZone: 'Asia/Shanghai' })
    expect(body.data.note).toContain('项目内部估算')
  })

  it.each([
    ['/summary?provider=unknown', 'ATTRIBUTION_PROVIDER_INVALID'],
    ['/trends?provider=meta&granularity=hour', 'ATTRIBUTION_TREND_GRANULARITY_INVALID'],
    ['/breakdown?provider=meta&dimension=provider', 'ATTRIBUTION_BREAKDOWN_DIMENSION_INVALID'],
    ['/breakdown?provider=meta&dimension=utm_campaign&limit=0', 'ATTRIBUTION_BREAKDOWN_LIMIT_INVALID'],
    ['/breakdown?provider=meta&dimension=utm_campaign&limit=abc', 'ATTRIBUTION_BREAKDOWN_LIMIT_INVALID'],
    ['/capacity?date=2026-02-31', 'ATTRIBUTION_CAPACITY_DATE_INVALID'],
  ])('非法查询 %s 返回稳定错误码', async (path, code) => {
    const response = await request(path)
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe(code)
  })

  it.each(['/summary', '/trends', '/quality', '/breakdown?dimension=utm_campaign', '/conversions', '/links'])(
    '查询 %s 的非法日期范围在路由层稳定失败',
    async (path) => {
      const separator = path.includes('?') ? '&' : '?'
      const response = await request(`${path}${separator}provider=meta&from=bad&to=2026-07-15`)
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('ANALYTICS_RANGE_INVALID')
    },
  )

  it('D1 查询异常统一返回看板不可用且不泄露内部错误', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('database-secret-detail')
      },
    } as unknown as D1Database
    const response = await request(`/summary?${RANGE}&provider=meta`, brokenDb)
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(body).toContain('ATTRIBUTION_DASHBOARD_UNAVAILABLE')
    expect(body).not.toContain('database-secret-detail')
  })
})

function application() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('userRole', 'admin')
    await next()
  })
  app.route('/api/admin/attribution', adminAttributionRoutes)
  return app
}

function request(path: string, database = db) {
  return application().request(`/api/admin/attribution${path}`, {}, {
    DB: database,
    APP_ENV: 'production',
  } as unknown as Bindings)
}

async function seed() {
  await db.batch([
    trackingSource('source_meta', 'Meta 广告 A', 'meta-source', 'meta'),
    trackingSource('source_google', 'Google 广告 A', 'google-source', 'google'),
    db.prepare(`INSERT INTO analytics_daily_sources (
      date, source_channel, source_name, invite_code_id, visitor_count, session_count,
      page_view_count, gallery_detail_count, contact_click_count, register_count,
      invite_register_count, membership_grant_count, active_seconds_total
    ) VALUES (
      '2026-07-15', 'ad', 'google-source', '', 2, 3, 7, 1, 1, 1, 0, 0, 120
    )`),
    db.prepare(`INSERT INTO analytics_daily_sources (
      date, source_channel, source_name, invite_code_id, visitor_count, session_count,
      page_view_count, gallery_detail_count, contact_click_count, register_count,
      invite_register_count, membership_grant_count, active_seconds_total
    ) VALUES (
      '2026-07-15', 'referral', 'google-source', '', 50, 100, 200, 0, 0, 0, 0, 0, 300
    )`),
    connection('meta'),
    connection('google'),
    fact('fact_meta', 'Contact', 'meta', 'meta-source', 'meta-campaign'),
    fact('fact_google_contact', 'Contact', 'google', 'google-source', 'google-campaign'),
    fact('fact_google_registration', 'CompleteRegistration', 'google', 'google-source', 'google-campaign'),
    delivery('google_browser_contact', 'fact_google_contact', 'google', 'browser', 'planned', 0, []),
    delivery('google_server_contact', 'fact_google_contact', 'google', 'server', 'accepted', 1, ['gclid']),
    delivery('google_browser_registration', 'fact_google_registration', 'google', 'browser', 'planned', 0, []),
    delivery('google_server_registration', 'fact_google_registration', 'google', 'server', 'dead_letter', 3, []),
    db.prepare(`INSERT INTO attribution_provider_receipts (
      id, delivery_id, provider, receipt_type, status, receipt_json, received_at
    ) VALUES ('receipt_google_browser', 'google_browser_contact', 'google', 'browser_attempt', 'attempted', '{}', '2026-07-15T04:00:00.000Z')`),
  ])
}

function trackingSource(id: string, name: string, slug: string, provider: 'meta' | 'google') {
  return db.prepare(`INSERT INTO analytics_tracking_sources (
    id, name, channel, slug, link_proof, target_path, utm_source, utm_medium, utm_campaign,
    utm_content, ad_provider, status, note, created_by, created_at, updated_at
  ) VALUES (?, ?, 'ad', ?, ?, '/', ?, 'paid_social', ?, 'creative-a', ?, 'active', '', 1,
    '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'
  )`).bind(id, name, slug, provider === 'meta' ? 'a'.repeat(64) : 'b'.repeat(64), slug, `${slug}-campaign`, provider)
}

function connection(provider: 'meta' | 'google') {
  return db.prepare(`INSERT INTO attribution_platform_connections (
    id, provider, enabled, browser_enabled, server_enabled, public_config_json, outbox_scope
  ) VALUES (?, ?, 1, 1, 1, '{}', 'outbox_scope_1')`).bind(`conn_${provider}`, provider)
}

function fact(
  id: string,
  event: 'Contact' | 'CompleteRegistration',
  provider: 'meta' | 'google',
  sourceName: string,
  campaign: string,
  trackingSourceSlug = sourceName,
) {
  return db.prepare(`INSERT INTO attribution_conversion_facts (
    id, canonical_event, fact_origin, external_event_id, attribution_provider, attribution_source,
    occurred_at, dedupe_key, analytics_dimensions_json
  ) VALUES (?, ?, 'live', ?, ?, 'click_id', '2026-07-15T04:00:00.000Z', ?, ?)`).bind(
    id,
    event,
    `mg3_${id}`,
    provider,
    `dedupe_${id}`,
    JSON.stringify({
      sessionId: `session_${id}`,
      sourceName,
      sourceChannel: 'ad',
      ...(trackingSourceSlug ? { trackingSourceSlug } : {}),
      utmCampaign: campaign,
      utmContent: 'creative-a',
      path: '/',
    }),
  )
}

function delivery(id: string, factId: string, provider: 'google', transport: 'browser' | 'server', status: string, attemptCount: number, signals: string[]) {
  return db.prepare(`INSERT INTO attribution_deliveries (
    id, fact_id, connection_id, provider, transport, status, destination,
    match_signals_json, attempt_count, queue_attempt_count, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'destination', ?, ?, 1, '2026-07-15T04:00:00.000Z')`).bind(
    id, factId, `conn_${provider}`, provider, transport, status, JSON.stringify(signals), attemptCount,
  )
}
