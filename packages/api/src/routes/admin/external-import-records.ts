import { Hono } from 'hono'
import { PAGINATION } from '@meigallery/shared/constants'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'

export const adminExternalImportRecordRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminExternalImportRecordRoutes.use('*', requireAdmin)

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
    SELECT id, source, external_message_id, source_bot_key, target_type, target_id, status, file_count, fetched_count, failed_count, retry_count, created_at, completed_at
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
           error_json, request_ip, user_agent, created_at, completed_at
    FROM external_import_records
    WHERE id = ?
  `).bind(id).first<Record<string, unknown>>()
  if (!record) return c.json({ statusCode: 404, message: '外部导入记录不存在' }, 404)

  const files = await c.env.DB.prepare(`
    SELECT id, filename, telegram_file_unique_id, declared_mime_type, actual_mime_type, file_size, sort_order, is_cover, status, error_message
    FROM external_import_files
    WHERE import_id = ?
    ORDER BY sort_order ASC
  `).bind(id).all()
  return c.json({ ...record, files: files.results })
})
