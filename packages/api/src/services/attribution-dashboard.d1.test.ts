import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { queryAttributionBreakdown } from './attribution-dashboard'

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
    insertAction('action_contact', 'contact', ''),
    insertAction('action_contact_duplicate', 'contact', 'action_contact'),
    insertAction('action_registration', 'complete_registration', ''),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, channel, status
      ) VALUES ('delivery_contact_pixel', 'action_contact', 'meta_pixel', 'attempted')
    `),
    db.prepare(`
      INSERT INTO analytics_conversion_deliveries (
        id, conversion_action_id, channel, status
      ) VALUES ('delivery_registration_capi', 'action_registration', 'meta_capi', 'sent')
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
      )

      expect(result.data.rows).toEqual([{
        value: dimension === 'utm_campaign' ? 'campaign-a' : dimension === 'utm_content' ? 'content-a' : 'link-a',
        actionCount: 2,
        contactCount: 1,
        completeRegistrationCount: 1,
        delivery: {
          pixelAttempted: 1,
          capiSent: 1,
          failed: 0,
          skipped: 0,
          pending: 0,
          retryExhausted: 0,
        },
      }])
    },
  )
})

function insertAction(id: string, actionType: string, duplicateOf: string) {
  return db.prepare(`
    INSERT INTO analytics_conversion_actions (
      id, action_type, date, utm_campaign, utm_content, tracking_source_slug, duplicate_of
    ) VALUES (?, ?, '2026-07-11', 'campaign-a', 'content-a', 'link-a', ?)
  `).bind(id, actionType, duplicateOf)
}

function schemaSql() {
  return `
    CREATE TABLE analytics_conversion_actions (
      id TEXT PRIMARY KEY, action_type TEXT NOT NULL, date TEXT NOT NULL,
      utm_campaign TEXT NOT NULL DEFAULT '', utm_content TEXT NOT NULL DEFAULT '',
      tracking_source_slug TEXT NOT NULL DEFAULT '', duplicate_of TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE analytics_conversion_deliveries (
      id TEXT PRIMARY KEY, conversion_action_id TEXT NOT NULL,
      channel TEXT NOT NULL, status TEXT NOT NULL
    );
  `
}
