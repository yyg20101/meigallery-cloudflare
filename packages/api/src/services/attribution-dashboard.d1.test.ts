import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  queryAttributionBreakdown,
  queryAttributionCapacity,
  queryAttributionConversions,
  queryAttributionQuality,
  queryAttributionSummary,
  queryAttributionTrends,
} from './attribution-dashboard'

const MIGRATION = readFileSync(new URL('../../migrations/0051_unified_attribution_expand.sql', import.meta.url), 'utf8')
let miniflare: Miniflare
let db: D1Database

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-05-26',
    d1Databases: { DB: 'attribution-dashboard-v3' },
  })
  db = (await miniflare.getBindings<{ DB: D1Database }>()).DB
  await db.exec(MIGRATION.replace(/\s*\r?\n\s*/g, ' '))
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM attribution_provider_receipts;
    DELETE FROM attribution_deliveries;
    DELETE FROM attribution_conversion_facts;
    DELETE FROM attribution_platform_connections;
  `)
  await seedDashboardFacts()
})

afterAll(async () => miniflare.dispose())

describe('统一归因看板最终事实口径', () => {
  it('区分标准事实、唯一来源平台、未归因和冲突来源', async () => {
    const result = await queryAttributionSummary(db, dayRange(), 'meta')

    expect(result.data).toMatchObject({
      provider: 'meta',
      business: { contactCount: 1, completeRegistrationCount: 1, factCount: 2 },
      routing: {
        totalFactCount: 7,
        attributedFactCount: 5,
        unattributedFactCount: 1,
        conflictFactCount: 1,
        byProvider: { meta: 2, tiktok: 1, google: 2 },
      },
      delivery: {
        browserAttempted: 1,
        server: {
          planned: 0,
          queued: 1,
          accepted: 1,
          processed: 0,
          retrying: 0,
          rejected: 0,
          deadLetter: 0,
          cancelled: 0,
        },
        queueRetryCount: 0,
      },
    })
  })

  it('Google 两个 conversion 始终按 canonical event 分开并保留 retry/DLQ', async () => {
    const [summary, trends, breakdown] = await Promise.all([
      queryAttributionSummary(db, dayRange(), 'google'),
      queryAttributionTrends(db, dayRange(), 'google'),
      queryAttributionBreakdown(db, dayRange(), 'utm_campaign', 50, 'google'),
    ])

    expect(summary.data).toMatchObject({
      business: { contactCount: 1, completeRegistrationCount: 1, factCount: 2 },
      delivery: {
        browserAttempted: 1,
        server: { processed: 1, deadLetter: 1 },
        queueRetryCount: 2,
      },
    })
    expect(trends.data.rows).toEqual([
      expect.objectContaining({
        date: '2026-07-15',
        business: { contactCount: 1, completeRegistrationCount: 1, factCount: 2 },
      }),
    ])
    expect(breakdown.data.rows).toEqual([
      expect.objectContaining({
        value: 'google-campaign',
        factCount: 2,
        contactCount: 1,
        completeRegistrationCount: 1,
      }),
    ])
  })

  it('Browser attempted 只统计签名回执，并计算配对与匹配信号覆盖', async () => {
    const [meta, google] = await Promise.all([
      queryAttributionQuality(db, dayRange(), 'meta'),
      queryAttributionQuality(db, dayRange(), 'google'),
    ])

    expect(meta.data.pairing.summary).toEqual(metric(1, 2))
    expect(meta.data.match.summary).toEqual(metric(1, 2))
    expect(meta.data.match.signals).toEqual([
      { key: 'fbc', ...metric(1, 2) },
      { key: 'fbp', ...metric(1, 2) },
    ])
    expect(google.data.pairing.summary).toEqual(metric(1, 2))
    expect(google.data.match.summary).toEqual(metric(1, 2))
    expect(google.data.match.signals).toEqual([
      { key: 'gclid', ...metric(1, 2) },
    ])
  })

  it('容量估算按 UTC 日汇总三平台最终事实、Delivery 和 Receipt', async () => {
    const result = await queryAttributionCapacity(db, '2026-07-15')

    expect(result.data.date).toBe('2026-07-15')
    expect(result.data.timeZone).toBe('UTC')
    expect(result.data.inputs).toMatchObject({
      factCount: 7,
      deliveryCount: 9,
      browserAttemptCount: 2,
      serverDeliveryCount: 5,
      adapterAttemptCount: 6,
      queueAttemptCount: 5,
      terminalServerDeliveryCount: 4,
      providerReceiptCount: 6,
      workflowStepCount: 0,
    })
    expect(result.data.note).toContain('项目内部估算')
  })

  it('转化明细按来源过滤，并保留最终 Delivery 与 Browser 回执', async () => {
    const [all, filtered, missing] = await Promise.all([
      queryAttributionConversions(db, dayRange(), 'google'),
      queryAttributionConversions(db, dayRange(), 'google', 'google'),
      queryAttributionConversions(db, dayRange(), 'google', 'missing-source'),
    ])

    expect(all.data.byEvent).toHaveLength(2)
    expect(filtered.data.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical_event: 'Contact', browser_attempted: 1, server_status: 'processed' }),
      expect.objectContaining({ canonical_event: 'CompleteRegistration', server_status: 'dead_letter', retry_count: 2 }),
    ]))
    expect(missing.data).toMatchObject({ byEvent: [], bySource: [], samples: [] })
  })

  it('空日期区间返回零值和 unavailable，不复用其他日期数据', async () => {
    const range = { from: '2026-07-16', to: '2026-07-17', days: 2 }
    const [summary, trends, quality, breakdown, capacity] = await Promise.all([
      queryAttributionSummary(db, range, 'meta'),
      queryAttributionTrends(db, range, 'meta'),
      queryAttributionQuality(db, range, 'meta'),
      queryAttributionBreakdown(db, range, 'tracking_link', 1, 'meta'),
      queryAttributionCapacity(db, '2026-07-16'),
    ])

    expect(summary.data.business).toEqual({ contactCount: 0, completeRegistrationCount: 0, factCount: 0 })
    expect(trends.data.rows).toHaveLength(2)
    expect(trends.data.rows.every(row => row.business.factCount === 0)).toBe(true)
    expect(quality.data.pairing.summary).toEqual(metric(0, 0))
    expect(quality.data.match.summary).toEqual(metric(0, 0))
    expect(breakdown.data.rows).toEqual([])
    expect(capacity.data.inputs.factCount).toBe(0)
  })

  it('平台质量快照区分 available、error 与不可解析值', async () => {
    await db.prepare(`INSERT INTO attribution_quality_snapshots (
      id, connection_id, provider, canonical_event, metric_key, metric_value,
      collection_status, error_category, collected_at
    ) VALUES (?, 'conn_meta', 'meta', 'Contact', 'emq', ?, ?, ?, ?)`)
      .bind('quality_success', '8.5', 'success', '', '2026-07-15T04:10:00.000Z').run()
    const available = await queryAttributionQuality(db, dayRange(), 'meta')
    expect(available.data.platformQuality.latest).toMatchObject({ availability: 'available', value: 8.5 })

    await db.batch([
      db.prepare(`INSERT INTO attribution_quality_snapshots (
        id, connection_id, provider, canonical_event, metric_key, metric_value,
        collection_status, error_category, collected_at
      ) VALUES ('quality_invalid', 'conn_meta', 'meta', 'Contact', 'emq', 'not-a-number', 'success', '', '2026-07-15T04:20:00.000Z')`),
      db.prepare(`INSERT INTO attribution_quality_snapshots (
        id, connection_id, provider, canonical_event, metric_key, metric_value,
        collection_status, error_category, collected_at
      ) VALUES ('quality_error', 'conn_meta', 'meta', 'CompleteRegistration', 'emq', NULL, 'error', 'permission', '2026-07-15T04:30:00.000Z')`),
    ])
    const degraded = await queryAttributionQuality(db, dayRange(), 'meta')
    expect(degraded.data.platformQuality.latest).toMatchObject({ availability: 'error', value: null })
    expect(degraded.data.platformQuality.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ availability: 'unavailable', value: null }),
    ]))
  })

  it('所有活动查询只读取最终 Fact、Delivery 和 Receipt', async () => {
    const sql: string[] = []
    const tracked = {
      prepare(statement: string) {
        sql.push(statement)
        return db.prepare(statement)
      },
    } as Pick<D1Database, 'prepare'> as D1Database

    await Promise.all([
      queryAttributionSummary(tracked, dayRange(), 'meta'),
      queryAttributionTrends(tracked, dayRange(), 'tiktok'),
      queryAttributionQuality(tracked, dayRange(), 'google'),
      queryAttributionBreakdown(tracked, dayRange(), 'utm_content', 50, 'meta'),
      queryAttributionCapacity(tracked, '2026-07-15'),
      queryAttributionConversions(tracked, dayRange(), 'google', 'google'),
    ])

    const source = sql.join('\n')
    expect(source).toContain('attribution_conversion_facts')
    expect(source).toContain('attribution_deliveries')
    expect(source).toContain('attribution_provider_receipts')
    expect(source).not.toMatch(/analytics_conversion_(?:actions|deliveries|daily|delivery_daily)/)
    expect(source).not.toContain('meta_dataset_quality_snapshots')
  })
})

function dayRange() {
  return { from: '2026-07-15', to: '2026-07-15', days: 1 }
}

function metric(numerator: number, denominator: number) {
  return {
    availability: denominator > 0 ? 'available' : 'unavailable',
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
  }
}

async function seedDashboardFacts() {
  await db.batch([
    connection('meta'),
    connection('tiktok'),
    connection('google'),
    fact('fact_meta_contact', 'Contact', 'meta', 'context', 'meta-campaign'),
    fact('fact_meta_registration', 'CompleteRegistration', 'meta', 'context', 'meta-campaign'),
    fact('fact_tiktok_contact', 'Contact', 'tiktok', 'context', 'tiktok-campaign'),
    fact('fact_google_contact', 'Contact', 'google', 'context', 'google-campaign'),
    fact('fact_google_registration', 'CompleteRegistration', 'google', 'context', 'google-campaign'),
    fact('fact_unattributed', 'Contact', null, 'none', 'organic'),
    fact('fact_conflict', 'CompleteRegistration', null, 'conflict', 'conflict'),
    delivery('delivery_meta_browser', 'fact_meta_contact', 'meta', 'browser', 'planned', 0, 0, []),
    delivery('delivery_meta_server', 'fact_meta_contact', 'meta', 'server', 'accepted', 1, 1, ['fbp', 'fbc']),
    delivery('delivery_meta_registration_browser', 'fact_meta_registration', 'meta', 'browser', 'planned', 0, 0, []),
    delivery('delivery_meta_registration_server', 'fact_meta_registration', 'meta', 'server', 'queued', 0, 1, []),
    delivery('delivery_tiktok_server', 'fact_tiktok_contact', 'tiktok', 'server', 'rejected', 1, 1, ['ttclid']),
    delivery('delivery_google_browser', 'fact_google_contact', 'google', 'browser', 'planned', 0, 0, []),
    delivery('delivery_google_server', 'fact_google_contact', 'google', 'server', 'processed', 1, 1, ['gclid']),
    delivery('delivery_google_registration_browser', 'fact_google_registration', 'google', 'browser', 'planned', 0, 0, []),
    delivery('delivery_google_registration_server', 'fact_google_registration', 'google', 'server', 'dead_letter', 3, 1, []),
    receipt('receipt_meta_browser', 'delivery_meta_browser', 'meta', 'browser_attempt', 'attempted'),
    receipt('receipt_meta_server', 'delivery_meta_server', 'meta', 'server_delivery', 'accepted'),
    receipt('receipt_tiktok_server', 'delivery_tiktok_server', 'tiktok', 'server_delivery', 'rejected'),
    receipt('receipt_google_browser', 'delivery_google_browser', 'google', 'browser_attempt', 'attempted'),
    receipt('receipt_google_server', 'delivery_google_server', 'google', 'server_delivery', 'processed'),
    receipt('receipt_google_dlq', 'delivery_google_registration_server', 'google', 'server_delivery', 'dead_letter'),
  ])
}

function connection(provider: 'meta' | 'tiktok' | 'google') {
  return db.prepare(`
    INSERT INTO attribution_platform_connections (
      id, provider, enabled, mode, browser_enabled, server_enabled,
      public_config_json, rollout_target_percentage, rollout_effective_percentage,
      connection_revision, credential_revision
    ) VALUES (?, ?, 1, 'production', 1, 1, '{}', 100, 100, 'revision_1', 'credential_1')
  `).bind(`conn_${provider}`, provider)
}

function fact(
  id: string,
  canonicalEvent: 'Contact' | 'CompleteRegistration',
  provider: 'meta' | 'tiktok' | 'google' | null,
  source: 'context' | 'none' | 'conflict',
  campaign: string,
) {
  return db.prepare(`
    INSERT INTO attribution_conversion_facts (
      id, canonical_event, fact_origin, external_event_id, attribution_provider,
      attribution_source, occurred_at, dedupe_key, consent_snapshot_json,
      analytics_dimensions_json
    ) VALUES (?, ?, 'live', ?, ?, ?, '2026-07-15T04:00:00.000Z', ?, '{}', ?)
  `).bind(
    id,
    canonicalEvent,
    `mg3_${id}`,
    provider,
    source,
    `dedupe_${id}`,
    JSON.stringify({
      visitorId: `visitor_${id}`,
      sessionId: `session_${id}`,
      sourceChannel: provider ? 'ad' : 'unknown',
      sourceName: provider || source,
      utmCampaign: campaign,
      utmContent: `${canonicalEvent}-creative`,
      trackingSourceSlug: `${provider || source}-link`,
      methodType: canonicalEvent === 'Contact' ? 'telegram' : 'email',
      actionTarget: canonicalEvent === 'Contact' ? 'contact_primary' : 'registration',
      path: canonicalEvent === 'Contact' ? '/' : '/register',
    }),
  )
}

function delivery(
  id: string,
  factId: string,
  provider: 'meta' | 'tiktok' | 'google',
  transport: 'browser' | 'server',
  status: string,
  attemptCount: number,
  queueAttemptCount: number,
  matchSignals: string[],
) {
  return db.prepare(`
    INSERT INTO attribution_deliveries (
      id, fact_id, connection_id, provider, transport, status, destination,
      match_signals_json, attempt_count, queue_attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'conversion', ?, ?, ?, '2026-07-15T04:00:00.000Z', '2026-07-15T04:00:00.000Z')
  `).bind(id, factId, `conn_${provider}`, provider, transport, status, JSON.stringify(matchSignals), attemptCount, queueAttemptCount)
}

function receipt(id: string, deliveryId: string, provider: 'meta' | 'tiktok' | 'google', type: string, status: string) {
  return db.prepare(`
    INSERT INTO attribution_provider_receipts (
      id, delivery_id, provider, receipt_type, status, receipt_json, received_at
    ) VALUES (?, ?, ?, ?, ?, '{}', '2026-07-15T04:01:00.000Z')
  `).bind(id, deliveryId, provider, type, status)
}
