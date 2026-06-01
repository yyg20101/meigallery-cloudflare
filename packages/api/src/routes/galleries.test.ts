import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { galleryRoutes } from './galleries'

function createApp(userId: number | null = null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('userRole', null)
    await next()
  })
  app.route('/api/galleries', galleryRoutes)
  return app
}

function createDb(options: { coverKey?: string | null } = {}) {
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
              cover_key: options.coverKey === undefined ? null : options.coverKey,
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

  it('详情封面会归一化安全 HTTPS 外链', async () => {
    const app = createApp()
    const db = createDb({ coverKey: 'HTTPS://example.com/cover.jpg?next="x"' })
    const env = { DB: db } as unknown as Bindings
    const { ctx, pending } = createExecutionContext()

    const res = await app.fetch(new Request('https://api.test/api/galleries/sample-gallery'), env, ctx)
    await Promise.all(pending.splice(0))
    const body = await res.json<{ coverUrl: string | null }>()

    expect(res.status).toBe(200)
    expect(body.coverUrl).toBe('https://example.com/cover.jpg?next=%22x%22')
  })

  it('详情封面不会下发不安全外链', async () => {
    const app = createApp()

    for (const coverKey of [
      'http://example.com/cover.jpg',
      'https://localhost/cover.jpg',
      'https://127.0.0.1/cover.jpg',
    ]) {
      const db = createDb({ coverKey })
      const env = { DB: db } as unknown as Bindings
      const { ctx, pending } = createExecutionContext()

      const res = await app.fetch(new Request('https://api.test/api/galleries/sample-gallery'), env, ctx)
      await Promise.all(pending.splice(0))
      const body = await res.json<{ coverUrl: string | null }>()

      expect(res.status).toBe(200)
      expect(body.coverUrl).toBeNull()
    }
  })

  it('列表封面只下发安全 HTTPS 外链或内部代理', async () => {
    const app = createApp()
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this
          },
          async first<T>() {
            return { total: 4 } as T
          },
          async all<T>() {
            if (sql.includes('SELECT DISTINCT g.id')) {
              return {
                results: [
                  { ...galleryRow('safe'), cover_key: 'HTTPS://example.com/cover.jpg?next="x"' },
                  { ...galleryRow('unsafe'), cover_key: 'http://example.com/cover.jpg' },
                  { ...galleryRow('local'), cover_key: 'https://127.0.0.1/cover.jpg' },
                  { ...galleryRow('r2'), cover_key: 'covers/r2/cover.jpg' },
                ],
              } as { results: T[] }
            }

            return { results: [] as T[] }
          },
        }
      },
    }
    const env = { DB: db } as unknown as Bindings
    const { ctx } = createExecutionContext()

    const res = await app.fetch(new Request('https://api.test/api/galleries?pageSize=4'), env, ctx)
    const body = await res.json<{ data: Array<{ id: string; coverUrl: string | null }> }>()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'safe', coverUrl: 'https://example.com/cover.jpg?next=%22x%22' }),
      expect.objectContaining({ id: 'unsafe', coverUrl: null }),
      expect.objectContaining({ id: 'local', coverUrl: null }),
      expect.objectContaining({ id: 'r2', coverUrl: '/api/media/cover/r2' }),
    ])
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

  it('新增点赞只在现有 like_count 上递增，保留初始人气基线', async () => {
    const app = createApp(12)
    const { db, preparedSqls } = createLikeDb({ initialLikeCount: 80, insertChanges: 1 })
    const env = { DB: db } as unknown as Bindings
    const { ctx } = createExecutionContext()

    const res = await app.fetch(new Request('https://api.test/api/galleries/gal_1/like', { method: 'POST' }), env, ctx)
    const body = await res.json<{ likeCount: number; likedByMe: boolean }>()

    expect(res.status).toBe(200)
    expect(body).toEqual({ likeCount: 81, likedByMe: true })
    expect(preparedSqls).toContain('UPDATE galleries SET like_count = like_count + 1 WHERE id = ?')
    expect(preparedSqls.some(sql => sql.includes('SELECT COUNT(*) FROM gallery_likes'))).toBe(false)
  })

  it('重复点赞不会重复增加 like_count', async () => {
    const app = createApp(12)
    const { db, preparedSqls } = createLikeDb({ initialLikeCount: 80, insertChanges: 0 })
    const env = { DB: db } as unknown as Bindings
    const { ctx } = createExecutionContext()

    const res = await app.fetch(new Request('https://api.test/api/galleries/gal_1/like', { method: 'POST' }), env, ctx)
    const body = await res.json<{ likeCount: number; likedByMe: boolean }>()

    expect(res.status).toBe(200)
    expect(body).toEqual({ likeCount: 80, likedByMe: true })
    expect(preparedSqls).not.toContain('UPDATE galleries SET like_count = like_count + 1 WHERE id = ?')
  })

  it('取消点赞只在删除关系成功时递减且不会小于 0', async () => {
    const app = createApp(12)
    const { db } = createLikeDb({ initialLikeCount: 0, deleteChanges: 1 })
    const env = { DB: db } as unknown as Bindings
    const { ctx } = createExecutionContext()

    const res = await app.fetch(new Request('https://api.test/api/galleries/gal_1/like', { method: 'DELETE' }), env, ctx)
    const body = await res.json<{ likeCount: number; likedByMe: boolean }>()

    expect(res.status).toBe(200)
    expect(body).toEqual({ likeCount: 0, likedByMe: false })
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

function createLikeDb(options: {
  initialLikeCount: number
  insertChanges?: number
  deleteChanges?: number
}) {
  let likeCount = options.initialLikeCount
  const preparedSqls: string[] = []

  const db = {
    prepare(sql: string) {
      preparedSqls.push(sql)
      const statement = {
        bind() {
          return this
        },
        async first<T>() {
          if (sql.includes('SELECT id, like_count FROM galleries')) {
            return { id: 'gal_1', like_count: likeCount } as T
          }

          if (sql.includes('SELECT like_count FROM galleries WHERE id = ?')) {
            return { like_count: likeCount } as T
          }

          return null as T
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO gallery_likes')) {
            return { success: true, meta: { changes: options.insertChanges ?? 0 } }
          }

          if (sql === 'UPDATE galleries SET like_count = like_count + 1 WHERE id = ?') {
            likeCount += 1
            return { success: true, meta: { changes: 1 } }
          }

          if (sql.includes('DELETE FROM gallery_likes')) {
            return { success: true, meta: { changes: options.deleteChanges ?? 0 } }
          }

          if (sql === 'UPDATE galleries SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?') {
            likeCount = Math.max(0, likeCount - 1)
            return { success: true, meta: { changes: 1 } }
          }

          return { success: true, meta: { changes: 0 } }
        },
      }
      return statement
    },
  }

  return { db, preparedSqls }
}
