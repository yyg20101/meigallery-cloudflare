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

function createDb(options: { duplicate?: boolean } = {}) {
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
          if (sql.includes('FROM analytics_tracking_sources')) {
            return {
              results: [trackingSourceRow()] as T[],
              meta: { rows_read: 1, rows_written: 0, duration: 1 },
            }
          }
          return { results: [] as T[], meta: { rows_read: 0, rows_written: 0, duration: 0 } }
        },
        async first<T>() {
          calls.push(call)
          if (sql.includes('FROM analytics_tracking_sources') && sql.includes('WHERE id = ?')) {
            return trackingSourceRow() as T
          }
          if (sql.includes('FROM analytics_tracking_sources') && options.duplicate) {
            return { id: 'ats_existing', slug: call.params[0], utm_source: call.params[1] } as T
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

function trackingSourceRow() {
  return {
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
    created_at: '2026-06-08T00:00:00.000Z',
    updated_at: '2026-06-08T00:00:00.000Z',
  }
}

describe('后台推广来源 API', () => {
  it('父级后台路由要求 admin+ 才能访问推广来源', async () => {
    const res = await createApp(null).request('/api/admin/tracking-sources', {}, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('ADMIN_REQUIRED')
  })

  it('可以创建推广来源并写审计日志', async () => {
    const db = createDb()
    const res = await createApp('admin').request('/api/admin/tracking-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Telegram 六月互推',
        channel: 'social',
        slug: 'telegram-june',
        targetPath: '/',
      }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data).toMatchObject({
      name: 'Telegram 六月互推',
      channel: 'social',
      slug: 'telegram-june',
      trackingPath: '/?mg_source=telegram-june&utm_source=telegram-june&utm_medium=social&utm_campaign=telegram-june',
    })
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_tracking_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'tracking_source.create')).toBe(true)
  })

  it('重复短标识返回 409', async () => {
    const res = await createApp('admin').request('/api/admin/tracking-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '重复来源',
        channel: 'social',
        slug: 'telegram-june',
      }),
    }, { DB: createDb({ duplicate: true }) } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('来源短标识已存在')
  })

  it('可以停用推广来源并写审计日志', async () => {
    const db = createDb()
    const res = await createApp('admin').request('/api/admin/tracking-sources/ats_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disable: true }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('disabled')
    expect(db.calls.some(call => call.sql.includes('UPDATE analytics_tracking_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'tracking_source.disable')).toBe(true)
  })
})
