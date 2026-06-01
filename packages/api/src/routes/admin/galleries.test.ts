import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminGalleryRoutes } from './galleries'

function createApp(role: string | null = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/galleries', adminGalleryRoutes)
  return app
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
} = {}) {
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
    async batch(statements: D1PreparedStatement[]) {
      return statements.map(() => ({ success: true }))
    },
  }
}

describe('后台图库 API', () => {
  it('列表路由返回服务层分页结构', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ total: 1 }),
        all: () => [
          {
            id: 'gal_1',
            title: '测试图库',
            slug: 'sample',
            status: 'published',
            required_level_rank: 0,
            cover_key: null,
            published_at: '2026-06-01T00:00:00Z',
            created_at: '2026-06-01T00:00:00Z',
            updated_at: '2026-06-01T00:00:00Z',
            view_count: 1,
            like_count: 0,
          },
        ],
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries?page=1&pageSize=5', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ page: 1, pageSize: 5, total: 1, totalPages: 1 })
  })

  it('创建图库时把服务层错误转换为统一错误体', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ id: 'gal_existing' }),
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '重复图库', slug: 'exists' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toEqual({ statusCode: 409, message: 'slug 已存在' })
  })
})
