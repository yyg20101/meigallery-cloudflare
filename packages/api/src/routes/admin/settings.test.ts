import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminSettingsRoutes } from './settings'

function createApp(role: string | null = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/settings', adminSettingsRoutes)
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

describe('后台站点设置 API', () => {
  it('站长更新首页广告链接时会写入归一化值和审计日志', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_enabled', value: JSON.stringify(false) },
              { key: 'home_ad_url', value: JSON.stringify('') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_ad_enabled: 'true',
        home_ad_url: ' /discover?sort=hot ',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_ad_enabled', 'home_ad_url'])
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === 'true' && item.params[1] === 'home_ad_enabled')).toBe(true)
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"/discover?sort=hot"' && item.params[1] === 'home_ad_url')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝不安全的首页广告链接', async () => {
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

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ home_ad_url: 'javascript:alert(1)' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toContain('首页广告链接')
    expect(executed).toHaveLength(0)
  })

  it('站长更新首页广告文案时会归一化空白并限制长度', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_title', value: JSON.stringify('旧标题') },
              { key: 'home_ad_summary', value: JSON.stringify('旧摘要') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_ad_title: '  会员季   精选内容  ',
        home_ad_summary: '精选图库与真实案例',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_ad_title', 'home_ad_summary'])
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"会员季 精选内容"' && item.params[1] === 'home_ad_title')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝过长或包含控制字符的首页广告文案', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings

    for (const payload of [
      { home_ad_title: 'x'.repeat(41) },
      { home_ad_summary: 'x'.repeat(121) },
      { home_ad_cta_label: '查看\u0001推荐' },
    ]) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/首页广告/)
    }
  })

  it('站长更新首页广告排期时会写入 ISO 时间并记录审计日志', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_starts_at', value: JSON.stringify('') },
              { key: 'home_ad_ends_at', value: JSON.stringify('') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        home_ad_starts_at: '2026-06-01T08:00:00+08:00',
        home_ad_ends_at: '2026-06-02T08:00:00+08:00',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['home_ad_starts_at', 'home_ad_ends_at'])
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"2026-06-01T00:00:00.000Z"' && item.params[1] === 'home_ad_starts_at')).toBe(true)
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"2026-06-02T00:00:00.000Z"' && item.params[1] === 'home_ad_ends_at')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝无效或倒置的首页广告排期', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings
    const cases = [
      { home_ad_starts_at: 'not-a-date' },
      {
        home_ad_starts_at: '2026-06-02T08:00:00+08:00',
        home_ad_ends_at: '2026-06-01T08:00:00+08:00',
      },
    ]

    for (const payload of cases) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/首页广告/)
    }
  })

  it('只更新单个广告排期字段时会结合已有值校验顺序', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'home_ad_starts_at', value: JSON.stringify('2026-06-02T00:00:00.000Z') },
              { key: 'home_ad_ends_at', value: JSON.stringify('') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ home_ad_ends_at: '2026-06-01T00:00:00.000Z' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toContain('首页广告结束时间必须晚于开始时间')
    expect(executed).toHaveLength(0)
  })

  it('归一化公开图片设置和规则页路径', async () => {
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('SELECT key, value FROM site_settings')) {
            return [
              { key: 'site_icon', value: JSON.stringify('') },
              { key: 'og_image', value: JSON.stringify('') },
              { key: 'rules_page_url', value: JSON.stringify('/rules') },
            ]
          }
          return []
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_icon: ' /api/media/public/site/icon.png ',
        og_image: ' https://example.com/og.jpg ',
        rules_page_url: ' /rules?from=entry ',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['site_icon', 'og_image', 'rules_page_url'])
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"/api/media/public/site/icon.png"' && item.params[1] === 'site_icon')).toBe(true)
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"https://example.com/og.jpg"' && item.params[1] === 'og_image')).toBe(true)
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[0] === '"/rules?from=entry"' && item.params[1] === 'rules_page_url')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('拒绝危险的公开图片设置和规则页路径', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings
    const cases = [
      { site_icon: 'javascript:alert(1)' },
      { og_image: 'http://example.com/og.jpg' },
      { site_icon: 'https://localhost/icon.png' },
      { og_image: 'https://192.168.1.10/og.jpg' },
      { rules_page_url: 'https://example.com/rules' },
    ]

    for (const payload of cases) {
      const res = await app.request('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/URL|链接/)
    }
  })

  it('站长可以上传站点图标并同步写入 site_icon 设置', async () => {
    const putKeys: string[] = []
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const app = createApp()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes("WHERE key = 'site_icon'")) return { value: JSON.stringify('') }
          return null
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
      R2: {
        put: async (key: string) => {
          putKeys.push(key)
        },
      },
    } as unknown as Bindings
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'brand.png', { type: 'image/png' }))

    const res = await app.request('/api/admin/settings/site-icon', { method: 'POST', body: form }, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.iconUrl).toMatch(/^\/api\/media\/public\/site\/site-icon-/)
    expect(putKeys[0]).toMatch(/^site\/site-icon-/)
    expect(executed.some(item => item.sql.includes('UPDATE site_settings') && item.params[1] === 'site_icon')).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })
})
