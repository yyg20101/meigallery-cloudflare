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
