import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminLegacyImportRoutes } from './legacy-import'

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
  0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

function createApp(role: 'admin' | 'owner' = 'owner', userId = 1) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/legacy-import', adminLegacyImportRoutes)
  return app
}

function createDb(
  assets: Array<{ id: string; gallery_id: string; type: string; r2_key: string }>,
  job: { id: string; status: string; legacy_processing_expires_at?: string | null } | null = null,
  defaultChanges = 1,
) {
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
          if (sql.includes('FROM import_jobs') && !sql.includes('COUNT(*)')) return job as T
          if (sql.includes('COUNT(*) as cnt')) return { cnt: assets.length } as T
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM media_assets') && sql.includes("upload_status = 'pending'")) {
            return { results: assets.slice(0, Number(params.at(-1) ?? assets.length)) as T[] }
          }
          return { results: [] as T[] }
        },
        async run() {
          executed.push({ sql, params: [...params] })
          if (sql.includes('UPDATE media_assets')) {
            const assetId = sql.includes("upload_status = 'completed'")
              ? String(params[1])
              : String(params[0])
            const index = assets.findIndex(asset => asset.id === assetId)
            if (index >= 0) assets.splice(index, 1)
            return { success: true, meta: { changes: index >= 0 ? 1 : 0 } }
          }
          return { success: true, meta: { changes: defaultChanges } }
        },
      }
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map(statement => statement.run()))
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
    .map((item) => {
      const conditionalMediaAudit = item.sql.includes("'media_asset'")
      const afterValue = conditionalMediaAudit ? item.params[4] : item.params[6]
      return {
        action: item.params[2],
        targetType: conditionalMediaAudit ? 'media_asset' : item.params[3],
        afterValue: afterValue ? JSON.parse(afterValue as string) as Record<string, unknown> : null,
      }
    })
}

describe('旧站迁移批量入口审计', () => {
  it('批量下载待处理图片后写入影响范围和结果', async () => {
    const db = createDb([
      { id: 'med_1', gallery_id: 'gal_1', type: 'image', r2_key: 'https://example.com/1.jpg' },
    ])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
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

    const audit = auditPayloads(db).find(item => item.action === 'legacy_media_download_pending')
    expect(audit).toMatchObject({
      action: 'legacy_media_download_pending',
      targetType: 'media_asset',
    })
    expect(audit?.afterValue).toMatchObject({
      limit: 1,
      scope: 'all_legacy',
      galleries: 1,
      selectedCount: 1,
      downloaded: 1,
      failed: 0,
      skipped: 0,
      remaining: 0,
      done: true,
      errorCount: 0,
    })
    expect(auditPayloads(db)).toContainEqual(expect.objectContaining({
      action: 'legacy_media_download_completed',
      targetType: 'media_asset',
      afterValue: { status: 'completed' },
    }))
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

    const audit = auditPayloads(db).find(item => item.action === 'legacy_media_download_pending')
    expect(audit).toMatchObject({
      action: 'legacy_media_download_pending',
      targetType: 'media_asset',
    })
    expect(audit?.afterValue).toMatchObject({
      limit: 10,
      scope: 'all_legacy',
      galleries: 0,
      selectedCount: 0,
      downloaded: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      done: true,
    })
  })

  it('任务媒体下载只选择指定 legacy 任务并写任务级审计', async () => {
    const db = createDb([
      { id: 'med_job_1', gallery_id: 'gal_job_1', type: 'image', r2_key: 'https://example.com/job-1.jpg' },
    ], { id: 'job_legacy_1', status: 'completed' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(VALID_PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    )

    const res = await createApp().request(
      '/api/admin/legacy-import/jobs/job_legacy_1/download-media?limit=1',
      { method: 'POST' },
      { DB: db, R2: { put: vi.fn() } } as unknown as Bindings,
    )
    const body = await res.json()
    fetchMock.mockRestore()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      galleries: 1,
      selectedCount: 1,
      downloaded: 1,
      failed: 0,
      remaining: 0,
      done: true,
    })
    expect(db.executed.some(item => (
      item.sql.includes('UPDATE media_assets')
      && item.params.includes('med_job_1')
    ))).toBe(true)
    const audit = auditPayloads(db).find(item => item.action === 'legacy_job_media_download')
    expect(audit).toMatchObject({
      action: 'legacy_job_media_download',
      targetType: 'import_job',
    })
    expect(audit?.afterValue).toMatchObject({ selectedCount: 1, downloaded: 1, errorCount: 0 })
  })
})

describe('旧站迁移任务列表', () => {
  it('使用专用 legacy 范围、稳定排序和服务端分页', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const params: unknown[] = []
        return {
          bind(...values: unknown[]) {
            params.push(...values)
            return this
          },
          async first<T>() {
            queries.push({ sql, params: [...params] })
            return { total: 1 } as T
          },
          async all<T>() {
            queries.push({ sql, params: [...params] })
            return {
              results: [{
                id: 'job_legacy_1',
                status: 'completed',
                source_key: 'lsrc_one',
                source_name: '旧站主站',
                total_count: 2,
                success_count: 2,
                failure_count: 0,
                created_by: 1,
                created_at: '2026-08-20T08:00:00.000Z',
                completed_at: '2026-08-20T08:05:00.000Z',
              }] as T[],
            }
          },
        }
      },
    }

    const res = await createApp().request(
      '/api/admin/legacy-import/jobs?status=completed&pageSize=50',
      undefined,
      { DB: db } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 50 })
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'job_legacy_1', source_name: '旧站主站' }),
    ])
    expect(queries).toHaveLength(2)
    expect(queries.every(query => query.sql.includes("job.type = 'legacy'"))).toBe(true)
    expect(queries[1]?.sql).toContain('ORDER BY job.created_at DESC, job.id DESC')
    expect(queries[1]?.params).toEqual(['completed', 50, 0])
  })

  it('普通管理员只能读取自己创建的 legacy 任务', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const params: unknown[] = []
        return {
          bind(...values: unknown[]) {
            params.push(...values)
            return this
          },
          async first<T>() {
            queries.push({ sql, params: [...params] })
            return { total: 0 } as T
          },
          async all<T>() {
            queries.push({ sql, params: [...params] })
            return { results: [] as T[] }
          },
        }
      },
    }

    const res = await createApp('admin', 9).request(
      '/api/admin/legacy-import/jobs?status=completed&pageSize=20',
      undefined,
      { DB: db } as unknown as Bindings,
    )

    expect(res.status).toBe(200)
    expect(queries.every(query => query.sql.includes('job.created_by = ?'))).toBe(true)
    expect(queries[0]?.params).toEqual([9, 'completed'])
    expect(queries[1]?.params).toEqual([9, 'completed', 20, 0])
  })
})

describe('旧站迁移中断恢复', () => {
  it('只把已过期 processing 租约原子收敛为失败并写最小审计', async () => {
    const db = createDb([], { id: 'job_stale', status: 'processing' })

    const res = await createApp().request(
      '/api/admin/legacy-import/jobs/job_stale/recover-stale',
      { method: 'POST' },
      { DB: db } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      id: 'job_stale',
      status: 'failed',
      errorCode: 'LEGACY_IMPORT_PROCESSING_LEASE_EXPIRED',
      retryMode: 'create_new_job',
    })
    const update = db.executed.find(item => item.sql.includes('UPDATE import_jobs'))
    expect(update?.sql).toContain('legacy_processing_expires_at <= datetime')
    expect(update?.sql).toContain('legacy_processing_token = NULL')
    expect(update?.params).toEqual(['job_stale', 1, 1])
    const audit = db.executed.find(item =>
      item.sql.includes('INSERT INTO admin_audit_logs')
      && item.params[2] === 'recover_stale_legacy_import_job',
    )
    expect(audit?.params[2]).toBe('recover_stale_legacy_import_job')
    expect(JSON.parse(String(audit?.params[5]))).toEqual({
      status: 'failed',
      errorCode: 'LEGACY_IMPORT_PROCESSING_LEASE_EXPIRED',
    })
  })

  it('有效 processing 租约拒绝提前回收且不形成成功审计', async () => {
    const db = createDb([], {
      id: 'job_active',
      status: 'processing',
      legacy_processing_expires_at: '2099-08-20T08:30:00.000Z',
    }, 0)

    const res = await createApp().request(
      '/api/admin/legacy-import/jobs/job_active/recover-stale',
      { method: 'POST' },
      { DB: db } as unknown as Bindings,
    )
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toEqual({
      statusCode: 409,
      message: '任务处理租约仍有效，不能提前回收',
    })
    const audit = db.executed.find(item =>
      item.sql.includes('INSERT INTO admin_audit_logs')
      && item.params[2] === 'recover_stale_legacy_import_job',
    )
    expect(audit?.sql).toContain('WHERE changes() = 1')
  })
})

describe('旧站迁移条目审核', () => {
  it('原子形成终态与审计，但不覆盖原始 review_flags 或直接发布 Gallery', async () => {
    const records: Array<{ sql: string; params: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const record = { sql, params: [] as unknown[] }
        records.push(record)
        const statement = {
          bind(...values: unknown[]) {
            record.params.push(...values)
            return statement
          },
          async first<T>() {
            return {
              id: 'lii_1',
              status: 'imported',
              review_status: 'pending',
            } as T
          },
        }
        return statement
      },
      async batch() {
        return [
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } },
        ]
      },
    }

    const res = await createApp().request('/api/admin/legacy-import/items/lii_1/review', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus: 'approved', note: '已核对授权材料' }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, replayed: false, galleryPublished: false })
    const update = records.find(record => record.sql.includes('UPDATE legacy_import_items'))
    expect(update?.sql).not.toContain('review_flags')
    expect(records.some(record => record.sql.includes('UPDATE galleries'))).toBe(false)
    const audit = records.find(record => record.sql.includes('review_legacy_import_item'))
    expect(JSON.parse(String(audit?.params[4]))).toEqual({
      reviewStatus: 'approved',
      note: '已核对授权材料',
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
