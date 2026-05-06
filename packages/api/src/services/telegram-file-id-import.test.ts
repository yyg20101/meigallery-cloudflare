import { describe, expect, it } from 'vitest'
import type { TelegramImportPayload } from '../utils/import-validation'
import { createExternalImportRecord, getExternalImportStatus, resetFailedImportForRetry } from './telegram-file-id-import'

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
              created_at: '2026-05-06T00:00:00.000Z',
              completed_at: null,
            }
          }
          if (sql.includes('INSERT INTO external_import_files')) files.push({ id: params[0], import_id: params[1], filename: params[4], status: 'pending', sort_order: params[6], r2_key: null, target_file_id: null })
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
