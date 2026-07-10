import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'

type DbCall = { sql: string; params: unknown[] }

function createApp(role: string | null = 'admin') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin', adminRoutes)
  return app
}

function createAttributionDb(options: { failCreateBatchAt?: number } = {}) {
  const calls: DbCall[] = []
  let testAction: { id: string; occurred_at: string; date: string; path: string; metadata: string } | null = null
  let testDelivery: {
    id: string
    conversion_action_id: string
    channel: string
    external_event_id: string
    event_name: string
    status: string
    skip_reason: string
    error_code: string
    error_message: string
    attempt_count: number
  } | null = null
  let pendingDailyCount = 0
  let pendingDailyCreated = 0
  let createBatchSeen = false
  const db = {
    calls,
    get testAction() { return testAction },
    get testDelivery() { return testDelivery },
    get pendingDailyCount() { return pendingDailyCount },
    get pendingDailyCreated() { return pendingDailyCreated },
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      const statement = {
        __call: call,
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          if (sql.includes('COUNT(*) AS duplicate_action_count')) {
            return {
              results: [{ duplicate_action_count: 1 } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY date')) {
            return {
              results: [
                { date: '2026-07-09', contact_count: 3, lead_count: 1, complete_registration_count: 1, start_trial_count: 0, membership_grant_count: 0 },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY action_type')) {
            return {
              results: [
                { action_type: 'contact', action_count: 3, unique_session_count: 3 },
                { action_type: 'lead', action_count: 1, unique_session_count: 1 },
              ] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('GROUP BY source_channel')) {
            return {
              results: [
                { source_channel: 'ad', source_name: 'ad-a', utm_campaign: 'july', utm_content: 'chat-a', contact_count: 3, lead_count: 1, complete_registration_count: 1, start_trial_count: 0, membership_grant_count: 0 },
              ] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && sql.includes('SUM(action_count)') && !sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [{ action_count: 5 } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_daily') && !sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [
                { contact_count: 3, lead_count: 1, complete_registration_count: 1, start_trial_count: 0, membership_grant_count: 0 },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_actions') && sql.includes("duplicate_of != ''")) {
            return {
              results: [
                {
                  id: 'convdup_1',
                  action_type: 'contact',
                  occurred_at: '2026-07-09T10:01:00.000Z',
                  source_channel: 'ad',
                  source_name: 'ad-a',
                  tracking_source_slug: 'ad-a',
                  utm_campaign: 'old-july',
                  utm_content: 'old-chat',
                  method_type: 'telegram',
                  action_target: 'floating_contact_panel',
                  duplicate_of: 'conv_1',
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_actions')) {
            return {
              results: [
                {
                  id: 'conv_1',
                  action_type: 'contact',
                  occurred_at: '2026-07-09T10:00:00.000Z',
                  source_channel: 'ad',
                  source_name: 'ad-a',
                  tracking_source_slug: 'ad-a',
                  utm_campaign: 'july',
                  utm_content: 'chat-a',
                  method_type: 'telegram',
                  action_target: 'floating_contact_panel',
                  route_name: 'gallery-detail',
                  path: '/gallery/demo',
                  duplicate_of: '',
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily') && sql.includes('GROUP BY date')) {
            return {
              results: [
                { date: '2026-07-09', sent_count: 2, failed_count: 0, skipped_count: 1, duplicate_suppressed_count: 1 },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily') && sql.includes('GROUP BY channel')) {
            return {
              results: [
                { channel: 'meta_pixel', event_name: 'Contact', status: 'sent', skip_reason: '', delivery_count: 2 },
                { channel: 'meta_capi', event_name: 'Contact', status: 'duplicate_suppressed', skip_reason: '', delivery_count: 1 },
              ] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily')) {
            return {
              results: [
                { sent_count: 2, failed_count: 0, skipped_count: 1, duplicate_suppressed_count: 1, delivery_count: 4 },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [
                {
                  id: 'ats_1',
                  name: 'Meta 广告 A',
                  channel: 'ad',
                  slug: 'ad-a',
                  target_path: '/',
                  utm_source: 'ad-a',
                  utm_medium: 'paid_social',
                  utm_campaign: 'july',
                  utm_content: 'chat-a',
                  status: 'active',
                  note: '',
                  created_by: 1,
                  created_at: '2026-07-09T00:00:00.000Z',
                  updated_at: '2026-07-09T00:00:00.000Z',
                  visitor_count: 4,
                  session_count: 4,
                  page_view_count: 8,
                  gallery_detail_count: 3,
                  contact_click_count: 0,
                  register_count: 0,
                  membership_grant_count: 0,
                  active_seconds_total: 120,
                  contact_count: 3,
                  lead_count: 1,
                  complete_registration_count: 1,
                  start_trial_count: 0,
                  conversion_membership_grant_count: 0,
                },
              ] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('MAX(sent_at)')) {
            return {
              results: [{ last_sent_at: '2026-07-09T10:00:00.000Z' } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM site_settings')) {
            return {
              results: [
                { key: 'analytics_enabled', value: 'true' },
                { key: 'facebook_pixel_enabled', value: 'true' },
                { key: 'facebook_pixel_id', value: '1234567890' },
                { key: 'meta_capi_enabled', value: 'false' },
                { key: 'meta_capi_test_event_enabled', value: 'false' },
                { key: 'meta_tracking_mode', value: 'pixel_only' },
              ] as T[],
              meta: { rows_read: 6, rows_written: 0, duration: 1 },
            }
          }
          return { results: [] as T[], meta: { rows_read: 0, rows_written: 0, duration: 0 } }
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_conversion_deliveries d') && testAction && testDelivery) {
            return {
              ...testDelivery,
              occurred_at: testAction.occurred_at,
              date: testAction.date,
              path: testAction.path,
              metadata: testAction.metadata,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_daily')) {
            return {
              contact_count: 3,
              lead_count: 1,
              complete_registration_count: 1,
              start_trial_count: 0,
              membership_grant_count: 0,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_delivery_daily')) {
            return {
              sent_count: 2,
              failed_count: 0,
              skipped_count: 1,
              duplicate_suppressed_count: 1,
            } as T
          }
          if (sql.includes('FROM analytics_conversion_deliveries') && sql.includes('MAX(sent_at)')) {
            return { last_sent_at: '2026-07-09T10:00:00.000Z' } as T
          }
          if (sql.includes('COUNT(*) AS duplicate_action_count')) {
            return { duplicate_action_count: 1 } as T
          }
          if (sql.includes('FROM site_settings')) {
            if (sql.includes("key = 'facebook_pixel_id'")) return { value: '1234567890' } as T
            return null
          }
          return null
        },
        async run() {
          calls.push(call)
          if (sql.includes('INSERT INTO analytics_conversion_actions')) {
            testAction = {
              id: String(call.params[0] ?? ''),
              occurred_at: String(call.params[2] ?? ''),
              date: String(call.params[3] ?? ''),
              path: '/admin/attribution/meta',
              metadata: String(call.params[5] ?? '{}'),
            }
          }
          if (sql.includes('INSERT INTO analytics_conversion_deliveries')) {
            testDelivery = {
              id: String(call.params[0] ?? ''),
              conversion_action_id: String(call.params[1] ?? ''),
              channel: 'meta_capi',
              external_event_id: String(call.params[2] ?? ''),
              event_name: 'Contact',
              status: 'pending',
              skip_reason: '',
              error_code: '',
              error_message: '',
              attempt_count: 0,
            }
          }
          if (sql.includes('UPDATE analytics_conversion_deliveries') && testDelivery) {
            testDelivery.status = String(call.params[0] ?? '')
            testDelivery.skip_reason = String(call.params[1] ?? '')
            testDelivery.error_code = String(call.params[2] ?? '')
            testDelivery.error_message = String(call.params[3] ?? '')
            testDelivery.attempt_count += 1
          }
          if (sql.includes('INSERT INTO analytics_conversion_delivery_daily') && sql.includes("'pending'")) {
            pendingDailyCount += 1
            pendingDailyCreated += 1
          }
          if (sql.includes('UPDATE analytics_conversion_delivery_daily') && call.params[3] === 'pending') {
            pendingDailyCount = Math.max(0, pendingDailyCount - 1)
          }
          return { meta: { changes: 1, rows_read: 0, rows_written: 1, duration: 1 } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const isCreateBatch = !createBatchSeen && statements.length === 3
      if (isCreateBatch) createBatchSeen = true
      const snapshot = {
        testAction: testAction ? { ...testAction } : null,
        testDelivery: testDelivery ? { ...testDelivery } : null,
        pendingDailyCount,
        pendingDailyCreated,
      }
      const results = []
      try {
        for (let index = 0; index < statements.length; index += 1) {
          if (isCreateBatch && options.failCreateBatchAt === index + 1) throw new Error('模拟 Test Event 创建失败')
          results.push(await statements[index]!.run())
        }
        return results
      } catch (error) {
        testAction = snapshot.testAction
        testDelivery = snapshot.testDelivery
        pendingDailyCount = snapshot.pendingDailyCount
        pendingDailyCreated = snapshot.pendingDailyCreated
        throw error
      }
    },
  }
  return db
}

describe('后台归因中心 API', () => {
  it('要求 admin+ 才能访问归因总览', async () => {
    const res = await createApp(null).request('/api/admin/attribution/overview?range=7d', {}, { DB: createAttributionDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('总览返回转化趋势、Meta 状态和重复诊断', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/overview?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.range).toMatchObject({ from: '2026-07-09', to: '2026-07-09', days: 1 })
    expect(body.usage.rowsRead).toBeGreaterThan(0)
    expect(body.data.totals.contact_count).toBe(3)
    expect(body.data.meta.sent_count).toBe(2)
    expect(body.data.duplicates.duplicate_suppressed_count).toBe(1)
    expect(body.data.trend[0]).toMatchObject({ date: '2026-07-09', contact_count: 3 })
    expect(Array.isArray(body.data.risks)).toBe(true)
  })

  it('返回转化动作、来源和最近样本', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/conversions?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.byAction[0]).toMatchObject({ action_type: 'contact', action_count: 3 })
    expect(body.data.bySource[0]).toMatchObject({ source_name: 'ad-a', contact_count: 3 })
    expect(body.data.samples[0]).toMatchObject({ id: 'conv_1', action_type: 'contact' })
  })

  it('转化接口支持按 sourceCode 过滤', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/conversions?from=2026-07-09&to=2026-07-09&sourceCode=ad-a', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.bySource[0]).toMatchObject({ source_name: 'ad-a', contact_count: 3 })
    const sourceSqlCalls = db.calls.filter(call => call.sql.includes('analytics_conversion_daily') || call.sql.includes('analytics_conversion_actions'))
    expect(sourceSqlCalls.some(call => call.sql.includes('source_name = ?') && call.params.includes('ad-a'))).toBe(true)
    expect(sourceSqlCalls.some(call => call.sql.includes('tracking_source_slug = ?') && call.params.includes('ad-a'))).toBe(true)
  })

  it('返回投放追踪链接和转化指标', async () => {
    const db = createAttributionDb()
    const res = await createApp('admin').request('/api/admin/attribution/links?from=2026-07-09&to=2026-07-09', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.links[0]).toMatchObject({
      sourceLabel: 'Meta 广告 A',
      utmContent: 'chat-a',
      contactCount: 3,
      leadCount: 1,
      completeRegistrationCount: 1,
    })
    expect(body.data.links[0].trackingPath).toContain('utm_content=chat-a')
    const linkSql = db.calls.find(call => call.sql.includes('WITH conversion_metrics'))
    expect(linkSql?.sql).toContain('GROUP BY source_name')
    expect(linkSql?.sql).not.toContain('cm.utm_campaign')
    expect(linkSql?.sql).not.toContain('cm.utm_content')
  })

  it('返回 Meta 投递状态和配置', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/meta?from=2026-07-09&to=2026-07-09', {}, {
      DB: createAttributionDb(),
      META_CAPI_ACCESS_TOKEN: 'secret-token',
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.totals).toMatchObject({ sent_count: 2, failed_count: 0, duplicate_suppressed_count: 1 })
    expect(body.data.deliveries[0]).toMatchObject({ channel: 'meta_pixel', event_name: 'Contact' })
    expect(body.data.settings.facebook_pixel_id).toBe('1234567890')
    expect(body.data.secretPresent).toBe(true)
    expect(JSON.stringify(body)).not.toContain('secret-token')
  })

  it('返回重复诊断和重复样本', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/duplicates?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.duplicateSuppressedCount).toBe(1)
    expect(body.data.duplicateActionCount).toBe(1)
    expect(body.data.samples[0]).toMatchObject({ id: 'convdup_1', duplicate_of: 'conv_1' })
  })

  it('返回归因上线检查状态', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/readiness?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.ready).toBe(true)
    expect(body.data.checks.map((check: { key: string }) => check.key)).toEqual([
      'analytics_enabled',
      'conversion_ledger',
      'meta_failures',
      'pixel_id',
    ])
  })

  it('非 owner 不能触发 Test Event', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, { DB: createAttributionDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('owner 触发 Test Event 会写审计日志且不写污染性文案', async () => {
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(202)
    expect(body.data.status).toBe('skipped')
    expect(body.data.reason).toBe('missing_secret')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'attribution.meta_test_event')).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(true)
    expect(db.pendingDailyCreated).toBe(1)
    expect(db.pendingDailyCount).toBe(0)
    expect(JSON.stringify(db.calls)).not.toContain('Meta 像素测试地址')
  })

  it.each([1, 2, 3])('Test Event 创建 batch 第 %i 步失败时回滚 action、delivery 和 pending 桶', async failCreateBatchAt => {
    const db = createAttributionDb({ failCreateBatchAt })
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(500)
    expect(db.testAction).toBeNull()
    expect(db.testDelivery).toBeNull()
    expect(db.pendingDailyCount).toBe(0)
    expect(db.pendingDailyCreated).toBe(0)
  })
})
