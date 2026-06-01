import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminLegacyImportRoutes } from './legacy-import'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('userRole', 'owner')
    await next()
  })
  app.route('/api/admin/legacy-import', adminLegacyImportRoutes)
  return app
}

function createDb(assets: Array<{ id: string; gallery_id: string; type: string; r2_key: string }>) {
  const executed: Array<{ sql: string; params: unknown[] }> = []
  return {
    executed,
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          if (sql.includes('COUNT(*) as cnt')) return { cnt: assets.length } as T
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM media_assets') && sql.includes("upload_status = 'pending'")) {
            return { results: assets.slice(0, Number(params[0] ?? assets.length)) as T[] }
          }
          return { results: [] as T[] }
        },
        async run() {
          executed.push({ sql, params: [...params] })
          return { success: true }
        },
      }
    },
  }
}

function createSourceDb() {
  return {
    prepare() {
      return {
        bind() {
          return this
        },
        async first<T>() {
          return null as T
        },
        async all<T>() {
          return { results: [] as T[] }
        },
        async run() {
          return { success: true }
        },
      }
    },
  }
}

function auditPayloads(db: ReturnType<typeof createDb>) {
  return db.executed
    .filter(item => item.sql.includes('INSERT INTO admin_audit_logs'))
    .map(item => ({
      action: item.params[2],
      targetType: item.params[3],
      afterValue: item.params[6] ? JSON.parse(item.params[6] as string) as Record<string, unknown> : null,
    }))
}

describe('旧站迁移批量入口审计', () => {
  it('批量下载待处理图片后写入影响范围和结果', async () => {
    const db = createDb([
      { id: 'med_1', gallery_id: 'gal_1', type: 'image', r2_key: 'https://example.com/1.jpg' },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    )

    const res = await createApp().request('/api/admin/legacy-import/download-pending?limit=1', {
      method: 'POST',
    }, {
      DB: db,
      R2: { put: vi.fn() },
    } as unknown as Bindings)
    const body = await res.json()

    fetchMock.mockRestore()

    expect(res.status).toBe(200)
    expect(body.downloaded).toBe(1)

    const audit = auditPayloads(db)[0]
    expect(audit).toMatchObject({
      action: 'legacy_media_download_pending',
      targetType: 'media_asset',
    })
    expect(audit?.afterValue).toMatchObject({
      limit: 1,
      selectedCount: 1,
      downloaded: 1,
      failed: 0,
      remaining: 0,
      done: false,
      errorCount: 0,
    })
  })

  it('没有待下载图片时也写入空跑审计', async () => {
    const db = createDb([])

    const res = await createApp().request('/api/admin/legacy-import/download-pending', {
      method: 'POST',
    }, {
      DB: db,
      R2: { put: vi.fn() },
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.done).toBe(true)

    const audit = auditPayloads(db)[0]
    expect(audit).toMatchObject({
      action: 'legacy_media_download_pending',
      targetType: 'media_asset',
    })
    expect(audit?.afterValue).toMatchObject({
      limit: 10,
      selectedCount: 0,
      downloaded: 0,
      failed: 0,
      remaining: 0,
      done: true,
    })
  })
})

describe('旧站迁移错误响应', () => {
  it('创建来源地址不安全时返回统一错误体', async () => {
    const res = await createApp().request('/api/admin/legacy-import/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '本机', baseUrl: 'http://localhost/wp-json', mode: 'rest_api' }),
    }, { DB: createSourceDb() } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({
      statusCode: 400,
      message: '仅允许 HTTPS 外部地址',
    })
    expect(body.error).toBeUndefined()
  })
})
