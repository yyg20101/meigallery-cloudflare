import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminContactMethodRoutes } from './contact-methods'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('userRole', 'owner')
    await next()
  })
  app.route('/api/admin/contact-methods', adminContactMethodRoutes)
  return app
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
}) {
  return {
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          return (handlers.first?.(sql, params) ?? null) as T | null
        },
        async all<T>() {
          return { results: (handlers.all?.(sql, params) ?? []) as T[] }
        },
        async run() {
          return handlers.run?.(sql, params) ?? { success: true }
        },
      }
    },
  }
}

describe('后台联系方式 API', () => {
  it('创建联系方式时归一化安全跳转链接并写审计日志', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ max_order: 2 }),
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/contact-methods', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        linkUrl: ' https://t.me/meigallery ',
      }),
    }, env)

    expect(res.status).toBe(201)
    expect(executed.some(item => item.sql.includes('INSERT INTO contact_methods') && item.params[4] === 'https://t.me/meigallery')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('创建联系方式时拒绝危险跳转链接', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/contact-methods', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        linkUrl: 'javascript:alert(1)',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toContain('联系方式跳转链接')
    expect(executed).toHaveLength(0)
  })

  it('创建联系方式时拒绝内部地址跳转链接', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/contact-methods', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        label: 'Telegram',
        value: '@meigallery',
        linkUrl: 'https://localhost/contact',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toContain('联系方式跳转链接')
    expect(executed).toHaveLength(0)
  })

  it('删除二维码前校验 R2 key 必须匹配当前联系方式', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ id: 'contact-1', qr_code_key: 'qrcodes/contact-2.png' }),
      }),
      R2: {
        async delete() {
          throw new Error('不应删除不匹配的二维码 key')
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/admin/contact-methods/contact-1/qrcode', { method: 'DELETE' }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('二维码 R2 key 与当前联系方式不匹配，请先人工核查')
  })

  it('更新联系方式时校验手动跳转链接', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({
          id: 'contact-1',
          platform: 'wechat',
          label: '微信',
          value: 'meigallery',
          link_url: null,
          qr_code_key: null,
          sort_order: 0,
          enabled: 1,
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
        }),
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/contact-methods/contact-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkUrl: 'mailto:hello@616618.xyz' }),
    }, env)

    expect(res.status).toBe(200)
    expect(executed.some(item => item.sql.includes('UPDATE contact_methods') && item.params[3] === 'mailto:hello@616618.xyz')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })
})
