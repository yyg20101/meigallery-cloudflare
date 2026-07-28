import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
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

function createDb() {
  const calls: DbCall[] = []
  const db = {
    calls,
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          if (sql.includes('FROM attribution_conversion_facts')) {
            return {
              results: [{
                date: '2026-06-07',
                source_channel: 'search',
                source_name: 'google.com',
                route_name: '/gallery/:slug',
                path: '/gallery/demo',
                session_id: 'session_abcdef',
                invite_code_id: '',
                contact_click_count: 1,
                register_count: 1,
              }] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [{
                id: 'ats_1',
                name: 'Telegram 六月互推',
                channel: 'social',
                slug: 'telegram-june',
                target_path: '/',
                utm_source: 'telegram-june',
                utm_medium: 'social',
                utm_campaign: 'telegram-june',
                status: 'active',
                note: '',
                created_by: 1,
                created_at: '2026-06-07T00:00:00.000Z',
                updated_at: '2026-06-07T00:00:00.000Z',
                visitor_count: 2,
                session_count: 3,
                page_view_count: 9,
                gallery_detail_count: 4,
                contact_click_count: 1,
                register_count: 1,
                membership_grant_count: 0,
                active_seconds_total: 90,
              }] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('FROM analytics_events')) {
            return {
              results: [{
                id: 'event_1',
                event_name: 'media_access_denied',
                occurred_at: '2026-06-07T10:00:00.000Z',
                route_name: '/media/access',
                path: '/gallery/gallery-1',
                page_title: '',
                entity_type: 'media',
                entity_id: 'asset-1',
                event_props: '{"asset_id":"asset-1","reason":"rank_insufficient"}',
                value: null,
                sampled: 0,
              }] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_source_page_daily') && sql.includes("source_channel = 'search'")) {
            return {
              results: [{
                route_name: '/gallery/:slug',
                path: '/gallery/demo',
                entity_type: 'gallery',
                entity_id: 'gallery-1',
                page_title: '夏日写真',
                page_view_count: 6,
                visitor_count: 3,
                session_count: 4,
                entry_count: 3,
                exit_count: 1,
                bounce_count: 1,
                active_seconds_total: 180,
                max_scroll_depth: 86,
                register_count: 1,
                contact_click_count: 1,
                bounce_rate: 0.3333,
                average_active_seconds: 30,
                contact_rate: 0.25,
                register_rate: 0.25,
              }] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_source_page_daily')) {
            return {
              results: [{
                source_channel: 'social',
                source_name: 'telegram-june',
                tracking_source_label: 'Telegram 六月互推',
                source_matched: 1,
                invite_code_id: '',
                route_name: '/gallery/:slug',
                path: '/gallery/demo',
                entity_type: 'gallery',
                entity_id: 'gallery-1',
                page_title: '夏日写真',
                page_view_count: 5,
                visitor_count: 2,
                session_count: 3,
                contact_click_count: 1,
                register_count: 1,
              }] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_source_click_daily')) {
            return {
              results: [{
                source_channel: 'social',
                source_name: 'telegram-june',
                tracking_source_label: 'Telegram 六月互推',
                source_matched: 1,
                invite_code_id: '',
                element_id: 'contact_method_click',
                element_type: 'button',
                location: 'floating_contact_panel',
                target_type: 'contact',
                target_id: 'floating_contact_panel',
                raw_click_count: 2,
                effective_click_count: 2,
                duplicate_click_count: 0,
                visitor_count: 2,
                session_count: 2,
              }] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_daily_sources') && sql.includes("source_channel = 'search'") && sql.includes('GROUP BY date')) {
            return {
              results: [{
                date: '2026-06-07',
                visitor_count: 3,
                session_count: 4,
                page_view_count: 8,
                gallery_detail_count: 2,
                register_count: 1,
                contact_click_count: 1,
                membership_grant_count: 0,
              }] as T[],
              meta: { rows_read: 3, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_daily_sources') && sql.includes("source_channel = 'search'") && sql.includes('GROUP BY source_channel, source_name')) {
            return {
              results: [{
                source_channel: 'search',
                source_name: 'google.com',
                invite_code_id: '',
                visitor_count: 3,
                session_count: 4,
                page_view_count: 8,
                gallery_detail_count: 2,
                register_count: 1,
                contact_click_count: 1,
                membership_grant_count: 0,
                active_seconds_total: 120,
                average_active_seconds: 30,
                contact_rate: 0.25,
                register_rate: 0.25,
              }] as T[],
              meta: { rows_read: 3, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_daily_sources')) {
            return {
              results: [{
                source_channel: 'invite',
                source_name: '活动',
                invite_code_id: 'inv_1',
                session_count: 3,
                register_count: 1,
              }] as T[],
              meta: { rows_read: 3, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_daily_pages')) {
            return {
              results: [{
                route_name: '/gallery/:slug',
                path: '/gallery/demo',
                page_view_count: 5,
                active_seconds_total: 120,
              }] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_click_daily') && sql.includes('all_contact_methods')) {
            return {
              results: [{
                element_id: 'contact_method_click',
                element_type: 'button',
                location: 'contact_panel',
                target_type: 'contact',
                target_id: 'all_contact_methods',
                raw_click_count: 5,
                effective_click_count: 4,
              }] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          if (sql.includes('analytics_click_daily')) {
            return {
              results: [{
                element_id: 'contact_method_click',
                raw_click_count: 2,
                effective_click_count: 2,
              }] as T[],
              meta: { rows_read: 2, rows_written: 0, duration: 1 },
            }
          }
          return { results: [] as T[], meta: { rows_read: 1, rows_written: 0, duration: 1 } }
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_export_jobs')) {
            return {
              id: 'aexp_1',
              status: 'completed',
              kind: 'sources',
              range_from: '2026-06-01',
              range_to: '2026-06-07',
              filters_json: '{}',
              r2_key: 'analytics/exports/aexp_1.csv',
              expires_at: '2026-06-14T00:00:00.000Z',
              created_by: 1,
              created_at: '2026-06-07T00:00:00.000Z',
              completed_at: '2026-06-07T00:00:01.000Z',
              error_message: '',
            } as T
          }
          if (sql.includes('FROM analytics_session_summaries')) {
            return {
              session_id: 'session_abcdef',
              date: '2026-06-07',
              started_at: '2026-06-07T10:00:00.000Z',
              ended_at: null,
              source_channel: 'invite',
              source_name: '活动',
              invite_code_id: 'inv_1',
              device_type: 'desktop',
              country: 'CN',
              entry_path: '/',
              exit_path: '/gallery/demo',
              page_view_count: 2,
              active_seconds: 60,
              click_count: 1,
              membership_grant_count: 0,
              is_bounce: 0,
            } as T
          }
          if (sql.includes('FROM attribution_conversion_facts')) {
            return {
              contact_click_count: 1,
              register_count: 1,
            } as T
          }
          if (sql.includes('analytics_click_daily') && sql.includes('key_click_count')) {
            return {
              key_click_count: 2,
            } as T
          }
          if (sql.includes('analytics_click_daily')) {
            return {
              raw_contact_click_count: 2,
              effective_contact_click_count: 2,
              duplicate_contact_click_count: 0,
            } as T
          }
          if (sql.includes('analytics_ingest_health_daily')) {
            return {
              accepted_count: 10,
              rejected_count: 1,
              duplicate_count: 0,
              sensitive_blocked_count: 0,
              estimated_rows_read: 20,
              estimated_rows_written: 30,
              last_ingested_at: '2026-06-07T10:00:00.000Z',
            } as T
          }
          if (sql.includes('analytics_source_page_daily') && sql.includes("source_channel = 'search'")) {
            return {
              landing_count: 3,
              bounce_count: 1,
              landing_active_seconds_total: 180,
              max_scroll_depth: 86,
            } as T
          }
          if (sql.includes('analytics_daily_sources') && sql.includes('total_session_count')) {
            return {
              total_session_count: 8,
              total_page_view_count: 16,
            } as T
          }
          if (sql.includes('analytics_daily_sources') && sql.includes("source_channel = 'search'")) {
            return {
              visitor_count: 3,
              session_count: 4,
              page_view_count: 8,
              gallery_detail_count: 2,
              register_count: 1,
              contact_click_count: 1,
              membership_grant_count: 0,
              active_seconds_total: 120,
            } as T
          }
          if (sql.includes('analytics_daily_sources')) {
            return {
              visitor_count: 2,
              session_count: 3,
              page_view_count: 9,
              gallery_detail_count: 4,
              register_count: 22,
              invite_register_count: 1,
              contact_click_count: 22,
              membership_grant_count: 0,
              active_seconds_total: 90,
            } as T
          }
          return null
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

function createPerformanceDb() {
  const calls: DbCall[] = []
  const db = {
    calls,
    prepare(sql: string) {
      const call: DbCall = { sql, params: [] }
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async all<T>() {
          calls.push(call)
          return {
            results: [] as T[],
            meta: performanceMeta(sql),
          }
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('analytics_click_daily') && sql.includes('key_click_count')) {
            return {
              key_click_count: 0,
            } as T
          }
          if (sql.includes('analytics_click_daily')) {
            return {
              raw_contact_click_count: 0,
              effective_contact_click_count: 0,
              duplicate_contact_click_count: 0,
            } as T
          }
          return {
            accepted_count: 0,
            rejected_count: 0,
            duplicate_count: 0,
            sensitive_blocked_count: 0,
            estimated_rows_read: 0,
            estimated_rows_written: 0,
            last_ingested_at: null,
          } as T
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1, rows_written: 1, rows_read: 0, duration: 1 } }
        },
      }
    },
  }
  return db
}

function performanceMeta(sql: string) {
  if (sql.includes('analytics_source_page_daily')) return { rows_read: 3_000, rows_written: 0, duration: 120 }
  if (sql.includes('analytics_source_click_daily')) return { rows_read: 1_500, rows_written: 0, duration: 90 }
  if (sql.includes('analytics_daily_pages')) return { rows_read: 3_000, rows_written: 0, duration: 120 }
  if (sql.includes('analytics_path_edges')) return { rows_read: 2_500, rows_written: 0, duration: 110 }
  if (sql.includes('analytics_click_daily')) return { rows_read: 1_500, rows_written: 0, duration: 90 }
  if (sql.includes('analytics_invite_daily')) return { rows_read: 500, rows_written: 0, duration: 60 }
  if (sql.includes('analytics_ingest_health_daily')) return { rows_read: 30, rows_written: 0, duration: 20 }
  if (sql.includes('analytics_daily_sources')) return { rows_read: 900, rows_written: 0, duration: 80 }
  return { rows_read: 100, rows_written: 0, duration: 50 }
}

describe('后台数据分析 API', () => {
  it('父级后台路由要求 admin+ 才能访问分析总览', async () => {
    const res = await createApp(null).request('/api/admin/analytics/overview', {}, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('ADMIN_REQUIRED')
  })

  it('总览默认读取聚合表并返回成本 usage', async () => {
    const db = createDb()
    const res = await createApp('admin').request('/api/admin/analytics/overview?range=7d', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.range.days).toBe(7)
    expect(body.data.totals.average_active_seconds).toBe(30)
    expect(body.data.totals.gallery_detail_count).toBe(4)
    expect(body.data.totals.effective_contact_click_count).toBe(1)
    expect(body.data.totals.register_count).toBe(1)
    expect(body.data.topSources[0].source_channel).toBe('invite')
    expect(body.data.topClicks).toHaveLength(1)
    expect(body.data.topClicks[0]).toMatchObject({
      element_label: '联系方式',
      location_label: '联系面板',
      raw_click_count: 5,
      effective_click_count: 4,
    })
    expect(body.data.funnel.stages[0].label).toBe('Session')
    expect(body.usage.rowsRead).toBeGreaterThan(0)
    expect(db.calls.some(call => call.sql.includes('analytics_events'))).toBe(false)
  })

  it('非法日期范围返回统一错误体', async () => {
    const res = await createApp('admin').request('/api/admin/analytics/sources?from=bad&to=2026-06-07', {}, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toMatchObject({ code: 'ANALYTICS_RANGE_INVALID' })
  })

  it('来源分析返回已创建推广来源的表现', async () => {
    const res = await createApp('admin').request('/api/admin/analytics/sources?range=7d', {}, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.trackingSources[0]).toMatchObject({
      name: 'Telegram 六月互推',
      sourceLabel: 'Telegram 六月互推',
      sourceCode: 'telegram-june',
      trackingPath: '/?mg_source=telegram-june&utm_source=telegram-june&utm_medium=social&utm_campaign=telegram-june',
      sessionCount: 3,
    })
  })

  it('来源页面和来源点击接口返回中文展示字段且不扫描原始事件', async () => {
    const db = createDb()
    const pagesRes = await createApp('admin').request('/api/admin/analytics/source-pages?range=7d&sourceCode=telegram-june', {}, { DB: db } as unknown as Bindings)
    const pagesBody = await pagesRes.json()
    const clicksRes = await createApp('admin').request('/api/admin/analytics/source-clicks?range=7d&sourceCode=telegram-june', {}, { DB: db } as unknown as Bindings)
    const clicksBody = await clicksRes.json()

    expect(pagesRes.status).toBe(200)
    expect(pagesBody.data[0]).toMatchObject({
      sourceLabel: 'Telegram 六月互推',
      route_label: '夏日写真',
    })
    expect(clicksRes.status).toBe(200)
    expect(clicksBody.data[0]).toMatchObject({
      sourceLabel: 'Telegram 六月互推',
      element_label: '联系方式',
      location_label: '悬浮联系面板',
    })
    expect(db.calls.some(call => call.sql.includes('analytics_events'))).toBe(false)
  })

  it('SEO 分析只读取自然搜索聚合并返回落地页口径说明', async () => {
    const db = createDb()
    const res = await createApp('admin').request('/api/admin/analytics/seo?range=7d', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.totals.search_session_share).toBe(0.5)
    expect(body.data.totals.landing_bounce_rate).toBe(0.3333)
    expect(body.data.referrers[0]).toMatchObject({
      source_channel: 'search',
      sourceLabel: 'Google',
      register_rate: 0.25,
    })
    expect(body.data.landingPages[0]).toMatchObject({
      route_label: '夏日写真',
      bounce_rate: 0.3333,
      contact_rate: 0.25,
    })
    expect(body.data.notes.limitation).toContain('Google Search Console')
    expect(db.calls.some(call => call.sql.includes('analytics_events'))).toBe(false)
  })

  it('漏斗接口读取聚合表并返回阶段转化', async () => {
    const db = createDb()
    const res = await createApp('admin').request('/api/admin/analytics/funnel?range=7d&sourceCode=telegram-june', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.stages.map((stage: Record<string, unknown>) => stage.key)).toEqual([
      'sessions',
      'page_views',
      'gallery_details',
      'key_clicks',
      'contacts_or_registers',
      'membership_grants',
    ])
    expect(body.data.dropOffs.length).toBeGreaterThan(0)
    expect(db.calls.some(call => call.sql.includes('analytics_events'))).toBe(false)
  })

  it('普通 admin 不能查看单 session 明细', async () => {
    const res = await createApp('admin').request('/api/admin/analytics/sessions/session_abcdef', {}, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('OWNER_REQUIRED')
  })

  it('owner 查看 session 明细只返回脱敏字段并写审计日志', async () => {
    const db = createDb()
    const res = await createApp('owner').request('/api/admin/analytics/sessions/session_abcdef', {}, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.summary.session_id).toBe('session_abcdef')
    expect(body.data.events[0].event_props).toMatchObject({ reason: 'rank_insufficient' })
    expect(JSON.stringify(body)).not.toContain('visitor_id')
    expect(JSON.stringify(body)).not.toContain('user_id')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'analytics.session.view')).toBe(true)
  })

  it('owner 可以创建导出任务并写入 R2 和审计日志', async () => {
    const db = createDb()
    const r2Put = vi.fn(async () => null)
    const res = await createApp('owner').request('/api/admin/analytics/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'sources', range: '7d' }),
    }, {
      DB: db,
      R2: { put: r2Put },
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data.status).toBe('completed')
    expect(r2Put).toHaveBeenCalledWith(expect.stringMatching(/^analytics\/exports\/aexp_/), expect.stringContaining('source_channel'), expect.any(Object))
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'analytics.export.create')).toBe(true)
  })

  it('100,000 事件规模聚合 fixture 下 30 天报表保持预算内', async () => {
    const db = createPerformanceDb()
    const endpoints = [
      '/api/admin/analytics/overview?range=30d',
      '/api/admin/analytics/sources?range=30d',
      '/api/admin/analytics/seo?range=30d',
      '/api/admin/analytics/pages?range=30d',
      '/api/admin/analytics/source-pages?range=30d',
      '/api/admin/analytics/clicks?range=30d',
      '/api/admin/analytics/source-clicks?range=30d',
      '/api/admin/analytics/funnel?range=30d',
      '/api/admin/analytics/durations?range=30d',
      '/api/admin/analytics/invites?range=30d',
    ]

    const durations: number[] = []
    for (const endpoint of endpoints) {
      const res = await createApp('admin').request(endpoint, {}, { DB: db } as unknown as Bindings)
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.usage.rowsRead).toBeLessThanOrEqual(10_000)
      expect(body.usage.durationMs).toBeLessThanOrEqual(1_000)
      durations.push(body.usage.durationMs)
    }

    const sorted = durations.toSorted((a, b) => a - b)
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
    expect(p95).toBeLessThanOrEqual(1_000)
    expect(db.calls.some(call => call.sql.includes('analytics_events'))).toBe(false)
  })
})
