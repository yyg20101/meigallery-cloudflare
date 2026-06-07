import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import type { HomeAdRow } from '../../utils/home-ads'
import { adminAdRoutes } from './ads'

type ExecutedSql = Array<{ sql: string; params: unknown[] }>

function createApp(role: string | null = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/ads', adminAdRoutes)
  return app
}

function adRow(overrides: Partial<HomeAdRow> = {}): HomeAdRow {
  return {
    id: 'ad-1',
    placement: 'home_after_hero',
    eyebrow: '本周推荐',
    title: '会员季精选内容',
    summary: '探索本周精选图库',
    cta_label: '查看推荐',
    target_url: '/discover?sort=hot',
    sponsor: '运营精选',
    image_url: '',
    image_key: null,
    enabled: 1,
    starts_at: '',
    ends_at: '',
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function createDb(handlers: {
  first?: (sql: string, params: unknown[]) => unknown
  all?: (sql: string, params: unknown[]) => unknown[]
  run?: (sql: string, params: unknown[]) => unknown
  batch?: (statements: Array<{ sql: string; params: unknown[] }>) => unknown
}) {
  return {
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        sql,
        params,
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
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      return handlers.batch?.(statements) ?? statements.map(() => ({ success: true }))
    },
  }
}

describe('后台广告位 API', () => {
  it('创建广告位时归一化字段、追加排序并写审计日志', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT MAX(sort_order)')) return { max_order: 2 }
          return null
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/ads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eyebrow: '  本周   推荐  ',
        title: '  会员季   精选内容  ',
        summary: '精选图库与真实案例',
        ctaLabel: '查看推荐',
        targetUrl: ' /discover?sort=hot ',
        sponsor: '运营精选',
        imageUrl: ' /api/media/public/home-ads/ad-1/cover.webp ',
        enabled: 'true',
      }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toMatch(/^ad_/)
    expect(executed.some(item =>
      item.sql.includes('INSERT INTO home_ads')
      && item.params[2] === '本周 推荐'
      && item.params[3] === '会员季 精选内容'
      && item.params[6] === '/discover?sort=hot'
      && item.params[8] === '/api/media/public/home-ads/ad-1/cover.webp'
      && item.params[12] === 3,
    )).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs') && item.params[2] === 'home_ad_create')).toBe(true)
  })

  it('拒绝危险链接和非广告公开媒体图片 URL', async () => {
    const executed: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    for (const payload of [
      { title: '危险链接', targetUrl: 'javascript:alert(1)' },
      { title: '错误图片', targetUrl: '/discover?sort=hot', imageUrl: '/api/media/public/site/icon.png' },
      { title: '错误位置', targetUrl: '/discover?sort=hot', placement: 'sidebar' },
    ]) {
      const res = await app.request('/api/admin/ads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, env)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.message).toMatch(/广告|首页/)
    }
    expect(executed).toHaveLength(0)
  })

  it('更新排序时批量写入新顺序并记录审计日志', async () => {
    const executed: ExecutedSql = []
    const batched: ExecutedSql = []
    const app = createApp()
    const env = {
      DB: createDb({
        all: (sql) => {
          if (sql.includes('FROM home_ads')) return [{ id: 'ad-2' }, { id: 'ad-1' }]
          return []
        },
        batch: (statements) => {
          batched.push(...statements.map(statement => ({ sql: statement.sql, params: statement.params })))
          return statements.map(() => ({ success: true }))
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/ads/reorder', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['ad-2', 'ad-1'] }),
    }, env)

    expect(res.status).toBe(200)
    expect(batched).toEqual([
      expect.objectContaining({ params: [0, 'ad-2'] }),
      expect.objectContaining({ params: [1, 'ad-1'] }),
    ])
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs') && item.params[2] === 'home_ad_reorder')).toBe(true)
  })

  it('删除广告位前校验大图 R2 key 必须属于当前广告', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => adRow({ image_key: 'home-ads/ad-2/cover.webp' }),
      }),
      R2: {
        async delete() {
          throw new Error('不应删除不匹配的大图 key')
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/admin/ads/ad-1', { method: 'DELETE' }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('广告大图 R2 key 与当前广告位不匹配，请先人工核查')
  })

  it('删除大图前校验 R2 key 必须属于当前广告', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: () => adRow({ image_key: 'home-ads/ad-2/cover.webp' }),
      }),
      R2: {
        async delete() {
          throw new Error('不应删除不匹配的大图 key')
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/admin/ads/ad-1/image', { method: 'DELETE' }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('广告大图 R2 key 与当前广告位不匹配，请先人工核查')
  })
})
