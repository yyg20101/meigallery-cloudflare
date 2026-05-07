import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramImportPayload } from '../utils/import-validation'
import { createExternalImportRecord, getExternalImportStatus, processTelegramFileIdImport, resetFailedImportForRetry } from './telegram-file-id-import'

type RecordRow = Record<string, unknown>

function createDb() {
  const records: Record<string, RecordRow> = {}
  const files: RecordRow[] = []
  return {
    records,
    files,
    prepare(sql: string) {
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
              token_created_by: 1,
              created_at: '2026-05-06T00:00:00.000Z',
              completed_at: null,
            }
          }
          if (sql.includes('INSERT INTO external_import_files')) files.push({ id: params[0], import_id: params[1], telegram_file_id: params[2], filename: params[4], status: 'pending', sort_order: params[6], r2_key: null, target_file_id: null, error_message: null })
          if (sql.includes("SET status = 'fetching_media'")) records[String(params[0])].status = 'fetching_media'
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
          if (sql.includes("SET status = 'failed', error_message")) {
            const file = files.find(row => row.id === params[1])
            if (file) {
              file.status = 'failed'
              file.error_message = params[0]
            }
          }
          if (sql.includes("SET status = 'failed'") && !sql.includes('UPDATE external_import_files')) {
            const record = records[String(params[3] ?? params[1])]
            record.status = 'failed'
            record.error_json = params.length >= 4 ? params[2] : params[0]
            if (params.length >= 4) {
              record.fetched_count = files.filter(row => row.import_id === record.id && row.status === 'completed').length
              record.failed_count = files.filter(row => row.import_id === record.id && row.status === 'failed').length
            } else {
              record.failed_count = record.file_count
            }
          }
          if (sql.includes("SET status = 'pending_media_fetch'")) records[String(params[0])].status = 'pending_media_fetch'
          return { success: true }
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
})

describe('telegram file_id import service', () => {
  it('creates an external import record before async media fetch', async () => {
    const db = createDb()
    const result = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, '127.0.0.1', 'vitest')

    expect(result.status).toBe('pending_media_fetch')
    expect(result.receivedFileCount).toBe(1)
    expect(db.files).toHaveLength(1)
  })

  it('returns existing import as duplicate without creating a second record', async () => {
    const db = createDb()
    const first = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    const second = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)

    expect(second.status).toBe('duplicate')
    expect(second.importId).toBe(first.importId)
    expect(Object.keys(db.records)).toHaveLength(1)
  })

  it('returns status for the same token only', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    const status = await getExternalImportStatus(db as unknown as D1Database, created.importId, 'iat_1')

    expect(status.importId).toBe(created.importId)
    expect(status.files).toHaveLength(1)
  })

  it('returns async failure code and message in status response', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'
    db.records[created.importId].error_json = JSON.stringify({ code: 'TELEGRAM_BOT_TOKEN_MISSING', message: '未配置 Telegram Bot Token' })

    const status = await getExternalImportStatus(db as unknown as D1Database, created.importId, 'iat_1')

    expect(status.error).toEqual({ code: 'TELEGRAM_BOT_TOKEN_MISSING', message: '未配置 Telegram Bot Token' })
  })

  it('marks the current file as failed when media fetch fails', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)

    await processTelegramFileIdImport(db as unknown as D1Database, { delete: async () => undefined } as unknown as R2Bucket, {}, created.importId)

    expect(db.records[created.importId].status).toBe('failed')
    expect(db.files[0].status).toBe('failed')
    expect(db.files[0].error_message).toBe('未配置 Telegram Bot Token')
  })

  it('keeps fetched and failed counts aligned with file statuses', async () => {
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

  it('resets failed imports for retry', async () => {
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

  it('rechecks token permissions before retrying failed imports', async () => {
    const db = createDb()
    const created = await createExternalImportRecord(db as unknown as D1Database, 'iat_1', payload, null, null)
    db.records[created.importId].status = 'failed'

    await expect(resetFailedImportForRetry(db as unknown as D1Database, created.importId, {
      id: 'iat_1',
      permissions: '["testimonial:create"]',
      allowedSourceBotKeys: '["ops_gallery_bot"]',
    })).rejects.toMatchObject({ code: 'IMPORT_PERMISSION_DENIED' })
  })

  it('rechecks sourceBotKey allowlist before retrying failed imports', async () => {
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
