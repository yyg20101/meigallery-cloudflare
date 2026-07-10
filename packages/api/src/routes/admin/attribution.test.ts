import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'

type DbCall = { sql: string; params: unknown[] }

type ReadinessOptions = {
  schemaTableCount?: number
  actionCount?: number
  retryExhaustedCount?: number
  externalEventIdMismatchCount?: number
  pendingTooLongCount?: number
  permanentFailureCount?: number
  fbpSampleCount?: number
  fbpMatchedCount?: number
  fbcSampleCount?: number
  fbcMatchedCount?: number
  pixelAttemptedCount?: number
  capiSentCount?: number
  liveVerificationPresent?: boolean
  resourcesVerificationPresent?: boolean
  lastManualConfirmationAt?: string
}

type AttributionDbOptions = {
  failCreateBatchAt?: number
  settings?: Partial<Record<string, string | boolean>>
  readiness?: ReadinessOptions
}

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

function createAttributionDb(options: AttributionDbOptions = {}) {
  const calls: DbCall[] = []
  const settings = {
    analytics_enabled: true,
    facebook_pixel_enabled: true,
    facebook_pixel_id: '1234567890',
    meta_capi_enabled: false,
    meta_tracking_mode: 'test',
    ...options.settings,
  }
  const readiness = {
    schemaTableCount: 4,
    actionCount: 5,
    retryExhaustedCount: 0,
    externalEventIdMismatchCount: 0,
    pendingTooLongCount: 0,
    permanentFailureCount: 0,
    fbpSampleCount: 10,
    fbpMatchedCount: 8,
    fbcSampleCount: 10,
    fbcMatchedCount: 7,
    pixelAttemptedCount: 2,
    capiSentCount: 1,
    liveVerificationPresent: true,
    resourcesVerificationPresent: true,
    lastManualConfirmationAt: new Date().toISOString(),
    ...options.readiness,
  }
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
          if (sql.includes('FROM sqlite_master')) {
            return {
              results: [{ table_count: readiness.schemaTableCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS retry_exhausted_count')) {
            return {
              results: [{ retry_exhausted_count: readiness.retryExhaustedCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS external_event_id_mismatch_count')) {
            return {
              results: [{ external_event_id_mismatch_count: readiness.externalEventIdMismatchCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS pending_too_long_count')) {
            return {
              results: [{ pending_too_long_count: readiness.pendingTooLongCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS permanent_failure_count')) {
            return {
              results: [{ permanent_failure_count: readiness.permanentFailureCount } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS fbp_sample_count')) {
            return {
              results: [{
                fbp_sample_count: readiness.fbpSampleCount,
                fbp_matched_count: readiness.fbpMatchedCount,
                fbc_sample_count: readiness.fbcSampleCount,
                fbc_matched_count: readiness.fbcMatchedCount,
              } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('AS pixel_attempted_count') && sql.includes('AS capi_sent_count')) {
            return {
              results: [{
                pixel_attempted_count: readiness.pixelAttemptedCount,
                pixel_pending_count: 0,
                pixel_skipped_count: 0,
                capi_sent_count: readiness.capiSentCount,
                capi_failed_count: 0,
                capi_skipped_count: 0,
                duplicate_suppressed_count: 1,
              } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_release_verifications') && sql.includes('GROUP BY verification_type')) {
            const results = []
            if (readiness.liveVerificationPresent) {
              results.push({ verification_type: 'meta_live', verified_at: '2026-07-10T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' })
            }
            if (readiness.resourcesVerificationPresent) {
              results.push({ verification_type: 'meta_resources', verified_at: '2026-07-10T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' })
            }
            return {
              results: results as T[],
              meta: { rows_read: results.length, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_release_verifications') && sql.includes('last_manual_confirmation_at')) {
            return {
              results: [{ last_manual_confirmation_at: readiness.lastManualConfirmationAt } as T],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
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
              results: [{ action_count: readiness.actionCount } as T],
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
                { channel: 'meta_pixel', event_name: 'Contact', status: 'attempted', skip_reason: '', delivery_count: 2 },
                { channel: 'meta_capi', event_name: 'Contact', status: 'sent', skip_reason: '', delivery_count: 1 },
                { channel: 'meta_capi', event_name: 'Contact', status: 'duplicate_suppressed', skip_reason: '', delivery_count: 1 },
              ] as T[],
              meta: { rows_read: 3, rows_written: 0, duration: 1 },
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
              results: Object.entries(settings).map(([key, value]) => ({ key, value: JSON.stringify(value) })) as T[],
              meta: { rows_read: Object.keys(settings).length, rows_written: 0, duration: 1 },
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
            if (sql.includes("key = 'facebook_pixel_id'")) return { value: JSON.stringify(settings.facebook_pixel_id) } as T
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

const VALID_RELEASE_COMMIT = 'a'.repeat(40)
const VALID_READINESS_ENV = {
  META_CAPI_ACCESS_TOKEN: 'secret-token',
  META_CAPI_TEST_EVENT_CODE: 'test-code',
  META_CAPI_QUEUE: { send: async () => undefined },
  RELEASE_COMMIT: VALID_RELEASE_COMMIT,
  APP_ENV: 'dev',
}

async function requestReadiness(
  dbOptions: AttributionDbOptions = {},
  envOverrides: Partial<Bindings> = {},
) {
  const db = createAttributionDb(dbOptions)
  const res = await createApp('admin').request(
    '/api/admin/attribution/readiness?from=2026-07-09&to=2026-07-09',
    {},
    { DB: db, ...VALID_READINESS_ENV, ...envOverrides } as unknown as Bindings,
  )
  return { db, res, body: await res.json() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
      META_CAPI_TEST_EVENT_CODE: 'test-code',
      META_CAPI_QUEUE: { send: async () => undefined },
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.totals).toMatchObject({
      pixel_attempted_count: 2,
      capi_sent_count: 1,
      capi_failed_count: 0,
      retry_exhausted_count: 0,
      duplicate_suppressed_count: 1,
    })
    expect(body.data.deliveries[0]).toMatchObject({ channel: 'meta_pixel', event_name: 'Contact' })
    expect(body.data.settings.facebook_pixel_id).toBe('1234567890')
    expect(body.data.secretPresent).toBe(true)
    expect(body.data.testEventCodePresent).toBe(true)
    expect(body.data.queueBindingPresent).toBe(true)
    expect(JSON.stringify(body)).not.toContain('secret-token')
    expect(JSON.stringify(body)).not.toContain('test-code')
  })

  it('Meta 匹配覆盖率固定使用近 7 天合格 CAPI 与 Meta 付费样本', async () => {
    const db = createAttributionDb({
      readiness: {
        fbpSampleCount: 25,
        fbpMatchedCount: 20,
        fbcSampleCount: 20,
        fbcMatchedCount: 14,
      },
    })
    const res = await createApp('admin').request('/api/admin/attribution/meta?range=30d', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.matchQuality).toMatchObject({
      fbpCoverage: 0.8,
      fbpSampleCount: 25,
      fbcCoverage: 0.7,
      fbcSampleCount: 20,
    })
    const coverageSql = db.calls.find(call => call.sql.includes('AS fbp_sample_count'))?.sql ?? ''
    expect(coverageSql).toContain("date('now', '-6 days')")
    expect(coverageSql).toContain("d.status IN ('pending', 'sent', 'failed', 'duplicate_suppressed')")
    expect(coverageSql).toContain("a.source_channel = 'ad'")
    expect(coverageSql).toContain("lower(a.utm_source) IN ('facebook', 'fb', 'meta', 'instagram')")
    expect(coverageSql).not.toContain("d.status = 'skipped'")
  })

  it('返回重复诊断和重复样本', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/duplicates?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.duplicateSuppressedCount).toBe(1)
    expect(body.data.duplicateActionCount).toBe(1)
    expect(body.data.samples[0]).toMatchObject({ id: 'convdup_1', duplicate_of: 'conv_1' })
  })

  it('返回分层归因上线检查且 ready 只由 blocker 决定', async () => {
    const { res, body } = await requestReadiness({ readiness: { pendingTooLongCount: 1 } })

    expect(res.status).toBe(200)
    expect(body.data.ready).toBe(true)
    expect(body.data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'meta_live_verification', level: 'blocker', ok: true }),
      expect.objectContaining({ key: 'meta_resources_verification', level: 'blocker', ok: true }),
      expect.objectContaining({ key: 'pending_too_long', level: 'warning', ok: false }),
    ]))
  })

  it.each([
    ['conversion_schema', { readiness: { schemaTableCount: 3 } }, {}],
    ['analytics_enabled', { settings: { analytics_enabled: false } }, {}],
    ['conversion_ledger', { readiness: { actionCount: 0 } }, {}],
    ['pixel_mode_consistency', { settings: { facebook_pixel_enabled: false } }, {}],
    ['capi_secret', {}, { META_CAPI_ACCESS_TOKEN: undefined }],
    ['test_event_code', {}, { META_CAPI_TEST_EVENT_CODE: undefined }],
    ['queue_binding', {}, { META_CAPI_QUEUE: undefined }],
    ['meta_live_verification', {}, { RELEASE_COMMIT: 'not-a-full-commit' }],
    ['meta_live_verification', { readiness: { liveVerificationPresent: false } }, {}],
    ['meta_resources_verification', { readiness: { resourcesVerificationPresent: false } }, {}],
    ['retry_exhausted', { readiness: { retryExhaustedCount: 1 } }, {}],
    ['external_event_id_consistency', { readiness: { externalEventIdMismatchCount: 1 } }, {}],
  ] as const)('blocker %s 独立失败时 readiness 不通过', async (key, dbOptions, envOverrides) => {
    const { body } = await requestReadiness(dbOptions, envOverrides as Partial<Bindings>)
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'blocker', ok: false })
    expect(body.data.ready).toBe(false)
  })

  it.each([
    ['pending_too_long', { pendingTooLongCount: 1 }],
    ['permanent_failure', { permanentFailureCount: 1 }],
    ['fbp_coverage', { fbpSampleCount: 20, fbpMatchedCount: 15 }],
    ['fbc_coverage', { fbcSampleCount: 20, fbcMatchedCount: 13 }],
    ['capi_delivery_ratio', { pixelAttemptedCount: 20, capiSentCount: 15 }],
    ['manual_confirmation', { lastManualConfirmationAt: '2026-01-01T00:00:00.000Z' }],
  ] as const)('warning %s 独立异常时不阻断 ready', async (key, readinessOverride) => {
    const { body } = await requestReadiness({ readiness: readinessOverride })
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'warning', ok: false })
    expect(body.data.ready).toBe(true)
  })

  it.each([
    ['fbp_coverage', { fbpSampleCount: 19, fbpMatchedCount: 0 }],
    ['fbc_coverage', { fbcSampleCount: 19, fbcMatchedCount: 0 }],
    ['capi_delivery_ratio', { pixelAttemptedCount: 19, capiSentCount: 0 }],
  ] as const)('%s 样本不足时不判定质量异常', async (key, readinessOverride) => {
    const { body } = await requestReadiness({ readiness: readinessOverride })
    const check = body.data.checks.find((item: { key: string }) => item.key === key)

    expect(check).toMatchObject({ key, level: 'warning', ok: true })
    expect(check.detail).toContain('样本不足')
  })

  it('非 owner 不能触发 Test Event', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, { DB: createAttributionDb() } as unknown as Bindings)
    expect(res.status).toBe(403)
  })

  it('非 test 模式拒绝 Test Event 并写入脱敏审计', async () => {
    const db = createAttributionDb({ settings: { meta_tracking_mode: 'production' } })
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)

    expect(res.status).toBe(409)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
  })

  it.each([
    ['token', {}, { META_CAPI_ACCESS_TOKEN: undefined }],
    ['Test Event Code', {}, { META_CAPI_TEST_EVENT_CODE: undefined }],
    ['Pixel ID', { settings: { facebook_pixel_id: '' } }, {}],
  ])('缺少 %s 时 Test Event 返回 503 并审计', async (_label, dbOptions, envOverrides) => {
    const db = createAttributionDb(dbOptions as AttributionDbOptions)
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
      ...envOverrides,
    } as unknown as Bindings)

    expect(res.status).toBe(503)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(false)
  })

  it('Meta 确认接收 1 条 Test Event 时返回 200 且不泄露临时数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-safe' }), { status: 200 })))
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'Task7-Test-Agent/1.0',
      },
    }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      status: 'sent',
      eventsReceived: 1,
      traceId: 'trace-safe',
      secretPresent: true,
      testEventCodePresent: true,
      pixelIdPresent: true,
    })
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'attribution.meta_test_event')).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_conversion_deliveries'))).toBe(true)
    expect(db.pendingDailyCreated).toBe(1)
    expect(db.pendingDailyCount).toBe(0)
    const serialized = JSON.stringify({ body, calls: db.calls })
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('test-code')
    expect(serialized).not.toContain('203.0.113.24')
    expect(serialized).not.toContain('Task7-Test-Agent/1.0')
  })

  it.each(['203.0.113.24', 'test-code'])('Test Event 丢弃回显敏感值的 traceId：%s', async sensitiveTraceId => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      events_received: 1,
      fbtrace_id: sensitiveTraceId,
    }), { status: 200 })))
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.24',
        'User-Agent': 'Task7-Test-Agent/1.0',
      },
    }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(JSON.stringify({ body, calls: db.calls })).not.toContain(sensitiveTraceId)
  })

  it.each([
    ['permanent', 400, 424],
    ['events_not_received', 200, 424],
    ['retryable', 500, 503],
  ] as const)('Meta %s 结果不会返回成功状态', async (_kind, metaStatus, expectedStatus) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify(metaStatus === 200 ? { events_received: 0 } : { error: { message: 'sensitive upstream error' } }),
      { status: metaStatus },
    )))
    const db = createAttributionDb()
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(expectedStatus)
    expect(body.data?.status).not.toBe('sent')
    expect(JSON.stringify({ body, calls: db.calls })).not.toContain('sensitive upstream error')
  })

  it.each([1, 2, 3])('Test Event 创建 batch 第 %i 步失败时回滚 action、delivery 和 pending 桶', async failCreateBatchAt => {
    const db = createAttributionDb({ failCreateBatchAt })
    const res = await createApp('owner').request('/api/admin/attribution/meta/test-event', { method: 'POST' }, {
      DB: db,
      ...VALID_READINESS_ENV,
    } as unknown as Bindings)

    expect(res.status).toBe(500)
    expect(db.testAction).toBeNull()
    expect(db.testDelivery).toBeNull()
    expect(db.pendingDailyCount).toBe(0)
    expect(db.pendingDailyCreated).toBe(0)
  })
})
