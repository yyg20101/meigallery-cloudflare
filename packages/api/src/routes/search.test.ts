import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { searchRoutes } from './search'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/search', searchRoutes)
  return app
}

function galleryRow(id: string) {
  return {
    id,
    title: `图库 ${id}`,
    slug: id,
    summary: null,
    cover_key: null,
    required_level_rank: 0,
    published_at: '2026-05-01T00:00:00.000Z',
  }
}

describe('搜索 API', () => {
  it('sort=random 显式降级为最新排序且不生成随机排序 SQL', async () => {
    const app = createApp()
    const preparedSqls: string[] = []
    const db = {
      prepare(sql: string) {
        preparedSqls.push(sql)
        return {
          bind() {
            return this
          },
          async first<T>() {
            return { total: 0 } as T
          },
          async all<T>() {
            return { results: [] as T[] }
          },
        }
      },
    }

    const res = await app.request('/api/search?sort=random', {}, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
    expect(preparedSqls.join('\n')).not.toMatch(/ORDER\s+BY\s+RANDOM\s*\(/i)
    expect(preparedSqls.some(sql => sql.includes('ORDER BY g.published_at DESC'))).toBe(true)
  })

  it('复杂标签查询用额外一行判断 hasMore 且不执行精确统计', async () => {
    const app = createApp()
    const preparedSqls: string[] = []
    const binds: unknown[][] = []
    const db = {
      prepare(sql: string) {
        preparedSqls.push(sql)
        const statement = {
          bound: [] as unknown[],
          bind(...args: unknown[]) {
            this.bound = args
            binds.push(args)
            return this
          },
          async first<T>() {
            return { total: 99 } as T
          },
          async all<T>() {
            if (sql.includes('FROM galleries g')) {
              return { results: [galleryRow('gal_1'), galleryRow('gal_2'), galleryRow('gal_3')] } as { results: T[] }
            }

            return {
              results: this.bound.map(galleryId => ({
                gallery_id: galleryId,
                id: `tag_${galleryId}`,
                type: 'style',
                name: '清新',
                slug: 'fresh',
              })),
            } as { results: T[] }
          },
        }
        return statement
      },
    }

    const res = await app.request('/api/search?tag=fresh&pageSize=2&page=1', {}, { DB: db } as unknown as Bindings)
    const body = await res.json<{
      data: Array<{ id: string }>
      total: number
      page: number
      pageSize: number
      hasMore: boolean
    }>()

    expect(res.status).toBe(200)
    expect(body.data.map(g => g.id)).toEqual(['gal_1', 'gal_2'])
    expect(body.total).toBe(3)
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(2)
    expect(body.hasMore).toBe(true)
    expect(preparedSqls.some(sql => /SELECT\s+COUNT/i.test(sql))).toBe(false)
    expect(preparedSqls.some(sql => /COUNT\s*\(\s*DISTINCT/i.test(sql))).toBe(false)
    expect(binds).toContainEqual(['published', 'fresh', 3, 0])
    expect(binds).toContainEqual(['gal_1', 'gal_2'])
  })

  it('无效或非正数分页参数回退默认值且不会向 SQL 绑定 NaN', async () => {
    const app = createApp()
    const binds: unknown[][] = []
    const db = {
      prepare() {
        const statement = {
          bound: [] as unknown[],
          bind(...args: unknown[]) {
            this.bound = args
            binds.push(args)
            return this
          },
          async first<T>() {
            return { total: 0 } as T
          },
          async all<T>() {
            return { results: [] as T[] }
          },
        }
        return statement
      },
    }

    const res = await app.request('/api/search?page=0&pageSize=0', {}, { DB: db } as unknown as Bindings)
    const body = await res.json<{ page: number; pageSize: number }>()

    expect(res.status).toBe(200)
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(20)
    expect(binds.flat().some(value => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })
})
