import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramImportPayload } from '../utils/import-validation'
import {
  createExternalImportRecord,
  getExternalImportStatus,
  handleTelegramImportQueueBatch,
  processTelegramFileIdImport as processQueuedTelegramImport,
  recoverStaleExternalImport,
  resetFailedImportForRetry as resetQueuedTelegramImport,
  type RetryImportToken,
  type TelegramImportEnvironment,
  type TelegramImportQueueMessage,
} from './telegram-file-id-import'

const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11,
  0x08, 0x00, 0x10, 0x00, 0x20, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x0c,
  0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00,
  0x00, 0xff, 0xd9,
])

type RecordRow = Record<string, unknown>

function createDb(options: {
  existingCaseSlug?: string
  failAfterCaseImageInsertCount?: number
  rejectAtomicRecordInsert?: boolean
} = {}) {
  const records: Record<string, RecordRow> = {}
  const files: RecordRow[] = []
  const cases: RecordRow[] = []
  const executedSql: string[] = []
  let insertedCaseImages = 0
  let batchCalls = 0
  return {
    records,
    files,
    cases,
    executedSql,
    get batchCalls() {
      return batchCalls
    },
    async batch(statements: Array<{ run(): Promise<D1Result<unknown>> }>) {
      batchCalls++
      const results: D1Result<unknown>[] = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
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
          if (sql.includes('FROM external_import_files')) {
            const matching = files.filter(row => row.import_id === params[0])
            return {
              results: (sql.includes("status = 'completed'")
                ? matching.filter(row => row.status === 'completed')
                : matching) as T[],
            }
          }
          return { results: [] as T[] }
        },
        async run() {
          if (sql.includes('INSERT INTO external_import_records')) {
            if (options.rejectAtomicRecordInsert) return { success: true, meta: { changes: 0 } }
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
              processing_token: null,
              processing_target_id: null,
              processing_started_at: null,
              processing_heartbeat_at: null,
              processing_lease_expires_at: null,
              status: 'pending_media_fetch',
              token_created_by: 42,
              created_at: '2026-05-06T00:00:00.000Z',
              completed_at: null,
            }
          }
          if (sql.includes('INSERT INTO external_import_files') && records[String(params[1])]) files.push({
            id: params[0],
            import_id: params[1],
            telegram_file_id: params[2],
            filename: params[4],
            declared_mime_type: params[5],
            status: 'pending',
            sort_order: params[6],
            is_cover: params[7],
            r2_key: null,
            target_file_id: null,
            actual_mime_type: null,
            file_size: null,
            error_message: null,
          })
          if (sql.includes('SET processing_token = ?') && sql.includes("status = 'failed'")) {
            const record = records[String(params[2])]
            const leaseExpired = typeof record?.processing_lease_expires_at !== 'string'
              || Date.parse(record.processing_lease_expires_at) <= Date.now()
            if (record?.status !== 'failed' || (record.processing_token && !leaseExpired)) {
              return { success: true, meta: { changes: 0 } }
            }
            record.processing_token = params[0]
            record.processing_lease_expires_at = params[1]
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes('SET processing_token = ?') && sql.includes('processing_heartbeat_at')) {
            const record = records[String(params[2])]
            const expectedStatus = sql.includes("status = 'pending_media_fetch'")
              ? 'pending_media_fetch'
              : 'fetching_media'
            if (record?.status !== expectedStatus) return { success: true, meta: { changes: 0 } }
            record.processing_token = params[0]
            record.processing_lease_expires_at = params[1]
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes("SET status = 'fetching_media'")) {
            const record = records[String(params[2])]
            if (record?.status !== 'pending_media_fetch' || record.processing_token !== params[3]) return { success: true, meta: { changes: 0 } }
            record.status = 'fetching_media'
            record.processing_target_id = params[0]
            record.processing_lease_expires_at = params[1]
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes('SET processing_heartbeat_at')) {
            const record = records[String(params[1])]
            if (record?.status !== 'fetching_media' || record.processing_token !== params[2]) return { success: true, meta: { changes: 0 } }
            if (sql.includes('processing_lease_expires_at IS NULL')) {
              const leaseExpired = typeof record.processing_lease_expires_at !== 'string'
                || Date.parse(record.processing_lease_expires_at) <= Date.now()
              if (!leaseExpired) return { success: true, meta: { changes: 0 } }
            }
            record.processing_lease_expires_at = params[0]
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes("SET status = 'fetching'")) {
            const file = files.find(row => row.id === params[2])
            if (!file) return { success: true, meta: { changes: 0 } }
            file.status = 'fetching'
            file.target_file_id = params[0]
            file.r2_key = params[1]
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes("SET status = 'completed'")) {
            const file = files.find(row => row.id === params[2])
            if (!file) return { success: true, meta: { changes: 0 } }
            file.status = 'completed'
            file.actual_mime_type = params[0]
            file.file_size = params[1]
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes('SET fetched_count = (')) {
            const record = records[String(params[1])]
            record.fetched_count = files.filter(row => row.import_id === params[0] && row.status === 'completed').length
          }
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
          if (sql.includes('r2_key = NULL, target_file_id = NULL')) {
            for (const file of files.filter(row => row.import_id === params[0])) {
              file.status = file.status === 'failed' ? 'failed' : 'pending'
              file.r2_key = null
              file.target_file_id = null
              file.actual_mime_type = null
              file.file_size = null
            }
          }
          if (sql.includes("SET status = 'failed', error_message")) {
            const file = files.find(row => row.id === params[1])
            if (file) {
              file.status = 'failed'
              file.error_message = params[0]
            }
          }
          if (sql.includes("SET status = 'draft_created'")) {
            const record = records[String(params[2])]
            if (record?.processing_token !== params[3]) return { success: true, meta: { changes: 0 } }
            record.status = 'draft_created'
            record.target_id = params[0]
            record.fetched_count = params[1]
            record.processing_token = null
            record.processing_target_id = null
            return { success: true, meta: { changes: 1 } }
          }
          if (sql.includes("SET status = 'failed'") && !sql.includes('UPDATE external_import_files')) {
            if (sql.includes('processing_target_id = ?')) {
              const record = records[String(params[4])]
              record.status = 'failed'
              record.processing_target_id = params[0]
              record.processing_token = null
              record.error_json = params[3]
              record.fetched_count = files.filter(row => row.import_id === record.id && row.status === 'completed').length
              record.failed_count = files.filter(row => row.import_id === record.id && row.status === 'failed').length
            } else {
              const record = records[String(params[1])]
              if (record) {
                record.status = 'failed'
                record.processing_token = null
                record.error_json = params[0]
              }
            }
          }
          if (sql.includes("SET status = 'pending_media_fetch'")) {
            const record = records[String(params[0])]
            record.status = 'pending_media_fetch'
            record.processing_token = null
            record.processing_target_id = null
            record.retry_count = Number(record.retry_count ?? 0) + 1
          }
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

async function processTelegramFileIdImport(
  db: D1Database,
  r2: R2Bucket,
  secrets: Record<string, string | undefined>,
  importId: string,
) {
  const processingToken = `processing-token-${importId}`
  const fixture = db as unknown as ReturnType<typeof createDb>
  fixture.records[importId].processing_token = processingToken
  const message: TelegramImportQueueMessage = {
    schemaVersion: 1,
    kind: 'telegram_file_id_import',
    importId,
    processingToken,
  }
  return processQueuedTelegramImport(
    { DB: db, R2: r2, ...secrets } as unknown as TelegramImportEnvironment,
    message,
  )
}

async function resetFailedImportForRetry(
  db: D1Database,
  importId: string,
  token: Omit<RetryImportToken, 'actorAdminId' | 'auditAction'>,
) {
  return resetQueuedTelegramImport(
    {
      DB: db,
      R2: { delete: async () => undefined } as unknown as R2Bucket,
      TELEGRAM_IMPORT_QUEUE: { send: async () => undefined } as unknown as Queue<TelegramImportQueueMessage>,
    },
    importId,
    { ...token, actorAdminId: 42, auditAction: 'telegram_import.retry' },
  )
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
    expect(db.batchCalls).toBe(1)
  })

  it('在原子写入时再次检查每日限额，竞争失败不留下文件行', async () => {
    const db = createDb({ rejectAtomicRecordInsert: true })

    await expect(createExternalImportRecord(
      db as unknown as D1Database,
      'iat_1',
      payload,
      null,
      null,
      { dailyLimit: 1 },
    )).rejects.toMatchObject({ code: 'IMPORT_DAILY_LIMIT_EXCEEDED', status: 429 })

    expect(Object.keys(db.records)).toHaveLength(0)
    expect(db.files).toHaveLength(0)
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

  it('读取历史未知错误时不透传底层异常原文', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'
    db.records[created.importId].error_json = JSON.stringify({
      code: 'UNKNOWN_LEGACY_ERROR',
      message: 'D1 private failure with 123:secret',
    })
    db.files[0].status = 'failed'
    db.files[0].error_message = 'R2 private failure'

    const status = await getExternalImportStatus(db as unknown as D1Database, created.importId, 'iat_1')

    expect(status.error).toEqual({
      code: 'IMPORT_PROCESS_FAILED',
      message: '导入处理失败，请稍后重试',
    })
    expect(status.files[0].errorMessage).toBe('导入处理失败，请稍后重试')
    expect(JSON.stringify(status)).not.toContain('123:secret')
  })

  it('媒体抓取失败时标记当前文件失败', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)

    await processTelegramFileIdImport(db as unknown as D1Database, { delete: async () => undefined } as unknown as R2Bucket, {}, created.importId)

    expect(db.records[created.importId].status).toBe('failed')
    expect(db.files[0].status).toBe('failed')
    expect(db.files[0].error_message).toBe('未配置 Telegram Bot Token')
  })

  it('失败清理后按当前文件状态重算 fetched 和 failed 计数', async () => {
    const db = createDb()
    const twoFilePayload: TelegramImportPayload = {
      ...payload,
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', twoFilePayload, null, null)
    const body = VALID_JPEG_BYTES
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('AgACAg1')) return Response.json({ ok: true, result: { file_path: 'photos/1.jpg', file_size: 3 } })
      if (url.includes('photos/1.jpg')) return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } })
      return Response.json({ ok: false }, { status: 502 })
    }))

    await processTelegramFileIdImport(db as unknown as D1Database, { put: async () => undefined, delete: async () => undefined } as unknown as R2Bucket, { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' }, created.importId)

    expect(db.records[created.importId].fetched_count).toBe(0)
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
    const body = VALID_JPEG_BYTES
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
    expect(String(db.records[created.importId].error_json)).toContain('IMPORT_R2_CLEANUP_FAILED')
    expect(String(db.records[created.importId].error_json)).not.toContain('R2 删除失败')
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

  it('重复投递遇到有效 fetching 租约时不并行消费并请求 Queue 稍后重试', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    const processingToken = `processing-token-${created.importId}`
    db.records[created.importId].status = 'fetching_media'
    db.records[created.importId].processing_token = processingToken
    db.records[created.importId].processing_target_id = 'gal_active'
    db.records[created.importId].processing_lease_expires_at = '2099-01-01T00:00:00.000Z'
    const ack = vi.fn()
    const retry = vi.fn()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await handleTelegramImportQueueBatch({
      messages: [{
        body: {
          schemaVersion: 1,
          kind: 'telegram_file_id_import',
          importId: created.importId,
          processingToken,
        },
        ack,
        retry,
      }],
    } as unknown as MessageBatch<TelegramImportQueueMessage>, {
      DB: db as unknown as D1Database,
      R2: { put: async () => undefined, delete: async () => undefined } as unknown as R2Bucket,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(db.records[created.importId].status).toBe('fetching_media')
    expect(db.records[created.importId].processing_target_id).toBe('gal_active')
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

  it('失败重试认领可替换过期租约，但拒绝覆盖仍有效的清理执行权', async () => {
    const expiredDb = createDb()
    const expired = await createExternalImportRecord(expiredDb as unknown as D1Database, 'iat_1', payload, null, null)
    expiredDb.records[expired.importId].status = 'failed'
    expiredDb.records[expired.importId].processing_token = 'abandoned-retry-token'
    expiredDb.records[expired.importId].processing_lease_expires_at = '2026-01-01T00:00:00.000Z'

    await expect(resetFailedImportForRetry(expiredDb as unknown as D1Database, expired.importId, {
      id: 'iat_1',
      permissions: '["gallery:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
    })).resolves.toMatchObject({ status: 'pending_media_fetch' })

    const activeDb = createDb()
    const active = await createExternalImportRecord(activeDb as unknown as D1Database, 'iat_1', payload, null, null)
    activeDb.records[active.importId].status = 'failed'
    activeDb.records[active.importId].processing_token = 'active-retry-token'
    activeDb.records[active.importId].processing_lease_expires_at = '2099-01-01T00:00:00.000Z'

    await expect(resetFailedImportForRetry(activeDb as unknown as D1Database, active.importId, {
      id: 'iat_1',
      permissions: '["gallery:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
    })).rejects.toMatchObject({ code: 'IMPORT_RETRY_CONFLICT' })
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
    const body = VALID_JPEG_BYTES
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

  it('目标 batch 已成功但最终状态未落账时，重投复用同一 case 并完成收敛', async () => {
    const db = createDb({ existingCaseSlug: 'case-resume' })
    const casePayload: TelegramImportPayload = {
      ...payload,
      metadata: { ...payload.metadata, type: 'case', slug: 'case-resume' },
      files: [
        { fileId: 'AgACAg1', mimeType: 'image/jpeg', sortOrder: 0, isCover: true },
        { fileId: 'AgACAg2', mimeType: 'image/jpeg', sortOrder: 1 },
      ],
    }
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', casePayload, null, null)
    const processingToken = `processing-token-${created.importId}`
    db.records[created.importId].status = 'fetching_media'
    db.records[created.importId].processing_token = processingToken
    db.records[created.importId].processing_target_id = 'tc_existing'
    db.records[created.importId].processing_lease_expires_at = '2026-01-01T00:00:00.000Z'
    for (const [index, file] of db.files.entries()) {
      file.status = 'completed'
      file.target_file_id = `tci_${index}`
      file.r2_key = `cases/tc_existing/tci_${index}.jpg`
      file.actual_mime_type = 'image/jpeg'
      file.file_size = VALID_JPEG_BYTES.byteLength
    }

    const result = await processQueuedTelegramImport({
      DB: db as unknown as D1Database,
      R2: { put: async () => undefined, delete: async () => undefined } as unknown as R2Bucket,
    }, {
      schemaVersion: 1,
      kind: 'telegram_file_id_import',
      importId: created.importId,
      processingToken,
    })

    expect(result).toBe('completed')
    expect(db.records[created.importId].status).toBe('draft_created')
    expect(db.records[created.importId].target_id).toBe('tc_existing')
    expect(db.executedSql.filter(sql => sql.includes('INSERT INTO cases'))).toHaveLength(0)
    expect(db.executedSql.filter(sql => sql.includes('INSERT INTO case_images'))).toHaveLength(0)
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
    const body = VALID_JPEG_BYTES
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
    const body = VALID_JPEG_BYTES
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
    expect(String(db.records[created.importId].error_json)).toContain('IMPORT_R2_CLEANUP_FAILED')
    expect(String(db.records[created.importId].error_json)).not.toContain('R2 删除失败')
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

  it('只通过条件租约认领恢复过期处理任务', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'fetching_media'
    db.records[created.importId].processing_token = 'old-processing-token'
    db.records[created.importId].processing_target_id = 'gal_stale'
    db.records[created.importId].processing_lease_expires_at = '2026-01-01T00:00:00.000Z'

    const result = await recoverStaleExternalImport({
      DB: db as unknown as D1Database,
      R2: { delete: async () => undefined } as unknown as R2Bucket,
      TELEGRAM_IMPORT_QUEUE: { send: async () => undefined } as unknown as Queue<TelegramImportQueueMessage>,
    }, created.importId, {
      id: 'iat_1',
      permissions: '["gallery:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
      actorAdminId: 42,
      auditAction: 'telegram_import.recover_stale',
    })

    expect(result.status).toBe('pending_media_fetch')
    expect(db.records[created.importId].status).toBe('pending_media_fetch')
    expect(db.executedSql.some(sql => sql.includes('processing_lease_expires_at IS NULL'))).toBe(true)
  })

  it('可恢复尚未开始消费且派发租约为空的 pending 任务', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)

    const result = await recoverStaleExternalImport({
      DB: db as unknown as D1Database,
      R2: { delete: async () => undefined } as unknown as R2Bucket,
      TELEGRAM_IMPORT_QUEUE: { send: async () => undefined } as unknown as Queue<TelegramImportQueueMessage>,
    }, created.importId, {
      id: 'iat_1',
      permissions: '["gallery:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
      actorAdminId: 42,
      auditAction: 'telegram_import.recover_stale',
    })

    expect(result.status).toBe('pending_media_fetch')
    expect(db.records[created.importId].retry_count).toBe(1)
    expect(db.executedSql.some(sql => sql.includes('processing_token IS NULL'))).toBe(true)
  })

  it('远端调用失败时若执行权已被替换，旧执行器不写 failed 或清空共享文件状态', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.records[created.importId].processing_token = 'replacement-processing-token'
      throw new Error('旧执行器网络失败')
    }))

    const result = await processTelegramFileIdImport(
      db as unknown as D1Database,
      { delete: async () => undefined } as unknown as R2Bucket,
      { TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT: '123:secret' },
      created.importId,
    )

    expect(result).toBe('superseded')
    expect(db.records[created.importId].status).toBe('fetching_media')
    expect(db.records[created.importId].processing_token).toBe('replacement-processing-token')
    expect(db.records[created.importId].error_json).toBeUndefined()
    expect(db.files[0].status).toBe('fetching')
  })
})
