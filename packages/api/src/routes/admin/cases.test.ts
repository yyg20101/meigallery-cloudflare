import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminCaseRoutes } from './cases'

function createApp(role: string | null = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/cases', adminCaseRoutes)
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

describe('后台真实案例 API', () => {
  it('拒绝非管理员访问', async () => {
    const app = createApp(null)
    const env = { DB: createDb({}) } as unknown as Bindings

    const res = await app.request('/api/admin/cases', {}, env)

    expect(res.status).toBe(403)
  })

  it('无效分页参数回退默认值且不会向 SQL 绑定 NaN', async () => {
    const app = createApp()
    const binds: unknown[][] = []
    const env = {
      DB: createDb({
        first: (_sql, params) => {
          binds.push(params)
          return { total: 0 }
        },
        all: (_sql, params) => {
          binds.push(params)
          return []
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/cases?page=abc&pageSize=abc', {}, env)
    const body = await res.json<{ page: number; pageSize: number }>()

    expect(res.status).toBe(200)
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(20)
    expect(binds.flat().some(value => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })

  it('创建真实案例草稿并写入审计日志', async () => {
    const app = createApp()
    const executedSql: string[] = []
    const env = {
      DB: createDb({
        run: (sql) => {
          executedSql.push(sql)
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '授权反馈案例', slug: 'member-feedback-001', status: 'draft' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toMatch(/^tc_/)
    expect(executedSql.some(sql => sql.includes('INSERT INTO cases'))).toBe(true)
    expect(executedSql.some(sql => sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('创建真实案例时支持同时上传图片', async () => {
    const app = createApp()
    const executedSql: string[] = []
    const putKeys: string[] = []
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT MAX(sort_order) as max_order')) return { max_order: null }
          return null
        },
        run: (sql) => {
          executedSql.push(sql)
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
    form.set('title', '授权反馈案例')
    form.set('slug', 'member-feedback-001')
    form.set('featured', 'true')
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'feedback.jpg', { type: 'image/jpeg' }))

    const res = await app.request('/api/admin/cases', { method: 'POST', body: form }, env)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.uploaded).toHaveLength(1)
    expect(putKeys[0]).toContain(`cases/${body.id}/`)
    expect(executedSql.some(sql => sql.includes('INSERT INTO cases'))).toBe(true)
    expect(executedSql.some(sql => sql.includes('INSERT INTO case_images'))).toBe(true)
  })

  it('返回后台案例详情和公开图片 URL', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: sql => sql.includes('SELECT * FROM cases')
          ? {
              id: 'tc_1',
              title: '授权反馈案例',
              slug: 'member-feedback-001',
              summary: '已脱敏摘要',
              body_md: '正文',
              status: 'draft',
              featured: 1,
              sort_order: 0,
              seo_title: null,
              seo_description: null,
              published_at: null,
              updated_at: '2026-05-06T00:00:00.000Z',
            }
          : null,
        all: () => [{ id: 'tci_1', alt_text: '图片 1', sort_order: 0 }],
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/cases/tc_1', {}, env)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.id).toBe('tc_1')
    expect(body.featured).toBe(true)
    expect(body.images).toEqual([{ id: 'tci_1', url: '/api/cases/images/tci_1', alt: '图片 1', sortOrder: 0 }])
  })

  it('禁止新建案例时直接发布', async () => {
    const app = createApp()
    const env = { DB: createDb({}) } as unknown as Bindings

    const res = await app.request('/api/admin/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '授权反馈案例', slug: 'member-feedback-001', status: 'published' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toBe('新建案例需先保存草稿并上传 2-9 张图片后再发布')
  })

  it('发布时校验图片数量必须为 2-9 张', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT * FROM cases')) return { id: 'tc_1', published_at: null }
          if (sql.includes('COUNT(*) as count FROM case_images')) return { count: 1 }
          return null
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/cases/tc_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '授权反馈案例', slug: 'member-feedback-001', status: 'published' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toBe('真实案例发布需要 2-9 张图片')
  })

  it('删除单张图片前校验 R2 key 必须匹配当前案例和图片', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => ({ r2_key: 'cases/tc_2/tci_1.jpg' }),
      }),
      R2: {
        async delete() {
          throw new Error('不应删除不匹配的 R2 key')
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/admin/cases/tc_1/images/tci_1', { method: 'DELETE' }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('图片 R2 key 与当前案例不匹配，请先人工核查')
  })
})
