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
    utm_content: '',
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
        sourceLabel: 'Telegram 六月互推',
        channel: 'social',
        targetPath: '/',
      }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()
    const code = String(body.data.sourceCode)

    expect(res.status).toBe(201)
    expect(body.data).toMatchObject({
      name: 'Telegram 六月互推',
      sourceLabel: 'Telegram 六月互推',
      channel: 'social',
      slug: code,
      trackingPath: `/?mg_source=${code}&utm_source=${code}&utm_medium=social&utm_campaign=${code}`,
    })
    expect(code).toMatch(/^social-[a-z0-9]{3,}$/)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_tracking_sources'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO admin_audit_logs') && call.params[2] === 'tracking_source.create')).toBe(true)
  })

  it('创建广告投放链接时支持 utm_content 并写审计日志', async () => {
    const db = createDb()
    const res = await createApp('admin').request('/api/admin/tracking-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceLabel: 'Meta 广告 A',
        channel: 'ad',
        targetPath: '/',
        utmMedium: 'paid_social',
        utmCampaign: 'july',
        utmContent: 'chat-a',
      }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data.utmContent).toBe('chat-a')
    expect(body.data.trackingPath).toContain('utm_content=chat-a')
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_tracking_sources') && call.params[8] === 'chat-a')).toBe(true)
    expect(JSON.stringify(db.calls)).not.toContain('Meta 像素测试地址')
  })

  it('创建时不允许手动填写 code', async () => {
    const res = await createApp('admin').request('/api/admin/tracking-sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '重复来源',
        channel: 'social',
        sourceCode: 'telegram-june',
      }),
    }, { DB: createDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toContain('来源 code 由后台自动生成')
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

  it('可以修改自定义文案但不能修改 code', async () => {
    const db = createDb()
    const updateRes = await createApp('admin').request('/api/admin/tracking-sources/ats_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceLabel: 'Telegram 七月互推', note: '更新展示文案' }),
    }, { DB: db } as unknown as Bindings)
    const updateBody = await updateRes.json()

    expect(updateRes.status).toBe(200)
    expect(updateBody.data.sourceLabel).toBe('Telegram 七月互推')
    expect(updateBody.data.sourceCode).toBe('telegram-june')

    const codeRes = await createApp('admin').request('/api/admin/tracking-sources/ats_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceCode: 'telegram-july' }),
    }, { DB: createDb() } as unknown as Bindings)
    const codeBody = await codeRes.json()

    expect(codeRes.status).toBe(400)
    expect(codeBody.message).toContain('来源 code 创建后不能修改')
  })
})
