import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramImportPayload } from '../utils/import-validation'
import { createExternalImportRecord, getExternalImportStatus, processTelegramFileIdImport, resetFailedImportForRetry } from './telegram-file-id-import'

type RecordRow = Record<string, unknown>

function createDb(options: { existingCaseSlug?: string; failAfterCaseImageInsertCount?: number } = {}) {
  const records: Record<string, RecordRow> = {}
  const files: RecordRow[] = []
  const cases: RecordRow[] = []
  const executedSql: string[] = []
  let insertedCaseImages = 0
  return {
    records,
    files,
    cases,
    executedSql,
    prepare(sql: string) {
      executedSql.push(sql)
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          if (sql.includes('FROM external_import_records') && sql.includes("source = 'telegram'")) return Object.values(records).find(row => row.token_id === params[0] && row.external_message_id === params[1]) as T
          if (sql.includes('FROM external_import_records eir')) return Object.values(records).find(row => row.id === params[0]) as T
          if (sql.includes('FROM external_import_records') && sql.includes('WHERE id = ? AND token_id = ?')) return Object.values(records).find(row => row.id === params[0] && row.token_id === params[1]) as T
          if (sql.includes('FROM external_import_files') && sql.includes('r2_key IS NOT NULL')) return files.find(row => row.import_id === params[0] && (row.r2_key || row.target_file_id)) as T
          if (sql.includes('SELECT id FROM cases WHERE slug = ?') && params[0] === options.existingCaseSlug) return { id: 'tc_existing' } as T
          return null as T
        },
        async all<T>() {
          if (sql.includes('FROM external_import_files')) return { results: files.filter(row => row.import_id === params[0]) as T[] }
          return { results: [] as T[] }
        },
        async run() {
          if (sql.includes('INSERT INTO external_import_records')) {
            records[String(params[0])] = {
              id: params[0],
              external_message_id: params[1],
              token_id: params[2],
              source_bot_key: params[3],
              target_type: params[7],
              metadata_json: params[8],
              file_count: params[9],
              fetched_count: 0,
              failed_count: 0,
              retry_count: 0,
              target_id: null,
              status: 'pending_media_fetch',
              token_created_by: 42,
              created_at: '2026-05-06T00:00:00.000Z',
              completed_at: null,
            }
          }
          if (sql.includes('INSERT INTO external_import_files')) files.push({ id: params[0], import_id: params[1], telegram_file_id: params[2], filename: params[4], status: 'pending', sort_order: params[6], r2_key: null, target_file_id: null, error_message: null })
          if (sql.includes("SET status = 'fetching_media'")) {
            const record = records[String(params[0])]
            if (record?.status !== 'pending_media_fetch') return { success: true, meta: { changes: 0 } }
            record.status = 'fetching_media'
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes("SET status = 'fetching'")) {
            const file = files.find(row => row.id === params[0])
            if (file) file.status = 'fetching'
          }
          if (sql.includes("SET status = 'completed'")) {
            const file = files.find(row => row.id === params[4])
            if (file) {
              file.status = 'completed'
              file.r2_key = params[2]
              file.target_file_id = params[3]
            }
          }
          if (sql.includes('SET fetched_count = ?')) records[String(params[1])].fetched_count = params[0]
          if (sql.includes('INSERT INTO case_images')) {
            insertedCaseImages++
            if (options.failAfterCaseImageInsertCount !== undefined && insertedCaseImages > options.failAfterCaseImageInsertCount) {
              throw new Error('写入 case_images 失败')
            }
          }
          if (sql.includes('INSERT INTO cases')) {
            cases.push({
              id: params[0],
              title: params[1],
              slug: params[2],
              created_by: params[9],
              updated_by: params[10],
            })
          }
          if (sql.includes('SET r2_key = NULL, target_file_id = NULL')) {
            for (const file of files.filter(row => row.import_id === params[0])) {
              file.r2_key = null
              file.target_file_id = null
            }
          }
          if (sql.includes("SET status = 'failed', error_message")) {
            const file = files.find(row => row.id === params[1])
            if (file) {
              file.status = 'failed'
              file.error_message = params[0]
            }
          }
          if (sql.includes("SET status = 'failed'") && !sql.includes('UPDATE external_import_files')) {
            const record = records[String(params[4] ?? params[3] ?? params[1])]
            record.status = 'failed'
            record.error_json = params.length >= 5 ? params[3] : params.length >= 4 ? params[2] : params[0]
            record.target_id = params.length >= 5 ? params[0] : null
            if (params.length >= 4) {
              record.fetched_count = files.filter(row => row.import_id === record.id && row.status === 'completed').length
              record.failed_count = files.filter(row => row.import_id === record.id && row.status === 'failed').length
            } else {
              record.failed_count = record.file_count
            }
          }
          if (sql.includes("SET status = 'pending_media_fetch'")) records[String(params[0])].status = 'pending_media_fetch'
          return { success: true, meta: { changes: 1 } }
        },
      }
    },
  }
}

const payload: TelegramImportPayload = {
  metadata: { type: 'gallery', source: 'telegram', externalMessageId: '-100:1', title: '标题', slug: 'title-001', requiredLevelRank: 0 },
  telegram: { sourceBotKey: 'ops_gallery_bot', sourceChatId: '-100', sourceMessageId: '1' },
  files: [{ fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Telegram file_id 导入服务', () => {
  it('异步抓取媒体前创建外部导入记录', async () => {
    const db = createDb()
    const result = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, '127.0.0.1', 'vitest')

    expect(result.status).toBe('pending_media_fetch')
    expect(result.receivedFileCount).toBe(1)
    expect(db.files).toHaveLength(1)
  })

  it('已存在导入时返回 duplicate 且不创建第二条记录', async () => {
    const db = createDb()
    const first = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    const second = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)

    expect(second.status).toBe('duplicate')
    expect(second.importId).toBe(first.importId)
    expect(Object.keys(db.records)).toHaveLength(1)
  })

  it('只返回同一 token 的导入状态', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    const status = await getExternalImportStatus(db as unknown as D1Database, created.importId, 'iat_1')

    expect(status.importId).toBe(created.importId)
    expect(status.files).toHaveLength(1)
  })

  it('状态响应返回异步失败 code 和 message', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'
    db.records[created.importId].error_json = JSON.stringify({ code: 'TELEGRAM_BOT_TOKEN_MISSING', message: '未配置 Telegram Bot Token' })

    const status = await getExternalImportStatus(db as unknown as D1Database, created.importId, 'iat_1')

    expect(status.error).toEqual({ code: 'TELEGRAM_BOT_TOKEN_MISSING', message: '未配置 Telegram Bot Token' })
  })

  it('媒体抓取失败时标记当前文件失败', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)

    await processTelegramFileIdImport(db as unknown as D1Database, { delete: async () => undefined } as unknown as R2Bucket, {}, created.importId)

    expect(db.records[created.importId].status).toBe('failed')
    expect(db.files[0].status).toBe('failed')
    expect(db.files[0].error_message).toBe('未配置 Telegram Bot Token')
  })

  it('保持 fetched 和 failed 计数与文件状态一致', async () => {
    const db = createDb()
    const twoFilePayload: TelegramImportPayload = {
      ...payload,
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', twoFilePayload, null, null)
    const body = new Uint8Array([1, 2, 3]).buffer
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('AgACAg1')) return Response.json({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } })
      if (url.includes('photos/1.jpg')) return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
      return Response.json({ ok: false }, { status: 502 })
    }))

    await processTelegramFileIdImport(db as unknown as D1Database, { put: async () => undefined, delete: async () => undefined } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(db.records[created.importId].fetched_count).toBe(1)
    expect(db.records[created.importId].failed_count).toBe(1)
  })

  it('清理失败时仍标记导入记录为 failed', async () => {
    const db = createDb()
    const twoFilePayload: TelegramImportPayload = {
      ...payload,
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', twoFilePayload, null, null)
    const body = new Uint8Array([1, 2, 3]).buffer
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('AgACAg1')) return Response.json({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } })
      if (url.includes('photos/1.jpg')) return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
      return Response.json({ ok: false }, { status: 502 })
    }))

    await processTelegramFileIdImport(db as unknown as D1Database, {
      put: async () => undefined,
      delete: async () => { throw new Error('R2 删除失败') },
    } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(db.records[created.importId].status).toBe('failed')
    expect(String(db.records[created.importId].error_json)).toContain('Telegram getFile 调用失败')
    expect(String(db.records[created.importId].error_json)).toContain('R2 删除失败')
    expect(consoleError).toHaveBeenCalled()
  })

  it('记录已非 pending 时不抓取上传也不改为失败', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'draft_created'
    const put = vi.fn(async () => undefined)

    await processTelegramFileIdImport(db as unknown as D1Database, { put, delete: async () => undefined } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(put).not.toHaveBeenCalled()
    expect(db.records[created.importId].status).toBe('draft_created')
    expect(db.executedSql.some(sql => sql.includes('INSERT INTO cases'))).toBe(false)
    expect(db.executedSql.some(sql => sql.includes("SET status = 'failed'"))).toBe(false)
  })

  it('重置失败导入以便重试', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'

    const retry = await resetFailedImportForRetry(db as unknown as D1Database, created.importId, {
      id: 'iat_1',
      permissions: '["gallery:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
    })

    expect(retry.status).toBe('pending_media_fetch')
    expect(db.records[created.importId].status).toBe('pending_media_fetch')
  })

  it('重试失败导入前重新检查 token 权限', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'

    await expect(resetFailedImportForRetry(db as unknown as D1Database, created.importId, {
      id: 'iat_1',
      permissions: '["case:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
    })).rejects.toMatchObject({ code: 'IMPORT_PERMISSION_DENIED' })
  })

  it('将 case 导入写入 cases 与 case_images', async () => {
    const db = createDb()
    const casePayload: TelegramImportPayload = {
      ...payload,
      metadata: { ...payload.metadata, type: 'case', slug: 'case-001' },
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', casePayload, null, null)
    const body = new Uint8Array([1, 2, 3]).buffer
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('AgACAg1')) return Response.json({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } })
      if (url.includes('AgACAg2')) return Response.json({ ok: true, result: { file_path: 'photos/2.jpg', file_size: 3 } })
      return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
    }))
    const putKeys: string[] = []

    await processTelegramFileIdImport(db as unknown as D1Database, {
      put: async (key: string) => { putKeys.push(key) },
      delete: async () => undefined,
    } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(putKeys.every(key => key.startsWith('cases/'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('SELECT id FROM cases WHERE slug = ?'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('INSERT INTO cases'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('INSERT INTO case_images'))).toBe(true)
    expect(db.cases[0].created_by).toBe(42)
    expect(db.cases[0].updated_by).toBe(42)
    expect(db.executedSql.some(sql => sql.includes('testimonial_cases'))).toBe(false)
    expect(db.executedSql.some(sql => sql.includes('testimonial_case_images'))).toBe(false)
  })

  it('case_images 写入后失败时清理 R2、case 表和外部文件记录', async () => {
    const db = createDb({ failAfterCaseImageInsertCount: 1 })
    const casePayload: TelegramImportPayload = {
      ...payload,
      metadata: { ...payload.metadata, type: 'case', slug: 'case-001' },
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', casePayload, null, null)
    const body = new Uint8Array([1, 2, 3]).buffer
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('AgACAg1')) return Response.json({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } })
      if (url.includes('AgACAg2')) return Response.json({ ok: true, result: { file_path: 'photos/2.jpg', file_size: 3 } })
      return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
    }))
    const deletedKeys: string[] = []

    await processTelegramFileIdImport(db as unknown as D1Database, {
      put: async () => undefined,
      delete: async (keys: string | string[]) => { deletedKeys.push(...(Array.isArray(keys) ? keys : [keys])) },
    } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(deletedKeys).toHaveLength(2)
    expect(deletedKeys.every(key => key.startsWith('cases/'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('INSERT INTO case_images'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('DELETE FROM case_images WHERE case_id = ?'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('DELETE FROM cases WHERE id = ?'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('testimonial_case_images'))).toBe(false)
    expect(db.executedSql.some(sql => sql.includes('testimonial_cases'))).toBe(false)
    expect(db.files.every(file => file.r2_key === null && file.target_file_id === null)).toBe(true)
  })

  it('R2 删除失败时仍清理 case 相关 D1 行并标记 failed', async () => {
    const db = createDb({ failAfterCaseImageInsertCount: 1 })
    const casePayload: TelegramImportPayload = {
      ...payload,
      metadata: { ...payload.metadata, type: 'case', slug: 'case-001' },
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', casePayload, null, null)
    const body = new Uint8Array([1, 2, 3]).buffer
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('AgACAg1')) return Response.json({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } })
      if (url.includes('AgACAg2')) return Response.json({ ok: true, result: { file_path: 'photos/2.jpg', file_size: 3 } })
      return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
    }))

    await processTelegramFileIdImport(db as unknown as D1Database, {
      put: async () => undefined,
      delete: async () => { throw new Error('R2 删除失败') },
    } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(db.records[created.importId].status).toBe('failed')
    expect(db.records[created.importId].target_id).toBeNull()
    expect(String(db.records[created.importId].error_json)).toContain('R2 删除失败')
    expect(db.executedSql.some(sql => sql.includes('DELETE FROM case_images WHERE case_id = ?'))).toBe(true)
    expect(db.executedSql.some(sql => sql.includes('DELETE FROM cases WHERE id = ?'))).toBe(true)
    expect(consoleError).toHaveBeenCalled()
  })

  it('重试失败导入前重新检查 sourceBotKey 允许列表', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'

    await expect(resetFailedImportForRetry(db as unknown as D1Database, created.importId, {
      id: 'iat_1',
      permissions: '["gallery:create"]',
      allowedSourceBotKeys: '["other_bot"]',
    })).rejects.toMatchObject({ code: 'IMPORT_SOURCE_BOT_NOT_ALLOWED' })
  })
})
