import { Hono } from 'hono'
import { PAGINATION } from '@meigallery/shared/constants'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'
import {
  enqueueTelegramFileIdImport,
  parseExternalImportError,
  recoverStaleExternalImport,
  resetFailedImportForRetry,
  safeExternalImportFileMessage,
} from '../../services/telegram-file-id-import'
import { ImportError, importErrorBody } from '../../utils/import-errors'

export const adminExternalImportRecordRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminExternalImportRecordRoutes.use('*', requireAdmin)

type RetryTokenRow = {
  token_id: string
  permissions: string
  allowed_source_bot_keys: string
}

function handleRetryError(error: unknown) {
  if (error instanceof ImportError) return { body: importErrorBody(error), status: error.status }
  return { body: importErrorBody(new ImportError('IMPORT_PROCESS_FAILED', '导入重试失败', 500)), status: 500 as const }
}

adminExternalImportRecordRoutes.get('/', async (c) => {
  const page = Math.max(1, Number.parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(PAGINATION.MAX_PAGE_SIZE, Math.max(1, Number.parseInt(c.req.query('pageSize') || '20', 10)))
  const offset = (page - 1) * pageSize
  const conditions: string[] = []
  const params: unknown[] = []

  for (const [queryKey, column] of [['source', 'source'], ['targetType', 'target_type'], ['status', 'status'], ['sourceBotKey', 'source_bot_key']] as const) {
    const value = c.req.query(queryKey)
    if (value) {
      conditions.push(`${column} = ?`)
      params.push(value)
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const total = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM external_import_records ${where}`).bind(...params).first<{ total: number }>()
  const rows = await c.env.DB.prepare(`
    SELECT id, source, external_message_id, source_bot_key, target_type, target_id, status,
           file_count, fetched_count, failed_count, retry_count,
           processing_started_at, processing_heartbeat_at, processing_lease_expires_at,
           CASE
             WHEN status = 'fetching_media'
               AND (processing_lease_expires_at IS NULL OR datetime(processing_lease_expires_at) <= datetime('now'))
             THEN 1
             WHEN status = 'pending_media_fetch'
               AND (
                 processing_token IS NULL
                 OR processing_lease_expires_at IS NULL
                 OR datetime(processing_lease_expires_at) <= datetime('now')
               )
             THEN 1 ELSE 0
           END AS recovery_available,
           created_at, completed_at
    FROM external_import_records
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, pageSize, offset).all()

  return c.json({ data: rows.results, total: total?.total ?? 0, page, pageSize })
})

adminExternalImportRecordRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const record = await c.env.DB.prepare(`
    SELECT id, source, external_message_id, source_bot_key, source_chat_id, source_message_id, media_group_id,
           target_type, target_id, status, metadata_json, file_count, fetched_count, failed_count, retry_count,
           error_json, request_ip, user_agent,
           processing_started_at, processing_heartbeat_at, processing_lease_expires_at,
           CASE
             WHEN status = 'fetching_media'
               AND (processing_lease_expires_at IS NULL OR datetime(processing_lease_expires_at) <= datetime('now'))
             THEN 1
             WHEN status = 'pending_media_fetch'
               AND (
                 processing_token IS NULL
                 OR processing_lease_expires_at IS NULL
                 OR datetime(processing_lease_expires_at) <= datetime('now')
               )
             THEN 1 ELSE 0
           END AS recovery_available,
           created_at, completed_at
    FROM external_import_records
    WHERE id = ?
  `).bind(id).first<Record<string, unknown>>()
  if (!record) return c.json({ statusCode: 404, message: '外部导入记录不存在' }, 404)

  const files = await c.env.DB.prepare(`
    SELECT id, filename, telegram_file_unique_id, declared_mime_type, actual_mime_type, file_size, sort_order, is_cover, status, error_message
    FROM external_import_files
    WHERE import_id = ?
    ORDER BY sort_order ASC
  `).bind(id).all<Record<string, unknown> & { error_message?: unknown }>()
  const safeError = parseExternalImportError(
    typeof record.error_json === 'string' ? record.error_json : null,
  )
  return c.json({
    ...record,
    error_json: safeError ? JSON.stringify(safeError) : null,
    files: files.results.map(file => ({
      ...file,
      error_message: safeExternalImportFileMessage(file.error_message),
    })),
  })
})

adminExternalImportRecordRoutes.post('/:id/retry', async (c) => {
  try {
    const id = c.req.param('id')
    const token = await c.env.DB.prepare(`
      SELECT eir.token_id, iat.permissions, iat.allowed_source_bot_keys
      FROM external_import_records eir
      JOIN import_api_tokens iat ON eir.token_id = iat.id
      WHERE eir.id = ?
    `).bind(id).first<RetryTokenRow>()
    if (!token) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)

    const result = await resetFailedImportForRetry(c.env, id, {
      id: token.token_id,
      permissions: token.permissions,
      allowedSourceBotKeys: token.allowed_source_bot_keys,
      actorAdminId: c.get('userId')!,
      auditAction: 'telegram_import.admin_retry',
    })
    await enqueueTelegramFileIdImport(c.env, result.importId)
    return c.json(result, 202)
  } catch (error) {
    const result = handleRetryError(error)
    return c.json(result.body, result.status)
  }
})

adminExternalImportRecordRoutes.post('/:id/recover-stale', async (c) => {
  try {
    const id = c.req.param('id')
    const token = await c.env.DB.prepare(`
      SELECT eir.token_id, iat.permissions, iat.allowed_source_bot_keys
      FROM external_import_records eir
      JOIN import_api_tokens iat ON eir.token_id = iat.id
      WHERE eir.id = ?
    `).bind(id).first<RetryTokenRow>()
    if (!token) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)

    const result = await recoverStaleExternalImport(
      c.env,
      id,
      {
        id: token.token_id,
        permissions: token.permissions,
        allowedSourceBotKeys: token.allowed_source_bot_keys,
        actorAdminId: c.get('userId')!,
        auditAction: 'telegram_import.admin_recover_stale',
      },
    )
    await enqueueTelegramFileIdImport(c.env, result.importId)
    return c.json(result, 202)
  } catch (error) {
    const result = handleRetryError(error)
    return c.json(result.body, result.status)
  }
})
