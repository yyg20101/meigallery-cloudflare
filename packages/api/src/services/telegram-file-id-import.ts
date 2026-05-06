import { generateId } from '../utils/db'
import { ImportError } from '../utils/import-errors'
import type { TelegramImportPayload } from '../utils/import-validation'
import { fetchTelegramImageFile, getExtensionForMime } from './telegram-file-fetcher'

export type ExternalImportStatus = 'pending_media_fetch' | 'fetching_media' | 'draft_created' | 'partial_failed' | 'failed'

type TargetType = TelegramImportPayload['metadata']['type']
type FetchedImportFile = {
  fileId: string
  r2Key: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileSize: number
  sortOrder: number
  isCover: boolean
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

export async function createExternalImportRecord(
  db: D1Database,
  tokenId: string,
  payload: TelegramImportPayload,
  requestIp: string | null,
  userAgent: string | null,
): Promise<CreateImportResult> {
  const existing = await db.prepare(`
    SELECT id, target_type, target_id, status
    FROM external_import_records
    WHERE token_id = ? AND source = 'telegram' AND external_message_id = ?
  `).bind(tokenId, payload.metadata.externalMessageId).first<{ id: string; target_type: TargetType; target_id: string | null; status: ExternalImportStatus }>()

  if (existing) {
    return {
      importId: existing.id,
      type: existing.target_type,
      targetId: existing.target_id,
      status: 'duplicate',
      currentStatus: existing.status,
      message: '该 Telegram 消息已导入',
    }
  }

  const importId = generateId('eir')
  await db.prepare(`
    INSERT INTO external_import_records
      (id, source, external_message_id, token_id, source_bot_key, source_chat_id, source_message_id, media_group_id, target_type, metadata_json, file_count, request_ip, user_agent)
    VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  ).run()

  for (const file of payload.files) {
    await db.prepare(`
      INSERT INTO external_import_files
        (id, import_id, telegram_file_id, telegram_file_unique_id, filename, declared_mime_type, sort_order, is_cover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('eif'),
      importId,
      file.fileId,
      file.fileUniqueId ?? null,
      file.filename ?? null,
      file.mimeType,
      file.sortOrder,
      file.isCover ? 1 : 0,
    ).run()
  }

  return { importId, type: payload.metadata.type, status: 'pending_media_fetch', receivedFileCount: payload.files.length }
}

export async function getExternalImportStatus(db: D1Database, importId: string, tokenId: string) {
  const record = await db.prepare(`
    SELECT id, target_type, status, target_id, file_count, fetched_count, failed_count, retry_count, created_at, completed_at
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

  return {
    importId: record.id,
    type: record.target_type,
    status: record.status,
    targetId: record.target_id,
    fileCount: record.file_count,
    fetchedCount: record.fetched_count,
    failedCount: record.failed_count,
    retryCount: record.retry_count,
    files: files.results.map(file => ({ filename: file.filename, status: file.status, sortOrder: file.sort_order, errorMessage: file.error_message })),
    createdAt: record.created_at,
    completedAt: record.completed_at,
  }
}

export async function resetFailedImportForRetry(db: D1Database, importId: string, tokenId: string) {
  const record = await db.prepare('SELECT id, target_type, target_id, status, retry_count FROM external_import_records WHERE id = ? AND token_id = ?')
    .bind(importId, tokenId)
    .first<{ id: string; target_type: string; target_id: string | null; status: string; retry_count: number }>()
  if (!record) throw new ImportError('IMPORT_NOT_FOUND', '导入记录不存在', 404)
  if (record.status !== 'failed') throw new ImportError('IMPORT_RETRY_NOT_ALLOWED', '当前导入状态不允许重试', 409)
  if (record.target_id) throw new ImportError('IMPORT_RETRY_CLEANUP_REQUIRED', '失败导入仍有待清理资源，暂不能重试', 409)

  const dirtyFiles = await db.prepare(`
    SELECT id FROM external_import_files
    WHERE import_id = ? AND (r2_key IS NOT NULL OR target_file_id IS NOT NULL)
    LIMIT 1
  `).bind(importId).first<{ id: string }>()
  if (dirtyFiles) throw new ImportError('IMPORT_RETRY_CLEANUP_REQUIRED', '失败导入仍有待清理资源，暂不能重试', 409)

  await db.prepare(`
    UPDATE external_import_records
    SET status = 'pending_media_fetch', fetched_count = 0, failed_count = 0, retry_count = retry_count + 1,
        last_retry_at = datetime('now'), error_json = NULL, completed_at = NULL
    WHERE id = ?
  `).bind(importId).run()
  await db.prepare(`
    UPDATE external_import_files
    SET status = 'pending', error_message = NULL, r2_key = NULL, target_file_id = NULL,
        actual_mime_type = NULL, file_size = NULL, updated_at = datetime('now')
    WHERE import_id = ?
  `).bind(importId).run()

  return { importId, type: record.target_type, status: 'pending_media_fetch' as const, retryCount: record.retry_count + 1, message: '导入重试已开始' }
}

export async function processTelegramFileIdImport(db: D1Database, r2: R2Bucket, env: Record<string, string | undefined>, importId: string): Promise<void> {
  const record = await db.prepare('SELECT * FROM external_import_records WHERE id = ?')
    .bind(importId)
    .first<{ id: string; source_bot_key: string; target_type: TargetType; metadata_json: string }>()
  if (!record) return

  await db.prepare("UPDATE external_import_records SET status = 'fetching_media' WHERE id = ? AND status = 'pending_media_fetch'").bind(importId).run()

  const files = await db.prepare('SELECT * FROM external_import_files WHERE import_id = ? ORDER BY sort_order ASC')
    .bind(importId)
    .all<{ id: string; telegram_file_id: string; sort_order: number; is_cover: number }>()

  const uploadedKeys: string[] = []
  let targetId: string | null = null
  try {
    const metadata = JSON.parse(record.metadata_json) as TelegramImportPayload['metadata']
    targetId = record.target_type === 'gallery' ? generateId('gal') : generateId('tc')
    const fetchedFiles: FetchedImportFile[] = []

    for (const file of files.results) {
      await db.prepare("UPDATE external_import_files SET status = 'fetching', updated_at = datetime('now') WHERE id = ?").bind(file.id).run()
      const fetched = await fetchTelegramImageFile(env, record.source_bot_key, file.telegram_file_id)
      const extension = getExtensionForMime(fetched.mimeType)
      const targetFileId = record.target_type === 'gallery' ? generateId('med') : generateId('tci')
      const r2Key = record.target_type === 'gallery' ? `originals/${targetId}/${targetFileId}.${extension}` : `testimonials/${targetId}/${targetFileId}.${extension}`
      await r2.put(r2Key, fetched.bytes, { httpMetadata: { contentType: fetched.mimeType } })
      uploadedKeys.push(r2Key)
      fetchedFiles.push({ fileId: targetFileId, mimeType: fetched.mimeType, fileSize: fetched.fileSize, r2Key, sortOrder: file.sort_order, isCover: Boolean(file.is_cover) })
      await db.prepare(`
        UPDATE external_import_files
        SET status = 'completed', actual_mime_type = ?, file_size = ?, r2_key = ?, target_file_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(fetched.mimeType, fetched.fileSize, r2Key, targetFileId, file.id).run()
    }

    if (record.target_type === 'gallery') await createImportedGallery(db, targetId, metadata, fetchedFiles)
    else await createImportedTestimonialCase(db, targetId, metadata, fetchedFiles)

    await db.prepare(`
      UPDATE external_import_records
      SET status = 'draft_created', target_id = ?, fetched_count = ?, failed_count = 0, completed_at = datetime('now')
      WHERE id = ?
    `).bind(targetId, fetchedFiles.length, importId).run()
  } catch (error) {
    await cleanupFailedImport(db, r2, importId, uploadedKeys, record.target_type, targetId)
    const message = error instanceof Error ? error.message : '导入处理失败'
    await db.prepare(`
      UPDATE external_import_records
      SET status = 'failed', target_id = NULL, failed_count = file_count, error_json = ?, completed_at = datetime('now')
      WHERE id = ?
    `).bind(JSON.stringify({ message }), importId).run()
  }
}

async function createImportedGallery(db: D1Database, galleryId: string, metadata: TelegramImportPayload['metadata'], files: FetchedImportFile[]) {
  const existing = await db.prepare('SELECT id FROM galleries WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
  if (existing) throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '图库 slug 已存在', 409)

  const cover = files.find(file => file.isCover) ?? files[0]
  await db.prepare(`
    INSERT INTO galleries (id, title, slug, summary, body_md, cover_key, status, required_level_rank)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
  `).bind(galleryId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, cover?.r2Key ?? null, metadata.requiredLevelRank ?? 0).run()

  for (const file of files) {
    await db.prepare(`
      INSERT INTO media_assets (id, gallery_id, type, storage, r2_key, required_rank, role, sort_order, upload_status)
      VALUES (?, ?, 'image', 'r2', ?, ?, 'gallery_image', ?, 'completed')
    `).bind(file.fileId, galleryId, file.r2Key, metadata.requiredLevelRank ?? 0, file.sortOrder).run()
  }

  for (const tagName of metadata.tags ?? []) {
    const slug = tagName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '-')
    let tag = await db.prepare('SELECT id FROM tags WHERE slug = ? OR name = ?').bind(slug, tagName).first<{ id: string }>()
    if (!tag) {
      const tagId = generateId('tag')
      await db.prepare('INSERT INTO tags (id, type, name, slug) VALUES (?, ?, ?, ?)').bind(tagId, 'personality', tagName, slug).run()
      tag = { id: tagId }
    }
    await db.prepare('INSERT OR IGNORE INTO gallery_tags (gallery_id, tag_id) VALUES (?, ?)').bind(galleryId, tag.id).run()
  }
}

async function createImportedTestimonialCase(db: D1Database, caseId: string, metadata: TelegramImportPayload['metadata'], files: FetchedImportFile[]) {
  const existing = await db.prepare('SELECT id FROM testimonial_cases WHERE slug = ?').bind(metadata.slug).first<{ id: string }>()
  if (existing) throw new ImportError('IMPORT_TARGET_SLUG_CONFLICT', '真实案例 slug 已存在', 409)

  await db.prepare(`
    INSERT INTO testimonial_cases
      (id, title, slug, summary, body_md, status, featured, sort_order, seo_title, seo_description, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, 1)
  `).bind(caseId, metadata.title, metadata.slug, metadata.summary ?? null, metadata.bodyMd ?? null, metadata.featured === false ? 0 : 1, metadata.sortOrder ?? 0, metadata.seoTitle ?? null, metadata.seoDescription ?? null).run()

  for (const file of files) {
    await db.prepare(`
      INSERT INTO testimonial_case_images (id, case_id, r2_key, alt_text, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(file.fileId, caseId, file.r2Key, `${metadata.title} 图片`, file.mimeType, file.fileSize, file.sortOrder).run()
  }
}

async function cleanupFailedImport(db: D1Database, r2: R2Bucket, importId: string, uploadedKeys: string[], targetType: TargetType, targetId: string | null) {
  const keys = new Set(uploadedKeys)
  const fileRows = await db.prepare('SELECT target_file_id, r2_key FROM external_import_files WHERE import_id = ?').bind(importId).all<{ target_file_id: string | null; r2_key: string | null }>()
  for (const row of fileRows.results) if (row.r2_key) keys.add(row.r2_key)
  if (keys.size > 0) await r2.delete([...keys])
  if (targetId) {
    if (targetType === 'gallery') {
      await db.prepare('DELETE FROM gallery_tags WHERE gallery_id = ?').bind(targetId).run()
      await db.prepare('DELETE FROM media_assets WHERE gallery_id = ?').bind(targetId).run()
      await db.prepare('DELETE FROM galleries WHERE id = ?').bind(targetId).run()
    } else {
      await db.prepare('DELETE FROM testimonial_case_images WHERE case_id = ?').bind(targetId).run()
      await db.prepare('DELETE FROM testimonial_cases WHERE id = ?').bind(targetId).run()
    }
  }
  await db.prepare("UPDATE external_import_files SET r2_key = NULL, target_file_id = NULL WHERE import_id = ?").bind(importId).run()
}
