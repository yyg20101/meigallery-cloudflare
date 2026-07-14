import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  queryAttributionBreakdown,
  queryAttributionQuality,
  queryAttributionSummary,
  queryAttributionTrends,
} from './attribution-dashboard'

let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: '00000000-0000-0000-0000-000000000044' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  for (const statement of schemaSql().split(';').map(value => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run()
  }
  await db.batch([
    insertAction('action_contact_meta', 'contact', '', 'meta'),
    insertAction('action_contact_duplicate', 'contact', 'action_contact_meta', 'meta'),
    insertAction('action_registration', 'complete_registration', '', 'meta'),
    insertAction('action_contact_tiktok', 'contact', '', 'tiktok'),
    insertAction('action_unrouted', 'contact', '', ''),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, transport, status
      ) VALUES ('delivery_contact_pixel', 'action_contact_meta', 'browser', 'attempted')
    `),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, transport, status, has_fbp, has_fbc, has_email, has_external_id
      ) VALUES ('delivery_registration_capi', 'action_registration', 'server', 'sent', 1, 1, 1, 1)
    `),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, provider, transport, status, has_ttclid, has_ttp, has_email
      ) VALUES ('delivery_contact_tiktok', 'action_contact_tiktok', 'tiktok', 'server', 'sent', 1, 1, 1)
    `),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (id, conversion_action_id, provider, transport, status)
      VALUES
        ('delivery_unrouted_browser', 'action_unrouted', 'meta', 'browser', 'attempted'),
        ('delivery_unrouted_server', 'action_unrouted', 'meta', 'server', 'sent')
    `),
    db.prepare(`INSERT INTO analytics_conversion_daily (date, action_type, action_count) VALUES
      ('2026-07-11', 'contact', 1),
      ('2026-07-11', 'complete_registration', 1),
      ('2026-07-11', 'lead', 3)
    `),
    db.prepare(`INSERT INTO analytics_conversion_delivery_daily (
      date, provider, event_name, transport, status, delivery_count
    ) VALUES
      ('2026-07-11', 'meta', 'Contact', 'browser', 'attempted', 1),
      ('2026-07-11', 'meta', 'CompleteRegistration', 'server', 'sent', 1),
      ('2026-07-11', 'tiktok', 'Contact', 'server', 'sent', 1)
    `),
  ])
})

afterAll(async () => miniflare.dispose())

describe('attribution breakdown 真实事实口径', () => {
  it.each(['utm_campaign', 'utm_content', 'tracking_link'] as const)(
    '%s 排除 duplicate diagnostic 行并与 summary/trend 的正式事实一致',
    async dimension => {
      const result = await queryAttributionBreakdown(
        db,
        { from: '2026-07-11', to: '2026-07-11' },
        dimension,
        50,
        'meta',
      )

      expect(result.data.rows).toEqual([{
        value: dimension === 'utm_campaign' ? 'campaign-a' : dimension === 'utm_content' ? 'content-a' : 'link-a',
        actionCount: 2,
        contactCount: 1,
        completeRegistrationCount: 1,
        delivery: {
          pixelAttempted: 1,
          serverSent: 1,
          failed: 0,
          skipped: 0,
          pending: 0,
          retryExhausted: 0,
        },
      }])
    },
  )

  it('按 provider 隔离 TikTok 与 Meta 投递事实', async () => {
    const result = await queryAttributionBreakdown(
      db,
      { from: '2026-07-11', to: '2026-07-11' },
      'utm_campaign',
      50,
      'tiktok',
    )

    expect(result.data).toMatchObject({
      provider: 'tiktok',
      rows: [{
        actionCount: 1,
        delivery: { pixelAttempted: 0, serverSent: 1 },
      }],
    })
  })

  it('总览、趋势与匹配质量在真实 D1 中按平台使用各自标识', async () => {
    const range = { from: '2026-07-11', to: '2026-07-11' }
    const [metaSummary, tiktokSummary, tiktokTrends, metaQuality, tiktokQuality] = await Promise.all([
      queryAttributionSummary(db, range, 'meta'),
      queryAttributionSummary(db, range, 'tiktok'),
      queryAttributionTrends(db, range, 'tiktok'),
      queryAttributionQuality(db, range, 'dev', 'meta'),
      queryAttributionQuality(db, range, 'dev', 'tiktok'),
    ])

    expect(metaSummary.data).toMatchObject({
      provider: 'meta',
      business: { actionCount: 2 },
      historical: { leadCount: 3 },
      delivery: { pixelAttempted: 1, serverSent: 1 },
      routing: { mismatchCount: 0, unroutedActionCount: 1 },
    })
    expect(tiktokSummary.data).toMatchObject({
      provider: 'tiktok',
      business: { actionCount: 1 },
      delivery: { pixelAttempted: 0, serverSent: 1 },
      routing: { mismatchCount: 0, unroutedActionCount: 1 },
    })
    expect(tiktokTrends.data.rows[0]?.delivery).toMatchObject({ pixelAttempted: 0, serverSent: 1 })
    expect(metaQuality.data.match).toMatchObject({
      labels: { browserId: 'fbp', clickId: 'fbc' },
      summary: {
        browserId: { numerator: 1, denominator: 1, rate: 1 },
        clickId: { numerator: 1, denominator: 1, rate: 1 },
      },
    })
    expect(tiktokQuality.data.match).toMatchObject({
      labels: { browserId: '_ttp', clickId: 'ttclid' },
      summary: {
        browserId: { numerator: 1, denominator: 1, rate: 1 },
        clickId: { numerator: 1, denominator: 1, rate: 1 },
      },
    })
    expect(tiktokQuality.data.platformQuality).toEqual({
      source: 'not_supported', availability: 'unavailable', latest: null, rows: [],
    })
  })
})

function insertAction(id: string, actionType: string, duplicateOf: string, attributionProvider: 'meta' | 'tiktok' | '') {
  return db.prepare(`
    INSERT INTO analytics_conversion_actions (
      id, action_type, date, source_channel, utm_source,
      utm_campaign, utm_content, tracking_source_slug, duplicate_of, attribution_provider
    ) VALUES (?, ?, '2026-07-11', 'ad', ?, 'campaign-a', 'content-a', 'link-a', ?, ?)
  `).bind(id, actionType, attributionProvider, duplicateOf, attributionProvider)
}

function schemaSql() {
  return `
    CREATE TABLE analytics_conversion_actions (
      id TEXT PRIMARY KEY, action_type TEXT NOT NULL, date TEXT NOT NULL,
      source_channel TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
      utm_campaign TEXT NOT NULL DEFAULT '', utm_content TEXT NOT NULL DEFAULT '',
      tracking_source_slug TEXT NOT NULL DEFAULT '', duplicate_of TEXT NOT NULL DEFAULT '',
      attribution_provider TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY, conversion_action_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'meta', transport TEXT NOT NULL DEFAULT 'server',
      status TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '',
      has_fbp INTEGER NOT NULL DEFAULT 0, has_fbc INTEGER NOT NULL DEFAULT 0,
      has_ttclid INTEGER NOT NULL DEFAULT 0, has_ttp INTEGER NOT NULL DEFAULT 0,
      has_email INTEGER NOT NULL DEFAULT 0, has_external_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE analytics_conversion_daily (
      date TEXT NOT NULL, action_type TEXT NOT NULL, action_count INTEGER NOT NULL
    );
    CREATE TABLE analytics_conversion_delivery_daily (
      date TEXT NOT NULL, provider TEXT NOT NULL, event_name TEXT NOT NULL,
      transport TEXT NOT NULL, status TEXT NOT NULL, delivery_count INTEGER NOT NULL
    );
    CREATE TABLE meta_dataset_quality_snapshots (
      id TEXT PRIMARY KEY, environment TEXT NOT NULL, collected_at TEXT NOT NULL,
      event_name TEXT NOT NULL, metric_key TEXT NOT NULL, metric_value REAL,
      collection_status TEXT NOT NULL, error_category TEXT NOT NULL DEFAULT '',
      window_start TEXT, window_end TEXT, contract_version INTEGER NOT NULL DEFAULT 1
    );
  `
}
