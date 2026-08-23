import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'

const zipService = vi.hoisted(() => ({
  initialize: vi.fn(),
  uploadPart: vi.fn(),
  complete: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  resume: vi.fn(),
}))

vi.mock('../../services/admin-zip-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/admin-zip-import')>()
  return {
    ...actual,
    initializeZipImportPackageUpload: zipService.initialize,
    uploadZipImportPackagePart: zipService.uploadPart,
    completeZipImportPackageUpload: zipService.complete,
    startZipImportJob: zipService.start,
    retryFailedZipImportItems: zipService.retry,
    resumePausedZipImportJob: zipService.resume,
  }
})

import { adminImportRoutes } from './import-jobs'

function createApp(role = 'owner') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', 7)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin/import-jobs', adminImportRoutes)
  return app
}

function noWriteDb() {
  const run = vi.fn()
  const batch = vi.fn()
  return {
    run,
    batch,
    prepare() {
      return {
        bind() { return this },
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run,
      }
    },
  }
}

function createErrorReportDb(errorReportKey: string | null) {
  return {
    prepare(sql: string) {
      return {
        bind() { return this },
        async first<T>() {
          if (sql.includes('SELECT error_report_key')) return { error_report_key: errorReportKey } as T
          return null as T
        },
      }
    },
  }
}

describe('后台 ZIP 导入任务路由', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Turnstile 已配置时，缺少 token 不创建任务', async () => {
    const db = noWriteDb()
    const response = await createApp().request('/api/admin/import-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, {
      DB: db,
      APP_ENV: 'production',
      TURNSTILE_SECRET_KEY: 'secret',
    } as unknown as Bindings)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: '请完成人机验证' })
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('Turnstile 已配置时，缺少 token 不启动处理状态机', async () => {
    const response = await createApp().request('/api/admin/import-jobs/imp_1/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, {
      DB: noWriteDb(),
      APP_ENV: 'production',
      TURNSTILE_SECRET_KEY: 'secret',
    } as unknown as Bindings)

    expect(response.status).toBe(400)
    expect(zipService.start).not.toHaveBeenCalled()
  })

  it('初始化 multipart 时只把文件名和大小交给服务层，不接收客户端 uploadId', async () => {
    zipService.initialize.mockResolvedValue({
      id: 'imp_1',
      status: 'uploading',
      uploadSession: '11111111-1111-4111-8111-111111111111',
      partSize: 8 * 1024 * 1024,
      partCount: 2,
      sourceName: 'gallery-import.zip',
    })
    const response = await createApp('admin').request('/api/admin/import-jobs/imp_1/package/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceName: 'gallery-import.zip',
        packageSize: 9 * 1024 * 1024,
        uploadId: 'attacker-controlled',
      }),
    }, { DB: noWriteDb() } as unknown as Bindings)

    expect(response.status).toBe(200)
    expect(zipService.initialize).toHaveBeenCalledWith(
      expect.anything(),
      { adminId: 7, role: 'admin' },
      'imp_1',
      'gallery-import.zip',
      9 * 1024 * 1024,
    )
  })

  it('上传分片时转发服务端会话、序号、声明大小和原始流', async () => {
    zipService.uploadPart.mockResolvedValue({ partNumber: 2, uploadedParts: 2, partCount: 2 })
    const response = await createApp().request('/api/admin/import-jobs/imp_1/package/parts/2', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Import-Part-Size': '3',
        'X-Import-Upload-Session': '11111111-1111-4111-8111-111111111111',
      },
      body: new Uint8Array([1, 2, 3]),
    }, { DB: noWriteDb() } as unknown as Bindings)

    expect(response.status).toBe(200)
    expect(zipService.uploadPart).toHaveBeenCalledWith(
      expect.anything(),
      { adminId: 7, role: 'owner' },
      'imp_1',
      '11111111-1111-4111-8111-111111111111',
      2,
      3,
      expect.any(ReadableStream),
    )
  })

  it('完成 multipart 时只提交一次性会话，不信任客户端 parts/ETag', async () => {
    zipService.complete.mockResolvedValue({
      id: 'imp_1',
      status: 'queued',
      packageSize: 9 * 1024 * 1024,
      sourceName: 'gallery-import.zip',
    })
    const response = await createApp().request('/api/admin/import-jobs/imp_1/package/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadSession: '11111111-1111-4111-8111-111111111111',
        parts: [{ partNumber: 1, etag: 'attacker-controlled' }],
      }),
    }, { DB: noWriteDb() } as unknown as Bindings)

    expect(response.status).toBe(200)
    expect(zipService.complete).toHaveBeenCalledWith(
      expect.anything(),
      { adminId: 7, role: 'owner' },
      'imp_1',
      '11111111-1111-4111-8111-111111111111',
    )
  })
})

describe('后台导入任务错误报告下载', () => {
  it('拒绝读取不属于当前任务的错误报告 R2 key', async () => {
    const r2Get = vi.fn()
    const response = await createApp().request('/api/admin/import-jobs/imp_1/errors', {}, {
      DB: createErrorReportDb('imports/imp_2/errors.csv'),
      R2: { get: r2Get },
    } as unknown as Bindings)

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: '错误报告不存在' })
    expect(r2Get).not.toHaveBeenCalled()
  })

  it('只流式读取当前任务的固定错误报告 key', async () => {
    const r2Get = vi.fn(async () => ({
      body: new Blob(['folder,error\n"gallery-001","slug 已存在"']).stream(),
    }))
    const response = await createApp().request('/api/admin/import-jobs/imp_1/errors', {}, {
      DB: createErrorReportDb('imports/imp_1/errors.csv'),
      R2: { get: r2Get },
    } as unknown as Bindings)

    expect(response.status).toBe(200)
    expect(r2Get).toHaveBeenCalledWith('imports/imp_1/errors.csv')
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="import-errors-imp_1.csv"')
  })
})
