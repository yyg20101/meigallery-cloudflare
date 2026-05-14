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
})
