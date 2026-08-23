import { generateId } from '../utils/db'
import { ImportError } from '../utils/import-errors'
import { hasImportPermission, isSourceBotAllowed } from '../utils/import-token'
import type { TelegramImportPayload } from '../utils/import-validation'
import { importPermissionForType } from '../utils/import-validation'
import { fetchTelegramImageFile, getExtensionForMime } from './telegram-file-fetcher'

export type ExternalImportStatus = 'pending_media_fetch' | 'fetching_media' | 'draft_created' | 'partial_failed' | 'failed'

const TELEGRAM_IMPORT_QUEUE_KIND = 'telegram_file_id_import'
export const TELEGRAM_IMPORT_QUEUE_NAME = 'meigallery-import-telegram'
const EXTERNAL_IMPORT_LEASE_MS = 30 * 60 * 1000

export interface TelegramImportQueueMessage {
  schemaVersion: 1
  kind: typeof TELEGRAM_IMPORT_QUEUE_KIND
  importId: string
  processingToken: string
}

export interface TelegramImportEnvironment {
  DB: D1Database
  R2: R2Bucket
  TELEGRAM_IMPORT_QUEUE?: Queue<TelegramImportQueueMessage>
}

type TargetType = TelegramImportPayload['metadata']['type']
type FetchedImportFile = {
  fileId: string
  r2Key: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileSize: number
  sortOrder: number
  isCover: boolean
}

type CleanupResult = {
  dbCleaned: boolean
  r2Cleaned: boolean
  cleanupRequired: boolean
  warningCodes: string[]
}

type ProcessingRecord = {
  id: string
  source_bot_key: string
  target_type: TargetType
  metadata_json: string
  file_count: number
  token_created_by: number
  status: ExternalImportStatus
  processing_token: string | null
  processing_target_id: string | null
  processing_lease_expires_at: string | null
}

export type CreateImportResult = {
  importId: string
  type: TargetType
  status: ExternalImportStatus | 'duplicate'
  currentStatus?: ExternalImportStatus
  targetId?: string | null
  receivedFileCount?: number
  message?: string
}

export type RetryImportToken = {
  id: string
  permissions: string
  allowedSourceBotKeys: string
  actorAdminId: number
  auditAction: string
}

type QueueMessageLike = {
  body: unknown
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

export async function createExternalImportRecord(
  db: D1Database,
  tokenId: string,
  payload: TelegramImportPayload,
  requestIp: string | null,
  userAgent: string | null,
  options: { dailyLimit?: number; actorAdminId?: number } = {},
): Promise<CreateImportResult> {
  const existing = await findExistingImport(db, tokenId, payload.metadata.externalMessageId)

  if (existing) {
    return duplicateImportResult(existing)
  }

  const dailyLimit = Number.isSafeInteger(options.dailyLimit) && Number(options.dailyLimit) > 0
    ? Number(options.dailyLimit)
    : 100
  const usage = await db.prepare(`
    SELECT COUNT(*) as count
    FROM external_import_records
    WHERE token_id = ? AND created_at >= datetime('now', 'start of day')
  `).bind(tokenId).first<{ count: number }>()
  if ((usage?.count ?? 0) >= dailyLimit) {
    throw new ImportError('IMPORT_DAILY_LIMIT_EXCEEDED', `Import Token 今日导入次数已达上限（${dailyLimit} 次）`, 429)
  }

  const importId = generateId('eir')
  const statements = [db.prepare(`
    INSERT INTO external_import_records
      (id, source, external_message_id, token_id, source_bot_key, source_chat_id, source_message_id, media_group_id, target_type, metadata_json, file_count, request_ip, user_agent)
    SELECT ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (
      SELECT COUNT(*)
      FROM external_import_records
      WHERE token_id = ? AND created_at >= datetime('now', 'start of day')
    ) < ?
  `).bind(
    importId,
    payload.metadata.externalMessageId,
    tokenId,
    payload.telegram.sourceBotKey,
    payload.telegram.sourceChatId,
    payload.telegram.sourceMessageId,
    payload.telegram.mediaGroupId ?? null,
    payload.metadata.type,
    JSON.stringify(payload.metadata),
    payload.files.length,
    requestIp,
    userAgent,
    tokenId,
    dailyLimit,
  )]

  for (const file of payload.files) {
    statements.push(db.prepare(`
      INSERT INTO external_import_files
        (id, import_id, telegram_file_id, telegram_file_unique_id, filename, declared_mime_type, sort_order, is_cover)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM external_import_records
        WHERE id = ? AND token_id = ? AND external_message_id = ?
      )
    `).bind(
      generateId('eif'),
      importId,
      file.fileId,
      file.fileUniqueId ?? null,
      file.filename ?? null,
      file.mimeType,
      file.sortOrder,
      file.isCover ? 1 : 0,
      importId,
      tokenId,
      payload.metadata.externalMessageId,
    ))
  }
  if (options.actorAdminId !== undefined) {
    statements.push(db.prepare(`
      INSERT INTO admin_audit_logs
        (id, admin_id, action, target_type, target_id, before_value, after_value)
      SELECT ?, ?, 'telegram_import.accepted', 'external_import_record', ?, NULL, ?
      WHERE EXISTS (
        SELECT 1 FROM external_import_records
        WHERE id = ? AND token_id = ? AND external_message_id = ?
      )
    `).bind(
      generateId('log'),
      options.actorAdminId,
      importId,
      JSON.stringify({
        importId,
        targetType: payload.metadata.type,
        status: 'pending_media_fetch',
        receivedFileCount: payload.files.length,
      }),
      importId,
      tokenId,
      payload.metadata.externalMessageId,
    ))
  }

  try {
    const [accepted] = await db.batch(statements)
    if (!changed(accepted)) {
      const duplicate = await findExistingImport(db, tokenId, payload.metadata.externalMessageId)
      if (duplicate) return duplicateImportResult(duplicate)
      throw new ImportError('IMPORT_DAILY_LIMIT_EXCEEDED', `Import Token 今日导入次数已达上限（${dailyLimit} 次）`, 429)
    }
  } catch (error) {
    const duplicate = await findExistingImport(db, tokenId, payload.metadata.externalMessageId)
    if (duplicate) return duplicateImportResult(duplicate)
    throw error
  }

  return { importId, type: payload.metadata.type, status: 'pending_media_fetch', receivedFileCount: payload.files.length }
}

async function findExistingImport(db: D1Database, tokenId: string, externalMessageId: string) {
  return db.prepare(`
    SELECT id, target_type, target_id, status
    FROM external_import_records
    WHERE token_id = ? AND source = 'telegram' AND external_message_id = ?
  `).bind(tokenId, externalMessageId).first<{
    id: string
    target_type: TargetType
    target_id: string | null
    status: ExternalImportStatus
  }>()
}

function duplicateImportResult(existing: {
  id: string
  target_type: TargetType
  target_id: string | null
  status: ExternalImportStatus
}): CreateImportResult {
  return {
    importId: existing.id,
    type: existing.target_type,
    targetId: existing.target_id,
    status: 'duplicate',
    currentStatus: existing.status,
    message: '该 Telegram 消息已导入',
  }
}

export async function getExternalImportStatus(db: D1Database, importId: string, tokenId: string) {
  const record = await db.prepare(`
    SELECT id, target_type, status, target_id, file_count, fetched_count, failed_count, retry_count,
           error_json, processing_started_at, processing_heartbeat_at, processing_lease_expires_at,
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
    WHERE id = ? AND token_id = ?
  `).bind(importId, tokenId).first<{
    id: string
    target_type: string
    status: string
    target_id: string | null
    file_count: number
    fetched_count: number
    failed_count: number
    retry_count: number
    error_json: string | null
    processing_started_at: string | null
    processing_heartbeat_at: string | null
    processing_lease_expires_at: string | null
    recovery_available: number
    created_at: string
    completed_at: string | null
  }>()
  if (!record) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)

  const files = await db.prepare(`
    SELECT filename, status, sort_order, error_message
    FROM external_import_files
    WHERE import_id = ?
    ORDER BY sort_order ASC
  `).bind(importId).all<{ filename: string | null; status: string; sort_order: number; error_message: string | null }>()

  const error = parseExternalImportError(record.error_json)
  return {
    importId: record.id,
    type: record.target_type,
    status: record.status,
    targetId: record.target_id,
    fileCount: record.file_count,
    fetchedCount: record.fetched_count,
    failedCount: record.failed_count,
    retryCount: record.retry_count,
    processingStartedAt: record.processing_started_at,
    processingHeartbeatAt: record.processing_heartbeat_at,
    processingLeaseExpiresAt: record.processing_lease_expires_at,
    recoveryAvailable: Boolean(record.recovery_available),
    ...(error ? { error, message: error.message } : {}),
    files: files.results.map(file => ({
      filename: file.filename,
      status: file.status,
      sortOrder: file.sort_order,
      errorMessage: safeExternalImportFileMessage(file.error_message),
    })),
    createdAt: record.created_at,
    completedAt: record.completed_at,
  }
}

export async function resetFailedImportForRetry(env: TelegramImportEnvironment, importId: string, token: RetryImportToken) {
  requireTelegramImportQueue(env)
  const record = await env.DB.prepare(`
    SELECT id, target_type, target_id, processing_target_id, status, retry_count, source_bot_key
    FROM external_import_records
    WHERE id = ? AND token_id = ?
  `)
    .bind(importId, token.id)
    .first<{
      id: string
      target_type: TargetType
      target_id: string | null
      processing_target_id: string | null
      status: string
      retry_count: number
      source_bot_key: string
    }>()
  if (!record) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)
  const permission = importPermissionForType(record.target_type)
  if (!hasImportPermission(token.permissions, permission)) throw new ImportError('IMPORT_PERMISSION_DENIED', 'Import Token 权限不足', 403)
  if (!isSourceBotAllowed(token.allowedSourceBotKeys, record.source_bot_key)) throw new ImportError('IMPORT_SOURCE_BOT_NOT_ALLOWED', 'sourceBotKey 不在允许列表中', 403)
  if (record.status !== 'failed') throw new ImportError('IMPORT_RETRY_NOT_ALLOWED', '当前导入状态不允许重试', 409)

  const retryClaimToken = crypto.randomUUID()
  const retryLeaseExpiresAt = new Date(Date.now() + EXTERNAL_IMPORT_LEASE_MS).toISOString()
  const claim = await env.DB.prepare(`
    UPDATE external_import_records
    SET processing_token = ?, processing_heartbeat_at = datetime('now'), processing_lease_expires_at = ?
    WHERE id = ? AND status = 'failed'
      AND (
        processing_token IS NULL
        OR processing_lease_expires_at IS NULL
        OR datetime(processing_lease_expires_at) <= datetime('now')
      )
  `).bind(retryClaimToken, retryLeaseExpiresAt, importId).run()
  if (!changed(claim)) {
    throw new ImportError('IMPORT_RETRY_CONFLICT', '导入重试状态已变化，请刷新后重试', 409)
  }

  const cleanup = await cleanupFailedImport(
    env.DB,
    env.R2,
    importId,
    [],
    record.target_type,
    record.processing_target_id ?? record.target_id,
    true,
  )
  if (cleanup.cleanupRequired) {
    await env.DB.batch([
      externalImportAuditStatement(env.DB, {
        adminId: token.actorAdminId,
        action: 'telegram_import.retry_cleanup_failed',
        importId,
        processingToken: retryClaimToken,
        status: 'failed',
        afterValue: { importId, warningCodes: cleanup.warningCodes },
      }),
      env.DB.prepare(`
        UPDATE external_import_records
        SET processing_token = NULL, processing_heartbeat_at = NULL,
            processing_lease_expires_at = NULL,
            error_json = ?, completed_at = datetime('now')
        WHERE id = ? AND status = 'failed' AND processing_token = ?
      `).bind(JSON.stringify({
        code: 'IMPORT_RETRY_CLEANUP_REQUIRED',
        message: '失败导入仍有待清理资源，暂不能重试',
        cleanupRequired: true,
        warningCodes: cleanup.warningCodes,
      }), importId, retryClaimToken),
    ])
    throw new ImportError('IMPORT_RETRY_CLEANUP_REQUIRED', '失败导入仍有待清理资源，暂不能重试', 409)
  }

  const [, , reset] = await env.DB.batch([
    externalImportAuditStatement(env.DB, {
      adminId: token.actorAdminId,
      action: token.auditAction,
      importId,
      processingToken: retryClaimToken,
      status: 'failed',
      afterValue: {
        importId,
        targetType: record.target_type,
        status: 'pending_media_fetch',
        retryCount: record.retry_count + 1,
      },
    }),
    env.DB.prepare(`
      UPDATE external_import_files
      SET status = 'pending', error_message = NULL, r2_key = NULL, target_file_id = NULL,
          actual_mime_type = NULL, file_size = NULL, updated_at = datetime('now')
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM external_import_records
          WHERE id = ? AND status = 'failed' AND processing_token = ?
        )
    `).bind(importId, importId, retryClaimToken),
    env.DB.prepare(`
      UPDATE external_import_records
      SET status = 'pending_media_fetch', fetched_count = 0, failed_count = 0, retry_count = retry_count + 1,
          last_retry_at = datetime('now'), error_json = NULL, completed_at = NULL,
          target_id = NULL, processing_token = NULL, processing_target_id = NULL,
          processing_started_at = NULL, processing_heartbeat_at = NULL,
          processing_lease_expires_at = NULL
      WHERE id = ? AND status = 'failed' AND processing_token = ?
    `).bind(importId, retryClaimToken),
  ])
  if (!changed(reset)) {
    throw new ImportError('IMPORT_RETRY_CONFLICT', '导入重试状态已变化，请刷新后重试', 409)
  }

  return { importId, type: record.target_type, status: 'pending_media_fetch' as const, retryCount: record.retry_count + 1, message: '导入重试已开始' }
}

export async function recoverStaleExternalImport(
  env: TelegramImportEnvironment,
  importId: string,
  token: RetryImportToken,
) {
  requireTelegramImportQueue(env)
  const record = await env.DB.prepare(`
    SELECT id, target_type, target_id, processing_target_id, status, retry_count, source_bot_key
    FROM external_import_records
    WHERE id = ? AND token_id = ?
  `).bind(importId, token.id).first<{
    id: string
    target_type: TargetType
    target_id: string | null
    processing_target_id: string | null
    status: ExternalImportStatus
    retry_count: number
    source_bot_key: string
  }>()
  if (!record) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)
  const permission = importPermissionForType(record.target_type)
  if (!hasImportPermission(token.permissions, permission)) throw new ImportError('IMPORT_PERMISSION_DENIED', 'Import Token 权限不足', 403)
  if (!isSourceBotAllowed(token.allowedSourceBotKeys, record.source_bot_key)) throw new ImportError('IMPORT_SOURCE_BOT_NOT_ALLOWED', 'sourceBotKey 不在允许列表中', 403)
  if (record.status !== 'pending_media_fetch' && record.status !== 'fetching_media') {
    throw new ImportError('IMPORT_RECOVERY_NOT_ALLOWED', '当前导入状态不允许恢复', 409)
  }

  const recoveryToken = crypto.randomUUID()
  const recoveryLeaseExpiresAt = new Date(Date.now() + EXTERNAL_IMPORT_LEASE_MS).toISOString()
  const claim = record.status === 'pending_media_fetch'
    ? await env.DB.prepare(`
        UPDATE external_import_records
        SET processing_token = ?, processing_heartbeat_at = datetime('now'), processing_lease_expires_at = ?
        WHERE id = ? AND status = 'pending_media_fetch'
          AND (
            processing_token IS NULL
            OR processing_lease_expires_at IS NULL
            OR datetime(processing_lease_expires_at) <= datetime('now')
          )
      `).bind(recoveryToken, recoveryLeaseExpiresAt, importId).run()
    : await env.DB.prepare(`
        UPDATE external_import_records
        SET processing_token = ?, processing_heartbeat_at = datetime('now'), processing_lease_expires_at = ?
        WHERE id = ? AND status = 'fetching_media'
          AND (processing_lease_expires_at IS NULL OR datetime(processing_lease_expires_at) <= datetime('now'))
      `).bind(recoveryToken, recoveryLeaseExpiresAt, importId).run()
  if (!changed(claim)) {
    throw new ImportError('IMPORT_RECOVERY_NOT_AVAILABLE', '处理租约仍有效或状态已变化，请刷新后重试', 409)
  }

  const cleanup = await cleanupFailedImport(
    env.DB,
    env.R2,
    importId,
    [],
    record.target_type,
    record.processing_target_id ?? record.target_id,
    true,
  )
  if (cleanup.cleanupRequired) {
    await env.DB.batch([
      externalImportAuditStatement(env.DB, {
        adminId: token.actorAdminId,
        action: 'telegram_import.recovery_cleanup_failed',
        importId,
        processingToken: recoveryToken,
        status: record.status,
        afterValue: { importId, warningCodes: cleanup.warningCodes },
      }),
      env.DB.prepare(`
        UPDATE external_import_records
        SET status = 'failed', processing_token = NULL,
            processing_heartbeat_at = NULL, processing_lease_expires_at = NULL,
            error_json = ?, completed_at = datetime('now')
        WHERE id = ? AND status = ? AND processing_token = ?
      `).bind(JSON.stringify({
        code: 'IMPORT_RECOVERY_CLEANUP_REQUIRED',
        message: '过期导入资源清理未完成，请稍后重试',
        cleanupRequired: true,
        warningCodes: cleanup.warningCodes,
      }), importId, record.status, recoveryToken),
    ])
    throw new ImportError('IMPORT_RECOVERY_CLEANUP_REQUIRED', '过期导入资源清理未完成，请稍后重试', 409)
  }

  const [, , reset] = await env.DB.batch([
    externalImportAuditStatement(env.DB, {
      adminId: token.actorAdminId,
      action: token.auditAction,
      importId,
      processingToken: recoveryToken,
      status: record.status,
      afterValue: {
        importId,
        targetType: record.target_type,
        status: 'pending_media_fetch',
        retryCount: record.retry_count + 1,
      },
    }),
    env.DB.prepare(`
      UPDATE external_import_files
      SET status = 'pending', error_message = NULL, r2_key = NULL, target_file_id = NULL,
          actual_mime_type = NULL, file_size = NULL, updated_at = datetime('now')
      WHERE import_id = ?
        AND EXISTS (
          SELECT 1 FROM external_import_records
          WHERE id = ? AND status = ? AND processing_token = ?
        )
    `).bind(importId, importId, record.status, recoveryToken),
    env.DB.prepare(`
      UPDATE external_import_records
      SET status = 'pending_media_fetch', target_id = NULL, fetched_count = 0, failed_count = 0,
          retry_count = retry_count + 1, last_retry_at = datetime('now'), error_json = NULL,
          completed_at = NULL, processing_token = NULL, processing_target_id = NULL,
          processing_started_at = NULL, processing_heartbeat_at = NULL,
          processing_lease_expires_at = NULL
      WHERE id = ? AND status = ? AND processing_token = ?
    `).bind(importId, record.status, recoveryToken),
  ])
  if (!changed(reset)) {
    throw new ImportError('IMPORT_RECOVERY_CONFLICT', '导入恢复状态已变化，请刷新后重试', 409)
  }

  return {
    importId,
    type: record.target_type,
    status: 'pending_media_fetch' as const,
    retryCount: record.retry_count + 1,
    message: '过期导入已恢复并重新排队',
  }
}

export async function enqueueTelegramFileIdImport(
  env: TelegramImportEnvironment,
  importId: string,
): Promise<'queued' | 'already_queued' | 'not_pending'> {
  const queue = requireTelegramImportQueue(env)
  const processingToken = crypto.randomUUID()
  const dispatchLeaseExpiresAt = new Date(Date.now() + EXTERNAL_IMPORT_LEASE_MS).toISOString()
  const reserve = await env.DB.prepare(`
    UPDATE external_import_records
    SET processing_token = ?, processing_heartbeat_at = datetime('now'), processing_lease_expires_at = ?
    WHERE id = ? AND status = 'pending_media_fetch'
      AND (
        processing_token IS NULL
        OR processing_lease_expires_at IS NULL
        OR datetime(processing_lease_expires_at) <= datetime('now')
      )
  `).bind(processingToken, dispatchLeaseExpiresAt, importId).run()
  if (!changed(reserve)) {
    const current = await env.DB.prepare(`
      SELECT status, processing_token
      FROM external_import_records
      WHERE id = ?
    `).bind(importId).first<{ status: ExternalImportStatus; processing_token: string | null }>()
    if (current?.status === 'pending_media_fetch' && current.processing_token) return 'already_queued'
    return 'not_pending'
  }

  try {
    await queue.send({
      schemaVersion: 1,
      kind: TELEGRAM_IMPORT_QUEUE_KIND,
      importId,
      processingToken,
    })
  } catch {
    await env.DB.prepare(`
      UPDATE external_import_records
      SET processing_token = NULL, processing_heartbeat_at = NULL, processing_lease_expires_at = NULL
      WHERE id = ? AND status = 'pending_media_fetch' AND processing_token = ?
    `).bind(importId, processingToken).run()
    throw new ImportError('IMPORT_QUEUE_SEND_FAILED', 'Telegram 导入队列暂不可用，请使用相同消息标识重试', 503)
  }
  return 'queued'
}

function requireTelegramImportQueue(env: TelegramImportEnvironment) {
  if (!env.TELEGRAM_IMPORT_QUEUE) {
    throw new ImportError('IMPORT_QUEUE_UNAVAILABLE', 'Telegram 导入队列尚未配置，请稍后重试', 503)
  }
  return env.TELEGRAM_IMPORT_QUEUE
}

export async function processTelegramFileIdImport(
  env: TelegramImportEnvironment,
  message: TelegramImportQueueMessage,
): Promise<'completed' | 'failed' | 'superseded' | 'retry_later'> {
  const record = await env.DB.prepare(`
    SELECT eir.id, eir.source_bot_key, eir.target_type, eir.metadata_json, eir.file_count,
           eir.status, eir.processing_token, eir.processing_target_id,
           eir.processing_lease_expires_at, iat.created_by AS token_created_by
    FROM external_import_records eir
    JOIN import_api_tokens iat ON eir.token_id = iat.id
    WHERE eir.id = ?
  `).bind(message.importId).first<ProcessingRecord>()
  if (!record || record.processing_token !== message.processingToken) return 'superseded'

  let targetId = record.processing_target_id
  if (record.status === 'pending_media_fetch') {
    targetId = record.target_type === 'gallery' ? generateId('gal') : generateId('tc')
    const leaseExpiresAt = new Date(Date.now() + EXTERNAL_IMPORT_LEASE_MS).toISOString()
    const claim = await env.DB.prepare(`
      UPDATE external_import_records
      SET status = 'fetching_media', processing_target_id = ?,
          processing_started_at = datetime('now'), processing_heartbeat_at = datetime('now'),
          processing_lease_expires_at = ?, completed_at = NULL
      WHERE id = ? AND status = 'pending_media_fetch' AND processing_token = ?
    `).bind(targetId, leaseExpiresAt, record.id, message.processingToken).run()
    if (!changed(claim)) return 'superseded'
  } else if (record.status === 'fetching_media' && targetId) {
    const leaseExpiresAt = new Date(Date.now() + EXTERNAL_IMPORT_LEASE_MS).toISOString()
    const reclaim = await env.DB.prepare(`
      UPDATE external_import_records
      SET processing_heartbeat_at = datetime('now'), processing_lease_expires_at = ?
      WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
        AND (processing_lease_expires_at IS NULL OR datetime(processing_lease_expires_at) <= datetime('now'))
    `).bind(leaseExpiresAt, record.id, message.processingToken).run()
    if (!changed(reclaim)) return 'retry_later'
  } else {
    return 'superseded'
  }
  if (!targetId) return 'superseded'

  const files = await env.DB.prepare(`
    SELECT id, telegram_file_id, declared_mime_type, sort_order, is_cover, status, target_file_id, r2_key,
           actual_mime_type, file_size
    FROM external_import_files
    WHERE import_id = ?
    ORDER BY sort_order ASC
  `).bind(record.id).all<{
    id: string
    telegram_file_id: string
    declared_mime_type: FetchedImportFile['mimeType']
    sort_order: number
    is_cover: number
    status: string
    target_file_id: string | null
    r2_key: string | null
    actual_mime_type: FetchedImportFile['mimeType'] | null
    file_size: number | null
  }>()

  const uploadedKeys: string[] = []
  let currentFileId: string | null = null
  try {
    let metadata: TelegramImportPayload['metadata']
    try {
      metadata = JSON.parse(record.metadata_json) as TelegramImportPayload['metadata']
    } catch {
      throw new ImportError('IMPORT_METADATA_INVALID', '导入元数据无效', 500)
    }

    for (const file of files.results) {
      if (file.status === 'completed') continue
      currentFileId = file.id
      await renewExternalImportLease(env.DB, record.id, message.processingToken)

      const targetFileId = file.target_file_id
        ?? (record.target_type === 'gallery' ? generateId('med') : generateId('tci'))
      const extension = file.r2_key?.split('.').pop()
        ?? getExtensionForMime(file.declared_mime_type)
      const r2Key = file.r2_key
        ?? (record.target_type === 'gallery'
          ? `originals/${targetId}/${targetFileId}.${extension}`
          : `cases/${targetId}/${targetFileId}.${extension}`)
      const fileClaim = await env.DB.prepare(`
        UPDATE external_import_files
        SET status = 'fetching', target_file_id = ?, r2_key = ?, error_message = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND import_id = ? AND status IN ('pending', 'fetching', 'failed')
          AND EXISTS (
            SELECT 1 FROM external_import_records
            WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
          )
      `).bind(targetFileId, r2Key, file.id, record.id, record.id, message.processingToken).run()
      if (!changed(fileClaim)) throw new ExternalImportLeaseLostError()

      const fetched = await fetchTelegramImageFile(
        env as unknown as Record<string, string | undefined>,
        record.source_bot_key,
        file.telegram_file_id,
      )
      if (fetched.mimeType !== file.declared_mime_type) {
        throw new ImportError('TELEGRAM_FILE_MIME_MISMATCH', 'Telegram 文件内容与声明类型不一致', 400)
      }
      await renewExternalImportLease(env.DB, record.id, message.processingToken)
      await env.R2.put(r2Key, fetched.bytes, { httpMetadata: { contentType: fetched.mimeType } })
      uploadedKeys.push(r2Key)
      await renewExternalImportLease(env.DB, record.id, message.processingToken)

      const completed = await env.DB.prepare(`
        UPDATE external_import_files
        SET status = 'completed', actual_mime_type = ?, file_size = ?,
            error_message = NULL, updated_at = datetime('now')
        WHERE id = ? AND import_id = ?
          AND EXISTS (
            SELECT 1 FROM external_import_records
            WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
          )
      `).bind(fetched.mimeType, fetched.fileSize, file.id, record.id, record.id, message.processingToken).run()
      if (!changed(completed)) throw new ExternalImportLeaseLostError()
      await env.DB.prepare(`
        UPDATE external_import_records
        SET fetched_count = (
          SELECT COUNT(*) FROM external_import_files WHERE import_id = ? AND status = 'completed'
        )
        WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
      `).bind(record.id, record.id, message.processingToken).run()
      currentFileId = null
    }

    await renewExternalImportLease(env.DB, record.id, message.processingToken)
    const completedFiles = await env.DB.prepare(`
      SELECT target_file_id, r2_key, actual_mime_type, file_size, sort_order, is_cover
      FROM external_import_files
      WHERE import_id = ? AND status = 'completed'
      ORDER BY sort_order ASC
    `).bind(record.id).all<{
      target_file_id: string | null
      r2_key: string | null
      actual_mime_type: FetchedImportFile['mimeType'] | null
      file_size: number | null
      sort_order: number
      is_cover: number
    }>()
    const fetchedFiles = completedFiles.results.flatMap((file): FetchedImportFile[] => {
      if (!file.target_file_id || !file.r2_key || !file.actual_mime_type || file.file_size === null) return []
      return [{
        fileId: file.target_file_id,
        r2Key: file.r2_key,
        mimeType: file.actual_mime_type,
        fileSize: file.file_size,
        sortOrder: file.sort_order,
        isCover: Boolean(file.is_cover),
      }]
    })
    if (fetchedFiles.length !== record.file_count) {
      throw new ImportError('IMPORT_FILE_STATE_INCOMPLETE', '导入文件状态不完整，请稍后重试', 503)
    }

    if (record.target_type === 'gallery') {
      await createImportedGallery(env.DB, targetId, metadata, fetchedFiles, record.token_created_by)
    } else {
      await createImportedCase(env.DB, targetId, metadata, fetchedFiles, record.token_created_by)
    }
    await renewExternalImportLease(env.DB, record.id, message.processingToken)

    const [, finalized] = await env.DB.batch([
      externalImportAuditStatement(env.DB, {
        adminId: record.token_created_by,
        action: record.target_type === 'gallery'
          ? 'telegram_import.create_gallery'
          : 'telegram_import.create_case',
        importId: record.id,
        processingToken: message.processingToken,
        afterValue: {
          importId: record.id,
          targetType: record.target_type,
          targetId,
          fetchedCount: fetchedFiles.length,
        },
      }),
      env.DB.prepare(`
        UPDATE external_import_records
        SET status = 'draft_created', target_id = ?, fetched_count = ?, failed_count = 0,
            error_json = NULL, completed_at = datetime('now'), processing_token = NULL,
            processing_target_id = NULL, processing_started_at = NULL,
            processing_heartbeat_at = NULL, processing_lease_expires_at = NULL
        WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
      `).bind(targetId, fetchedFiles.length, record.id, message.processingToken),
    ])
    if (!changed(finalized)) {
      await cleanupFailedImport(env.DB, env.R2, record.id, uploadedKeys, record.target_type, targetId, false)
      return 'superseded'
    }
    return 'completed'
  } catch (error) {
    if (error instanceof ExternalImportLeaseLostError) {
      await cleanupFailedImport(env.DB, env.R2, record.id, uploadedKeys, record.target_type, targetId, false)
      return 'superseded'
    }

    // 远端读取或 R2 写入可能跨过租约边界；任何破坏性清理前必须重新证明仍持有执行权。
    // 若管理员已恢复任务，旧执行器只能回收本次上传与旧尝试目标，不能碰新尝试共享的文件行。
    if (!await tryRenewExternalImportLease(env.DB, record.id, message.processingToken)) {
      await cleanupFailedImport(env.DB, env.R2, record.id, uploadedKeys, record.target_type, targetId, false)
      return 'superseded'
    }

    const failure = safeImportFailure(error)
    if (currentFileId) {
      await env.DB.prepare(`
        UPDATE external_import_files
        SET status = 'failed', error_message = ?, updated_at = datetime('now')
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM external_import_records
          WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
        )
      `).bind(failure.message, currentFileId, record.id, message.processingToken).run()
    }
    const cleanup = await cleanupFailedImport(
      env.DB,
      env.R2,
      record.id,
      uploadedKeys,
      record.target_type,
      targetId,
      true,
    )
    const [, failed] = await env.DB.batch([
      externalImportAuditStatement(env.DB, {
        adminId: record.token_created_by,
        action: 'telegram_import.failed',
        importId: record.id,
        processingToken: message.processingToken,
        afterValue: {
          importId: record.id,
          targetType: record.target_type,
          code: failure.code,
          message: failure.message,
          cleanupRequired: cleanup.cleanupRequired,
          warningCodes: cleanup.warningCodes,
        },
      }),
      env.DB.prepare(`
        UPDATE external_import_records
        SET status = 'failed', target_id = NULL,
            processing_target_id = ?, processing_token = NULL,
            processing_started_at = NULL, processing_heartbeat_at = NULL,
            processing_lease_expires_at = NULL,
            fetched_count = (SELECT COUNT(*) FROM external_import_files WHERE import_id = ? AND status = 'completed'),
            failed_count = (SELECT COUNT(*) FROM external_import_files WHERE import_id = ? AND status = 'failed'),
            error_json = ?, completed_at = datetime('now')
        WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
      `).bind(
        cleanup.cleanupRequired ? targetId : null,
        record.id,
        record.id,
        JSON.stringify({
          code: failure.code,
          message: failure.message,
          cleanupRequired: cleanup.cleanupRequired,
          warningCodes: cleanup.warningCodes,
        }),
        record.id,
        message.processingToken,
      ),
    ])
    return changed(failed) ? 'failed' : 'superseded'
  }
}

class ExternalImportLeaseLostError extends Error {
  constructor() {
    super('外部导入处理租约已失效')
    this.name = 'ExternalImportLeaseLostError'
  }
}

async function renewExternalImportLease(db: D1Database, importId: string, processingToken: string) {
  if (!await tryRenewExternalImportLease(db, importId, processingToken)) {
    throw new ExternalImportLeaseLostError()
  }
}

async function tryRenewExternalImportLease(db: D1Database, importId: string, processingToken: string) {
  const leaseExpiresAt = new Date(Date.now() + EXTERNAL_IMPORT_LEASE_MS).toISOString()
  const result = await db.prepare(`
    UPDATE external_import_records
    SET processing_heartbeat_at = datetime('now'), processing_lease_expires_at = ?
    WHERE id = ? AND status = 'fetching_media' AND processing_token = ?
  `).bind(leaseExpiresAt, importId, processingToken).run()
  return changed(result)
}

function safeImportFailure(error: unknown) {
  if (error instanceof ImportError && isSafeImportErrorCode(error.code)) {
    return { code: error.code, message: SAFE_IMPORT_ERROR_MESSAGES[error.code] }
  }
  return { code: 'IMPORT_PROCESS_FAILED', message: '导入处理失败，请稍后重试' }
}

function externalImportAuditStatement(
  db: D1Database,
  input: {
    adminId: number
    action: string
    importId: string
    processingToken: string
    status?: 'pending_media_fetch' | 'fetching_media' | 'failed'
    afterValue: unknown
  },
) {
  return db.prepare(`
    INSERT INTO admin_audit_logs
      (id, admin_id, action, target_type, target_id, before_value, after_value)
    SELECT ?, ?, ?, 'external_import_record', ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM external_import_records
      WHERE id = ? AND status = ? AND processing_token = ?
    )
  `).bind(
    generateId('log'),
    input.adminId,
    input.action,
    input.importId,
    JSON.stringify(input.afterValue),
    input.importId,
    input.status ?? 'fetching_media',
    input.processingToken,
  )
}

export async function handleTelegramImportQueueBatch(
  batch: MessageBatch<TelegramImportQueueMessage>,
  env: TelegramImportEnvironment,
): Promise<void> {
  for (const rawMessage of batch.messages as unknown as QueueMessageLike[]) {
    const message = parseTelegramImportQueueMessage(rawMessage.body)
    if (!message) {
      safeAck(rawMessage)
      continue
    }
    try {
      const result = await processTelegramFileIdImport(env, message)
      if (result === 'retry_later') safeRetry(rawMessage)
      else safeAck(rawMessage)
    } catch (error) {
      console.error(JSON.stringify({
        event: 'telegram_import_queue_runtime_failed',
        importId: message.importId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }))
      safeRetry(rawMessage)
    }
  }
}

function parseTelegramImportQueueMessage(value: unknown): TelegramImportQueueMessage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<TelegramImportQueueMessage>
  if (
    candidate.schemaVersion !== 1
    || candidate.kind !== TELEGRAM_IMPORT_QUEUE_KIND
    || typeof candidate.importId !== 'string'
    || !candidate.importId.startsWith('eir_')
    || typeof candidate.processingToken !== 'string'
    || candidate.processingToken.length < 16
  ) return null
  return candidate as TelegramImportQueueMessage
}

function safeAck(message: QueueMessageLike) {
  try {
    message.ack()
  } catch {
    // ack 失败时由 Queue 使用默认重投语义；租约与 token 保证幂等。
  }
}

function safeRetry(message: QueueMessageLike) {
  try {
    message.retry({ delaySeconds: 60 })
  } catch {
    // retry 失败时不 ack，让 Queue 使用默认重投语义。
  }
}

const GENERIC_IMPORT_ERROR_MESSAGE = '导入处理失败，请稍后重试'

const SAFE_IMPORT_ERROR_MESSAGES = {
  TELEGRAM_BOT_TOKEN_MISSING: '未配置 Telegram Bot Token',
  TELEGRAM_GET_FILE_FAILED: 'Telegram getFile 调用失败',
  TELEGRAM_DOWNLOAD_FAILED: 'Telegram 文件下载失败',
  TELEGRAM_FILE_TOO_LARGE: 'Telegram 文件超过 10MB',
  TELEGRAM_FILE_EMPTY: 'Telegram 文件没有内容',
  TELEGRAM_FILE_TYPE_UNSUPPORTED: 'Telegram 文件类型不支持',
  TELEGRAM_FILE_CONTENT_INVALID: 'Telegram 文件内容不是受支持图片',
  TELEGRAM_FILE_MIME_MISMATCH: 'Telegram 文件内容与声明类型不一致',
  IMPORT_METADATA_INVALID: '导入元数据无效',
  IMPORT_FILE_STATE_INCOMPLETE: '导入文件状态不完整，请稍后重试',
  IMPORT_TARGET_SLUG_CONFLICT: '目标 slug 已存在',
  IMPORT_TAG_RESOLUTION_FAILED: '导入标签解析失败',
  IMPORT_RETRY_CLEANUP_REQUIRED: '失败导入仍有待清理资源，暂不能重试',
  IMPORT_RECOVERY_CLEANUP_REQUIRED: '过期导入资源清理未完成，请稍后重试',
  IMPORT_PROCESS_FAILED: GENERIC_IMPORT_ERROR_MESSAGE,
} as const

const SAFE_IMPORT_FILE_MESSAGES = new Set<string>([
  ...Object.values(SAFE_IMPORT_ERROR_MESSAGES),
  '图库 slug 已存在',
  '真实案例 slug 已存在',
])

export function parseExternalImportError(value: string | null) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as {
      code?: unknown
      cleanupRequired?: unknown
      warningCodes?: unknown
    }
    const code = isSafeImportErrorCode(parsed.code)
      ? parsed.code
      : 'IMPORT_PROCESS_FAILED'
    const warningCodes = Array.isArray(parsed.warningCodes)
      ? parsed.warningCodes.filter((item): item is string => typeof item === 'string' && [
          'IMPORT_R2_CLEANUP_FAILED',
          'IMPORT_D1_CLEANUP_FAILED',
          'IMPORT_FILE_STATE_CLEANUP_FAILED',
        ].includes(item))
      : []
    return {
      code,
      message: SAFE_IMPORT_ERROR_MESSAGES[code],
      ...(parsed.cleanupRequired === true ? { cleanupRequired: true } : {}),
      ...(warningCodes.length > 0 ? { warningCodes } : {}),
    }
  } catch {
    return {
      code: 'IMPORT_PROCESS_FAILED',
      message: GENERIC_IMPORT_ERROR_MESSAGE,
    }
  }
}

export function safeExternalImportFileMessage(value: unknown): string | null {
  return typeof value === 'string' && SAFE_IMPORT_FILE_MESSAGES.has(value)
    ? value
    : value ? GENERIC_IMPORT_ERROR_MESSAGE : null
}

function isSafeImportErrorCode(value: unknown): value is keyof typeof SAFE_IMPORT_ERROR_MESSAGES {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SAFE_IMPORT_ERROR_MESSAGES, value)
}

async function createImportedGallery(
  db: D1Database,
  galleryId: string,
  metadata: TelegramImportPayload['metadata'],
  files: FetchedImportFile[],
  creatorId: number,
) {
  const existing = await db.prepare('SELECT id FROM galleries WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
  if (existing) {
    // 目标创建 batch 已经原子成功、但最终状态响应中断时，Queue 重投应完成收敛而不是删除同一尝试的草稿。
    if (existing.id === galleryId) return
    throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '图库 slug 已存在', 409)
  }

  const tagIds: string[] = []
  for (const tagName of [...new Set(metadata.tags ?? [])]) {
    const normalizedName = tagName.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    let tag = await db.prepare(`
      SELECT id
      FROM tags
      WHERE type = 'personality' AND name = ? COLLATE NOCASE
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).bind(normalizedName).first<{ id: string }>()
    if (!tag) {
      const slug = await deterministicExternalImportTagSlug('personality', normalizedName)
      const tagId = generateId('tag')
      await db.batch([
        db.prepare(`
          INSERT OR IGNORE INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)
        `).bind(tagId, 'personality', normalizedName, slug),
        db.prepare(`
          INSERT INTO admin_audit_logs
            (id, admin_id, action, target_type, target_id, before_value, after_value)
          SELECT ?, ?, 'create_tag', 'tag', ?, NULL, ?
          WHERE EXISTS (
            SELECT 1 FROM tags WHERE id = ? AND type = 'personality' AND name = ? AND slug = ?
          )
        `).bind(
          generateId('log'),
          creatorId,
          tagId,
          JSON.stringify({ id: tagId, type: 'personality', name: normalizedName, slug }),
          tagId,
          normalizedName,
          slug,
        ),
      ])
      tag = await db.prepare(`
        SELECT id
        FROM tags
        WHERE type = 'personality' AND name = ? COLLATE NOCASE AND slug = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).bind(normalizedName, slug).first<{ id: string }>()
      if (!tag) throw new ImportError('IMPORT_TAG_RESOLUTION_FAILED', '导入标签解析失败', 503)
    }
    tagIds.push(tag.id)
  }

  const cover = files.find(file => file.isCover) ?? files[0]
  await db.batch([
    db.prepare(`
      INSERT INTO galleries (id, title, slug, summary, body_md, cover_key, status, required_level_rank)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
    `).bind(galleryId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, cover?.r2Key ?? null, metadata.requiredLevelRank ?? 0),
    ...files.map(file => db.prepare(`
      INSERT INTO media_assets (id, gallery_id, type, storage, r2_key, required_rank, role, sort_order, upload_status)
      VALUES (?, ?, 'image', 'r2', ?, ?, 'gallery_image', ?, 'completed')
    `).bind(file.fileId, galleryId, file.r2Key, metadata.requiredLevelRank ?? 0, file.sortOrder)),
    ...tagIds.map(tagId => db.prepare(`
      INSERT INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)
    `).bind(galleryId, tagId)),
  ])
}

async function deterministicExternalImportTagSlug(type: string, name: string): Promise<string> {
  const canonical = `${type}\u0000${name.toLocaleLowerCase('zh-CN')}`
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
  const suffix = [...digest.subarray(0, 12)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${type}-${suffix}`
}

async function createImportedCase(db: D1Database, caseId: string, metadata: TelegramImportPayload['metadata'], files: FetchedImportFile[], creatorId: number) {
  const existing = await db.prepare('SELECT id FROM cases WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
  if (existing) {
    if (existing.id === caseId) return
    throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '真实案例 slug 已存在', 409)
  }

  await db.batch([
    db.prepare(`
      INSERT INTO cases
        (id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `).bind(caseId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, metadata.featured === false ? 0 : 1, metadata.sortOrder ?? 0, metadata.seoTitle ?? null, metadata.seoDescription ?? null, creatorId, creatorId),
    ...files.map(file => db.prepare(`
      INSERT INTO case_images (id, case_id, r2_key, alt_text, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(file.fileId, caseId, file.r2Key, `${metadata.title} 图片`, file.mimeType, file.fileSize, file.sortOrder)),
  ])
}

async function cleanupFailedImport(
  db: D1Database,
  r2: R2Bucket,
  importId: string,
  uploadedKeys: string[],
  targetType: TargetType,
  targetId: string | null,
  includePersistedFileRows: boolean,
): Promise<CleanupResult> {
  const keys = new Set(uploadedKeys)
  if (includePersistedFileRows) {
    const fileRows = await db.prepare(`
      SELECT r2_key FROM external_import_files WHERE import_id = ?
    `).bind(importId).all<{ r2_key: string | null }>()
    for (const row of fileRows.results) if (row.r2_key) keys.add(row.r2_key)
  }

  const warningCodes: string[] = []
  let r2Cleaned = true
  if (keys.size > 0) {
    try {
      await r2.delete([...keys])
    } catch (error) {
      r2Cleaned = false
      warningCodes.push('IMPORT_R2_CLEANUP_FAILED')
      console.error(JSON.stringify({
        event: 'telegram_import_r2_cleanup_failed',
        importId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }))
    }
  }

  let dbCleaned = true
  try {
    if (targetId) {
      if (targetType === 'gallery') {
        await db.prepare('DELETE FROM gallery_tags WHERE gallery_id = ?').bind(targetId).run()
        await db.prepare('DELETE FROM media_assets WHERE gallery_id = ?').bind(targetId).run()
        await db.prepare('DELETE FROM galleries WHERE id = ?').bind(targetId).run()
      } else {
        await db.prepare('DELETE FROM case_images WHERE case_id = ?').bind(targetId).run()
        await db.prepare('DELETE FROM cases WHERE id = ?').bind(targetId).run()
      }
    }
  } catch (error) {
    dbCleaned = false
    warningCodes.push('IMPORT_D1_CLEANUP_FAILED')
    console.error(JSON.stringify({
      event: 'telegram_import_d1_cleanup_failed',
      importId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }))
  }

  if (includePersistedFileRows && r2Cleaned && dbCleaned) {
    try {
      await db.prepare(`
        UPDATE external_import_files
        SET status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'pending' END,
            r2_key = NULL, target_file_id = NULL, actual_mime_type = NULL,
            file_size = NULL, updated_at = datetime('now')
        WHERE import_id = ?
      `).bind(importId).run()
    } catch (error) {
      dbCleaned = false
      warningCodes.push('IMPORT_FILE_STATE_CLEANUP_FAILED')
      console.error(JSON.stringify({
        event: 'telegram_import_file_state_cleanup_failed',
        importId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }))
    }
  }

  return {
    dbCleaned,
    r2Cleaned,
    cleanupRequired: !dbCleaned || !r2Cleaned,
    warningCodes,
  }
}

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0) > 0
}
