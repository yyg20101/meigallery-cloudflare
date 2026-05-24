import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'
import { createExternalImportRecord, getExternalImportStatus, processTelegramFileIdImport, resetFailedImportForRetry } from '../services/telegram-file-id-import'
import { ImportError, importErrorBody } from '../utils/import-errors'
import { hashImportToken, hasImportPermission, isImportTokenExpired, isSourceBotAllowed } from '../utils/import-token'
import { importPermissionForType, validateTelegramImportPayload } from '../utils/import-validation'
import { writeAuditLog } from '../utils/permission'

export const importRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type ImportTokenRow = {
  id: string
  created_by: number
  permissions: string
  allowed_source_bot_keys: string
  status: 'active' | 'disabled'
  expires_at: string | null
  last_used_at: string | null
}

const IMPORT_TOKEN_TOUCH_INTERVAL_MS = 10 * 60 * 1000

async function requireImportToken(c: { req: { header: (name: string) => string | undefined }; env: Bindings }) {
  const authorization = c.req.header('Authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/)
  if (!match) throw new ImportError('IMPORT_TOKEN_MISSING', '缺少 Import Token', 401)
  const rawToken = match[1]
  if (!rawToken) throw new ImportError('IMPORT_TOKEN_MISSING', '缺少 Import Token', 401)

  const tokenHash = await hashImportToken(rawToken)
  const row = await c.env.DB.prepare('SELECT id, created_by, permissions, allowed_source_bot_keys, status, expires_at, last_used_at FROM import_api_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<ImportTokenRow>()
  if (!row) throw new ImportError('IMPORT_TOKEN_INVALID', 'Import Token 无效', 401)
  if (row.status !== 'active') throw new ImportError('IMPORT_TOKEN_DISABLED', 'Import Token 已禁用', 403)
  if (isImportTokenExpired(row.expires_at)) throw new ImportError('IMPORT_TOKEN_EXPIRED', 'Import Token 已过期', 403)

  const lastUsedAt = row.last_used_at ? new Date(row.last_used_at).getTime() : 0
  if (!lastUsedAt || Number.isNaN(lastUsedAt) || Date.now() - lastUsedAt >= IMPORT_TOKEN_TOUCH_INTERVAL_MS) {
    await c.env.DB.prepare("UPDATE import_api_tokens SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(row.id).run()
  }
  return row
}

function isJsonRequest(c: { req: { header: (name: string) => string | undefined } }) {
  return (c.req.header('Content-Type') || '').toLowerCase().split(';')[0]?.trim() === 'application/json'
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

function getImportTokenDailyLimit(value: string | undefined) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100
}

importRoutes.post('/telegram-file-id', async (c) => {
  try {
    const token = await requireImportToken(c)
    if (!isJsonRequest(c)) throw new ImportError('IMPORT_VALIDATION_FAILED', 'Content-Type 必须为 application/json', 415)
    const payload = validateTelegramImportPayload(await c.req.json())
    const permission = importPermissionForType(payload.metadata.type)
    if (!hasImportPermission(token.permissions, permission)) throw new ImportError('IMPORT_PERMISSION_DENIED', 'Import Token 权限不足', 403)
    if (!isSourceBotAllowed(token.allowed_source_bot_keys, payload.telegram.sourceBotKey)) throw new ImportError('IMPORT_SOURCE_BOT_NOT_ALLOWED', 'sourceBotKey 不在允许列表中', 403)

    const result = await createExternalImportRecord(c.env.DB, token.id, payload, clientIp(c), c.req.header('User-Agent') || null, {
      dailyLimit: getImportTokenDailyLimit(c.env.IMPORT_TOKEN_DAILY_LIMIT),
    })
    await writeAuditLog(c.env.DB, {
      adminId: token.created_by,
      action: 'telegram_import.accepted',
      targetType: 'external_import_record',
      targetId: result.importId,
      afterValue: { importId: result.importId, targetType: result.type, status: result.status, receivedFileCount: result.receivedFileCount ?? null },
    })
    if (result.status !== 'duplicate' || result.currentStatus === 'pending_media_fetch') {
      scheduleImport(c, processTelegramFileIdImport(c.env.DB, c.env.R2, c.env as unknown as Record<string, string | undefined>, result.importId))
    }
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
    const result = await resetFailedImportForRetry(c.env.DB, c.req.param('importId'), {
      id: token.id,
      permissions: token.permissions,
      allowedSourceBotKeys: token.allowed_source_bot_keys,
    })
    await writeAuditLog(c.env.DB, {
      adminId: token.created_by,
      action: 'telegram_import.retry',
      targetType: 'external_import_record',
      targetId: result.importId,
      afterValue: { importId: result.importId, targetType: result.type, status: result.status, retryCount: result.retryCount },
    })
    scheduleImport(c, processTelegramFileIdImport(c.env.DB, c.env.R2, c.env as unknown as Record<string, string | undefined>, result.importId))
    return c.json(result, 202)
  } catch (error) {
    const result = handleImportError(error, '导入重试失败')
    return c.json(result.body, result.status)
  }
})
