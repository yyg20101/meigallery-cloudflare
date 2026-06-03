import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminMediaRoutes } from './media'

function createApp(role: string | null = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin', adminMediaRoutes)
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

describe('后台媒体管理 API', () => {
  it('媒体列表缩略图只下发安全 HTTPS 外链或内部代理', async () => {
    const app = createApp()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT id FROM galleries')) return { id: 'gal_1' }
          return null
        },
        all: (sql) => {
          if (sql.includes('FROM media_assets')) {
            return [
              mediaRow('safe', 'HTTPS://example.com/source.jpg?next="x"'),
              mediaRow('unsafe', 'http://example.com/source.jpg'),
              mediaRow('local', 'https://127.0.0.1/source.jpg'),
              mediaRow('r2', 'originals/gal_1/r2.jpg'),
              { ...mediaRow('video', 'https://example.com/video.mp4'), type: 'video' },
            ]
          }
          return []
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries/gal_1/media', {}, env)
    const body = await res.json<{ data: Array<{ id: string; thumbnailUrl: string | null }> }>()

    expect(res.status).toBe(200)
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'safe', thumbnailUrl: 'https://example.com/source.jpg?next=%22x%22' }),
      expect.objectContaining({ id: 'unsafe', thumbnailUrl: null }),
      expect.objectContaining({ id: 'local', thumbnailUrl: null }),
      expect.objectContaining({ id: 'r2', thumbnailUrl: '/api/admin/media/r2/thumbnail' }),
      expect.objectContaining({ id: 'video', thumbnailUrl: null }),
    ])
  })

  it('管理员封面预览接口可显示草稿图库封面', async () => {
    const app = createApp()
    const bodyBytes = new TextEncoder().encode('cover-bytes')
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT cover_key FROM galleries')) return { cover_key: 'covers/gal_1/cover.jpg' }
          return null
        },
      }),
      R2: {
        async get(key: string) {
          if (key !== 'covers/gal_1/cover.jpg') return null
          return {
            body: bodyBytes,
            httpMetadata: { contentType: 'image/jpeg' },
            httpEtag: 'etag-cover',
          } as unknown as R2ObjectBody
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries/gal_1/cover', {}, env)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toBe('cover-bytes')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=600')
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('管理员缩略图接口可显示草稿图库图片', async () => {
    const app = createApp()
    const bodyBytes = new TextEncoder().encode('image-bytes')
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('FROM media_assets')) {
            return { gallery_id: 'gal_1', r2_key: 'originals/gal_1/asset-1.jpg', type: 'image', upload_status: 'completed' }
          }
          return null
        },
      }),
      R2: {
        async get(key: string) {
          if (key !== 'originals/gal_1/asset-1.jpg') return null
          return {
            body: bodyBytes,
            httpMetadata: { contentType: 'image/jpeg' },
            httpEtag: 'etag-1',
          } as unknown as R2ObjectBody
        },
      },
    } as unknown as Bindings

    const res = await app.request('/api/admin/media/asset-1/thumbnail', {}, env)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toBe('image-bytes')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=600')
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('设置封面时拒绝不安全外部媒体地址', async () => {
    const app = createApp()
    const executed: string[] = []
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT id, cover_key FROM galleries')) return { id: 'gal_1', cover_key: null }
          if (sql.includes('SELECT id, gallery_id, r2_key FROM media_assets')) return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'http://example.com/source.jpg' }
          return null
        },
        run: (sql) => {
          executed.push(sql)
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries/gal_1/cover', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: 'asset_1' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toBe('媒体资源地址不安全，不能设为封面')
    expect(executed).toHaveLength(0)
  })

  it('设置封面时拒绝不属于当前图库和媒体的 R2 key', async () => {
    const app = createApp()
    const executed: string[] = []
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT id, cover_key FROM galleries')) return { id: 'gal_1', cover_key: null }
          if (sql.includes('SELECT id, gallery_id, r2_key FROM media_assets')) return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'originals/gal_2/asset_1.jpg' }
          return null
        },
        run: (sql) => {
          executed.push(sql)
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries/gal_1/cover', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: 'asset_1' }),
    }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('媒体 R2 key 与当前图库/媒体不匹配，请先人工核查')
    expect(executed).toHaveLength(0)
  })

  it('设置封面时返回归一化安全外链', async () => {
    const app = createApp()
    const executed: Array<{ sql: string; params: unknown[] }> = []
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT id, cover_key FROM galleries')) return { id: 'gal_1', cover_key: null }
          if (sql.includes('SELECT id, gallery_id, r2_key FROM media_assets')) return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'HTTPS://example.com/source.jpg?next="x"' }
          return null
        },
        run: (sql, params) => {
          executed.push({ sql, params })
          return { success: true }
        },
      }),
    } as unknown as Bindings

    const res = await app.request('/api/admin/galleries/gal_1/cover', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: 'asset_1' }),
    }, env)
    const body = await res.json<{ coverKey: string; coverUrl: string | null }>()

    expect(res.status).toBe(200)
    expect(body.coverKey).toBe('HTTPS://example.com/source.jpg?next="x"')
    expect(body.coverUrl).toBe('https://example.com/source.jpg?next=%22x%22')
    expect(executed.some(item => item.sql.includes('UPDATE galleries SET cover_key'))).toBe(true)
    expect(executed.some(item => item.sql.includes('INSERT INTO admin_audit_logs'))).toBe(true)
  })

  it('删除媒体时不会把大写 HTTPS 外链当作 R2 key 删除', async () => {
    const app = createApp()
    const r2Delete = vi.fn()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT id, gallery_id, r2_key')) {
            return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'HTTPS://example.com/source.jpg', stream_uid: null, type: 'image' }
          }
          if (sql.includes('SELECT cover_key FROM galleries')) return { cover_key: 'HTTPS://example.com/source.jpg' }
          return null
        },
      }),
      R2: { delete: r2Delete },
    } as unknown as Bindings

    const res = await app.request('/api/admin/media/asset_1', { method: 'DELETE' }, env)

    expect(res.status).toBe(200)
    expect(r2Delete).not.toHaveBeenCalled()
  })

  it('删除媒体时拒绝删除不属于当前图库和媒体的 R2 key', async () => {
    const app = createApp()
    const r2Delete = vi.fn()
    const env = {
      DB: createDb({
        first: (sql) => {
          if (sql.includes('SELECT id, gallery_id, r2_key')) {
            return { id: 'asset_1', gallery_id: 'gal_1', r2_key: 'originals/gal_2/asset_1.jpg', stream_uid: null, type: 'image' }
          }
          return null
        },
      }),
      R2: { delete: r2Delete },
    } as unknown as Bindings

    const res = await app.request('/api/admin/media/asset_1', { method: 'DELETE' }, env)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.message).toBe('媒体 R2 key 与当前图库/媒体不匹配，请先人工核查')
    expect(r2Delete).not.toHaveBeenCalled()
  })
})

function mediaRow(id: string, r2Key: string | null) {
  return {
    id,
    gallery_id: 'gal_1',
    type: 'image',
    storage: 'r2',
    r2_key: r2Key,
    stream_uid: null,
    required_rank: 0,
    role: 'content',
    sort_order: 0,
    upload_status: 'completed',
    created_at: '2026-05-31T00:00:00.000Z',
  }
}
