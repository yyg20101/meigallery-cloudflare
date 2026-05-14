import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { galleryRoutes } from './galleries'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', null)
    c.set('userRole', null)
    await next()
  })
  app.route('/api/galleries', galleryRoutes)
  return app
}

function createDb() {
  let viewUpdates = 0
  return {
    get viewUpdates() {
      return viewUpdates
    },
    prepare(sql: string) {
      return {
        bind() {
          return this
        },
        async first<T>() {
          if (sql.includes('FROM galleries') && sql.includes('WHERE slug = ?')) {
            return {
              id: 'gal_1',
              title: '测试图库',
              slug: 'sample-gallery',
              summary: '摘要',
              body_md: '正文',
              cover_key: null,
              status: 'published',
              required_level_rank: 0,
              published_at: '2026-05-01T00:00:00.000Z',
              view_count: 10,
              like_count: 0,
              created_at: '2026-05-01T00:00:00.000Z',
              updated_at: '2026-05-01T00:00:00.000Z',
            } as T
          }
          return null as T
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          if (sql.includes('UPDATE galleries SET view_count = view_count + 1')) viewUpdates++
          return { success: true }
        },
      }
    },
  }
}

function createExecutionContext() {
  const pending: Promise<unknown>[] = []
  return {
    pending,
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
      passThroughOnException() {},
      props: {},
    } satisfies ExecutionContext,
  }
}

describe('公开图库 API', () => {
  it('同一访客短时间重复访问详情只写入一次浏览量', async () => {
    const app = createApp()
    const db = createDb()
    const env = { DB: db } as unknown as Bindings
    const { ctx, pending } = createExecutionContext()

    const first = await app.fetch(new Request('https://api.test/api/galleries/sample-gallery'), env, ctx)
    await Promise.all(pending.splice(0))
    const viewCookie = first.headers.get('set-cookie')?.split(';')[0]

    expect(first.status).toBe(200)
    expect(viewCookie).toContain('mei_gallery_view_gal_1=1')

    const second = await app.fetch(new Request('https://api.test/api/galleries/sample-gallery', {
      headers: { Cookie: viewCookie || '' },
    }), env, ctx)
    await Promise.all(pending.splice(0))

    expect(second.status).toBe(200)
    expect(db.viewUpdates).toBe(1)
  })

  it('复杂标签筛选使用额外一行判断 hasMore 且不执行精确去重计数', async () => {
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
            if (sql.includes('SELECT DISTINCT g.id')) {
              return {
                results: [
                  galleryRow('gal_1'),
                  galleryRow('gal_2'),
                  galleryRow('gal_3'),
                ],
              } as { results: T[] }
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
    const env = { DB: db } as unknown as Bindings
    const { ctx } = createExecutionContext()

    const res = await app.fetch(
      new Request('https://api.test/api/galleries?tag=fresh&pageSize=2&page=1'),
      env,
      ctx,
    )
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
    expect(body.hasMore).toBe(true)
    expect(preparedSqls.some(sql => sql.includes('COUNT(DISTINCT'))).toBe(false)
    expect(binds).toContainEqual(['published', 'fresh', 3, 0])
    expect(binds).toContainEqual(['gal_1', 'gal_2'])
  })

  it('非法分页参数回退默认值且不向 SQL 绑定 NaN', async () => {
    const app = createApp()
    const binds: unknown[][] = []
    const db = {
      prepare(sql: string) {
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
            if (sql.includes('SELECT DISTINCT g.id')) return { results: [] as T[] }
            return { results: [] as T[] }
          },
        }
        return statement
      },
    }
    const env = { DB: db } as unknown as Bindings
    const { ctx } = createExecutionContext()

    const res = await app.fetch(new Request('https://api.test/api/galleries?page=abc&pageSize=bad'), env, ctx)
    const body = await res.json<{ page: number; pageSize: number }>()

    expect(res.status).toBe(200)
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(20)
    expect(binds.flat().some(value => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })
})

function galleryRow(id: string) {
  return {
    id,
    title: `图库 ${id}`,
    slug: id,
    summary: null,
    cover_key: null,
    required_level_rank: 0,
    published_at: '2026-05-01T00:00:00.000Z',
    view_count: 0,
    like_count: 0,
    hot_score: 0,
  }
}
