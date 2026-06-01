import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminImportRoutes } from './import-jobs'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    c.set('userRole', 'owner')
    await next()
  })
  app.route('/api/admin/import-jobs', adminImportRoutes)
  return app
}

function createDb() {
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
          if (sql.includes("WHERE status = 'processing'")) return { count: 0 } as T
          if (sql.includes("WHERE id = ? AND status = 'queued'")) return { id: params[0], status: 'queued' } as T
          return null as T
        },
        async all<T>() {
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

function createErrorReportDb(errorReportKey: string | null) {
  return {
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          if (sql.includes('SELECT error_report_key FROM import_jobs')) {
            return { error_report_key: errorReportKey } as T
          }
          return null as T
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
      targetId: item.params[4],
      afterValue: item.params[6] ? JSON.parse(item.params[6] as string) as Record<string, unknown> : null,
    }))
}

describe('后台导入任务 Turnstile 防护', () => {
  it('配置 Turnstile 后，创建导入任务缺少 token 时不写入任务', async () => {
    const db = createDb()
    const res = await createApp().request('/api/admin/import-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalCount: 0, sourceDescription: '手动创建' }),
    }, { DB: db, APP_ENV: 'production', TURNSTILE_SECRET_KEY: 'secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toBe('请完成人机验证')
    expect(db.executed.some(item => item.sql.includes('INSERT INTO import_jobs'))).toBe(false)
  })

  it('配置 Turnstile 后，处理导入任务缺少 token 时不进入 processing', async () => {
    const db = createDb()
    const res = await createApp().request('/api/admin/import-jobs/imp_1/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        galleries: [
          { folder: 'gallery-001', title: '测试图库', slug: 'test-gallery' },
        ],
      }),
    }, { DB: db, APP_ENV: 'production', TURNSTILE_SECRET_KEY: 'secret' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.message).toBe('请完成人机验证')
    expect(db.executed.some(item => item.sql.includes("SET status = 'processing'"))).toBe(false)
  })
})

describe('后台导入任务审计', () => {
  it('处理导入任务完成后写入最终结果审计', async () => {
    const db = createDb()
    const res = await createApp().request('/api/admin/import-jobs/imp_1/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        galleries: [
          { folder: 'gallery-001', title: '测试图库', slug: 'test-gallery', status: 'draft' },
        ],
      }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('completed')

    const audit = auditPayloads(db).find(item => item.action === 'process_import')
    expect(audit).toMatchObject({
      action: 'process_import',
      targetType: 'import_job',
      targetId: 'imp_1',
    })
    expect(audit?.afterValue).toMatchObject({
      status: 'completed',
      totalCount: 1,
      successCount: 1,
      failureCount: 0,
      errorReportKey: null,
    })
  })
})

describe('后台导入任务错误报告下载', () => {
  it('拒绝读取不属于当前任务的错误报告 R2 key', async () => {
    const r2Get = vi.fn()
    const res = await createApp().request('/api/admin/import-jobs/imp_1/errors', {}, {
      DB: createErrorReportDb('imports/imp_2/errors.csv'),
      R2: { get: r2Get },
    } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.message).toBe('错误报告配置异常')
    expect(r2Get).not.toHaveBeenCalled()
  })

  it('读取当前任务的错误报告 R2 key', async () => {
    const r2Get = vi.fn(async () => ({
      body: new Blob(['folder,error\n"gallery-001","slug 已存在"']).stream(),
    }))
    const res = await createApp().request('/api/admin/import-jobs/imp_1/errors', {}, {
      DB: createErrorReportDb('imports/imp_1/errors.csv'),
      R2: { get: r2Get },
    } as unknown as Bindings)

    expect(res.status).toBe(200)
    expect(r2Get).toHaveBeenCalledWith('imports/imp_1/errors.csv')
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="import-errors-imp_1.csv"')
  })
})
