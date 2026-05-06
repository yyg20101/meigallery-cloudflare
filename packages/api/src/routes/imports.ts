import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { createExternalImportRecord, getExternalImportStatus, processTelegramFileIdImport, resetFailedImportForRetry } from '../services/telegram-file-id-import'
import { ImportError, importErrorBody } from '../utils/import-errors'
import { hashImportToken, hasImportPermission, isImportTokenExpired, isSourceBotAllowed } from '../utils/import-token'
import { importPermissionForType, validateTelegramImportPayload } from '../utils/import-validation'

export const importRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type ImportTokenRow = {
  id: string
  permissions: string
  allowed_source_bot_keys: string
  status: 'active' | 'disabled'
  expires_at: string | null
}

async function requireImportToken(c: { req: { header: (name: string) => string | undefined }; env: Bindings }) {
  const authorization = c.req.header('Authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/)
  if (!match) throw new ImportError('IMPORT_TOKEN_MISSING', '缺少 Import Token', 401)
  const rawToken = match[1]
  if (!rawToken) throw new ImportError('IMPORT_TOKEN_MISSING', '缺少 Import Token', 401)

  const tokenHash = await hashImportToken(rawToken)
  const row = await c.env.DB.prepare('SELECT id, permissions, allowed_source_bot_keys, status, expires_at FROM import_api_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<ImportTokenRow>()
  if (!row) throw new ImportError('IMPORT_TOKEN_INVALID', 'Import Token 无效', 401)
  if (row.status !== 'active') throw new ImportError('IMPORT_TOKEN_DISABLED', 'Import Token 已禁用', 403)
  if (isImportTokenExpired(row.expires_at)) throw new ImportError('IMPORT_TOKEN_EXPIRED', 'Import Token 已过期', 403)

  await c.env.DB.prepare("UPDATE import_api_tokens SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(row.id).run()
  return row
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }) {
  return c.req.header('CF-Connecting-IP') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null
}

function handleImportError(error: unknown, fallbackMessage: string) {
  if (error instanceof ImportError) return { body: importErrorBody(error), status: error.status }
  return { body: importErrorBody(new ImportError('IMPORT_PROCESS_FAILED', fallbackMessage, 500)), status: 500 as const }
}

function scheduleImport(c: { executionCtx: ExecutionContext }, task: Promise<void>) {
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    task.catch(error => console.error('Telegram 导入异步处理失败:', error))
  }
}

importRoutes.post('/telegram-file-id', async (c) => {
  try {
    const token = await requireImportToken(c)
    const payload = validateTelegramImportPayload(await c.req.json())
    const permission = importPermissionForType(payload.metadata.type)
    if (!hasImportPermission(token.permissions, permission)) throw new ImportError('IMPORT_PERMISSION_DENIED', 'Import Token 权限不足', 403)
    if (!isSourceBotAllowed(token.allowed_source_bot_keys, payload.telegram.sourceBotKey)) throw new ImportError('IMPORT_SOURCE_BOT_NOT_ALLOWED', 'sourceBotKey 不在允许列表中', 403)

    const result = await createExternalImportRecord(c.env.DB, token.id, payload, clientIp(c), c.req.header('User-Agent') || null)
    if (result.status !== 'duplicate') scheduleImport(c, processTelegramFileIdImport(c.env.DB, c.env.R2, c.env as unknown as Record<string, string | undefined>, result.importId))
    return c.json(result, result.status === 'duplicate' ? 200 : 202)
  } catch (error) {
    const result = handleImportError(error, '导入请求处理失败')
    return c.json(result.body, result.status)
  }
})

importRoutes.get('/:importId', async (c) => {
  try {
    const token = await requireImportToken(c)
    return c.json(await getExternalImportStatus(c.env.DB, c.req.param('importId'), token.id))
  } catch (error) {
    const result = handleImportError(error, '导入状态查询失败')
    return c.json(result.body, result.status)
  }
})

importRoutes.post('/:importId/retry', async (c) => {
  try {
    const token = await requireImportToken(c)
    const result = await resetFailedImportForRetry(c.env.DB, c.req.param('importId'), token.id)
    scheduleImport(c, processTelegramFileIdImport(c.env.DB, c.env.R2, c.env as unknown as Record<string, string | undefined>, result.importId))
    return c.json(result, 202)
  } catch (error) {
    const result = handleImportError(error, '导入重试失败')
    return c.json(result.body, result.status)
  }
})
