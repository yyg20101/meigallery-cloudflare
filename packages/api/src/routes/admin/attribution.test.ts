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

function createAttributionDb() {
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
          return { results: [] as T[], meta: { rows_read: 0, rows_written: 0, duration: 0 } }
        },
        async first<T>() {
          calls.push(call)
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
            return null
          }
          return null
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1, rows_read: 0, rows_written: 1, duration: 1 } }
        },
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
    expect(body.data.totals.contact_count).toBe(3)
    expect(body.data.meta.sent_count).toBe(2)
    expect(body.data.duplicates.duplicate_suppressed_count).toBe(1)
    expect(body.data.trend[0]).toMatchObject({ date: '2026-07-09', contact_count: 3 })
    expect(Array.isArray(body.data.risks)).toBe(true)
  })

  it('返回投放追踪链接和转化指标', async () => {
    const res = await createApp('admin').request('/api/admin/attribution/links?from=2026-07-09&to=2026-07-09', {}, { DB: createAttributionDb() } as unknown as Bindings)
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
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'attribution.meta_test_event')).toBe(true)
    expect(JSON.stringify(db.calls)).not.toContain('Meta 像素测试地址')
  })
})
