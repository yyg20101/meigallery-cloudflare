import {
  isExternalMediaKey,
  resolveAdminMediaThumbnailUrl,
  resolvePublicCoverUrl,
  safeExternalMediaUrl,
} from '../utils/cover-url'
import { generateId } from '../utils/db'
import { isExpectedGalleryMediaKey } from '../utils/media-keys'
import { writeAuditLog } from '../utils/permission'

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MEDIA_ROLES = new Set(['content', 'cover', 'preview', 'full'])
const REQUIRED_RANKS = new Set([0, 10, 20])

export interface AdminMediaListItem {
  id: string
  galleryId: string
  type: string
  storage: string
  r2Key: string | null
  streamUid: string | null
  requiredRank: number
  role: string
  sortOrder: number
  uploadStatus: string
  createdAt: string
  thumbnailUrl: string | null
}

export interface AdminMediaUploadResult {
  uploaded: Array<{
    assetId: string
    r2Key: string
    thumbnailUrl: string
    sortOrder: number
  }>
  failed: Array<{ filename: string; error: string }>
}

export interface AdminMediaUpdateInput {
  requiredRank?: number
  sortOrder?: number
  role?: string
}

export class AdminMediaError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AdminMediaError'
  }
}

interface MediaAssetRow {
  id: string
  gallery_id: string
  type: string
  storage: string
  r2_key: string | null
  stream_uid: string | null
  required_rank: number
  role: string
  sort_order: number
  upload_status: string
  created_at: string
}

async function assertGalleryExists<T extends Record<string, unknown> = { id: string }>(
  db: D1Database,
  galleryId: string,
  select = 'id',
): Promise<T> {
  const gallery = await db
    .prepare(`SELECT ${select} FROM galleries WHERE id = ?`)
    .bind(galleryId)
    .first<T>()
  if (!gallery) {
    throw new AdminMediaError(404, '图库不存在')
  }
  return gallery
}

function getImageExtension(file: File) {
  const expectedExt = IMAGE_TYPES[file.type]
  if (expectedExt) return expectedExt
  return file.name.split('.').pop()?.toLowerCase() || 'jpg'
}

function validateImageFile(file: File): string | null {
  if (!IMAGE_TYPES[file.type]) {
    return `不支持的文件格式: ${file.type}`
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return `文件过大: ${(file.size / 1024 / 1024).toFixed(1)}MB，最大 10MB`
  }
  return null
}

function assertExistingMediaKeyBelongsToAsset(r2Key: string, galleryId: string, assetId: string) {
  if (isExternalMediaKey(r2Key)) {
    if (!safeExternalMediaUrl(r2Key)) {
      throw new AdminMediaError(400, '媒体资源地址不安全，不能设为封面')
    }
    return
  }

  if (!isExpectedGalleryMediaKey(r2Key, galleryId, assetId)) {
    throw new AdminMediaError(409, '媒体 R2 key 与当前图库/媒体不匹配，请先人工核查')
  }
}

export async function listAdminGalleryMedia(db: D1Database, galleryId: string): Promise<{ data: AdminMediaListItem[] }> {
  await assertGalleryExists(db, galleryId)

  const assets = await db
    .prepare(`
      SELECT id, gallery_id, type, storage, r2_key, stream_uid,
             required_rank, role, sort_order, upload_status, created_at
      FROM media_assets
      WHERE gallery_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `)
    .bind(galleryId)
    .all<MediaAssetRow>()

  return {
    data: assets.results.map((asset) => ({
      id: asset.id,
      galleryId: asset.gallery_id,
      type: asset.type,
      storage: asset.storage,
      r2Key: asset.r2_key,
      streamUid: asset.stream_uid,
      requiredRank: asset.required_rank,
      role: asset.role,
      sortOrder: asset.sort_order,
      uploadStatus: asset.upload_status,
      createdAt: asset.created_at,
      thumbnailUrl:
        asset.type === 'image' && asset.r2_key
          ? resolveAdminMediaThumbnailUrl(asset.id, asset.r2_key)
          : null,
    })),
  }
}

export async function uploadAdminGalleryMedia(
  db: D1Database,
  r2: R2Bucket,
  userId: number,
  galleryId: string,
  files: File[],
): Promise<AdminMediaUploadResult> {
  await assertGalleryExists(db, galleryId)
  if (files.length === 0) {
    throw new AdminMediaError(400, '请选择至少一个文件')
  }

  const maxOrder = await db
    .prepare('SELECT MAX(sort_order) as max_order FROM media_assets WHERE gallery_id = ?')
    .bind(galleryId)
    .first<{ max_order: number | null }>()
  let nextOrder = (maxOrder?.max_order ?? -1) + 1

  const uploaded: AdminMediaUploadResult['uploaded'] = []
  const failed: AdminMediaUploadResult['failed'] = []

  for (const file of files) {
    try {
      const validationError = validateImageFile(file)
      if (validationError) {
        failed.push({ filename: file.name, error: validationError })
        continue
      }

      const assetId = generateId('ma')
      const r2Key = `originals/${galleryId}/${assetId}.${getImageExtension(file)}`
      await r2.put(r2Key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      })

      await db
        .prepare(`
          INSERT INTO media_assets (id, gallery_id, type, storage, r2_key, role, sort_order, upload_status, required_rank)
          VALUES (?, ?, 'image', 'r2', ?, 'content', ?, 'completed', 0)
        `)
        .bind(assetId, galleryId, r2Key, nextOrder)
        .run()

      uploaded.push({
        assetId,
        r2Key,
        thumbnailUrl: `/api/admin/media/${assetId}/thumbnail`,
        sortOrder: nextOrder,
      })
      nextOrder++
    } catch (error) {
      failed.push({
        filename: file.name,
        error: error instanceof Error ? error.message : '上传失败',
      })
    }
  }

  await db
    .prepare("UPDATE galleries SET updated_at = datetime('now') WHERE id = ?")
    .bind(galleryId)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'upload_media',
    targetType: 'gallery',
    targetId: galleryId,
    afterValue: { uploadedCount: uploaded.length, failedCount: failed.length },
  })

  return { uploaded, failed }
}

export async function setAdminGalleryCoverFromFile(
  db: D1Database,
  r2: R2Bucket,
  userId: number,
  galleryId: string,
  file: File | null,
): Promise<{ coverKey: string; coverUrl: string | null }> {
  const gallery = await assertGalleryExists<{ id: string; cover_key: string | null }>(db, galleryId, 'id, cover_key')
  if (!file) {
    throw new AdminMediaError(400, '请选择封面文件')
  }

  const validationError = validateImageFile(file)
  if (validationError) {
    throw new AdminMediaError(400, validationError.startsWith('文件过大') ? '文件过大，最大 10MB' : validationError)
  }

  const newCoverKey = `covers/${galleryId}.${getImageExtension(file)}`
  await r2.put(newCoverKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })

  return saveGalleryCover(db, userId, galleryId, gallery.cover_key, newCoverKey)
}

export async function setAdminGalleryCoverFromAsset(
  db: D1Database,
  userId: number,
  galleryId: string,
  assetId?: string,
): Promise<{ coverKey: string; coverUrl: string | null }> {
  const gallery = await assertGalleryExists<{ id: string; cover_key: string | null }>(db, galleryId, 'id, cover_key')
  if (!assetId) {
    throw new AdminMediaError(400, 'assetId 为必填')
  }

  const asset = await db
    .prepare('SELECT id, gallery_id, r2_key FROM media_assets WHERE id = ? AND gallery_id = ?')
    .bind(assetId, galleryId)
    .first<{ id: string; gallery_id: string; r2_key: string | null }>()
  if (!asset?.r2_key) {
    throw new AdminMediaError(404, '媒体资源不存在或无 R2 文件')
  }
  assertExistingMediaKeyBelongsToAsset(asset.r2_key, asset.gallery_id, asset.id)

  return saveGalleryCover(db, userId, galleryId, gallery.cover_key, asset.r2_key)
}

async function saveGalleryCover(
  db: D1Database,
  userId: number,
  galleryId: string,
  oldCoverKey: string | null,
  newCoverKey: string,
) {
  await db
    .prepare("UPDATE galleries SET cover_key = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newCoverKey, galleryId)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'set_cover',
    targetType: 'gallery',
    targetId: galleryId,
    beforeValue: { coverKey: oldCoverKey },
    afterValue: { coverKey: newCoverKey },
  })

  return {
    coverKey: newCoverKey,
    coverUrl: resolvePublicCoverUrl(galleryId, newCoverKey),
  }
}

export async function reorderAdminGalleryMedia(
  db: D1Database,
  userId: number,
  galleryId: string,
  order: Array<{ assetId: string; sortOrder: number }> | undefined,
): Promise<{ success: true }> {
  if (!order || order.length === 0) {
    throw new AdminMediaError(400, '排序数据为空')
  }

  const stmt = db.prepare('UPDATE media_assets SET sort_order = ? WHERE id = ? AND gallery_id = ?')
  await db.batch(order.map(item => stmt.bind(item.sortOrder, item.assetId, galleryId)))

  await db
    .prepare("UPDATE galleries SET updated_at = datetime('now') WHERE id = ?")
    .bind(galleryId)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'reorder_media',
    targetType: 'gallery',
    targetId: galleryId,
    afterValue: { count: order.length },
  })

  return { success: true }
}

export async function updateAdminMediaAsset(
  db: D1Database,
  userId: number,
  assetId: string,
  body: AdminMediaUpdateInput,
): Promise<{ assetId: string; requiredRank: number; sortOrder: number; role: string }> {
  const asset = await db
    .prepare('SELECT id, gallery_id, required_rank, sort_order, role FROM media_assets WHERE id = ?')
    .bind(assetId)
    .first<{
      id: string
      gallery_id: string
      required_rank: number
      sort_order: number
      role: string
    }>()
  if (!asset) {
    throw new AdminMediaError(404, '媒体资源不存在')
  }

  const updates: string[] = []
  const values: unknown[] = []

  if (body.requiredRank !== undefined) {
    if (!REQUIRED_RANKS.has(body.requiredRank)) {
      throw new AdminMediaError(400, '无效的会员等级，允许值: 0, 10, 20')
    }
    updates.push('required_rank = ?')
    values.push(body.requiredRank)
  }
  if (body.sortOrder !== undefined) {
    updates.push('sort_order = ?')
    values.push(body.sortOrder)
  }
  if (body.role !== undefined) {
    if (!MEDIA_ROLES.has(body.role)) {
      throw new AdminMediaError(400, '无效的角色')
    }
    updates.push('role = ?')
    values.push(body.role)
  }

  if (updates.length === 0) {
    throw new AdminMediaError(400, '无修改内容')
  }

  await db
    .prepare(`UPDATE media_assets SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values, assetId)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'update_media',
    targetType: 'media_asset',
    targetId: assetId,
    beforeValue: { requiredRank: asset.required_rank, sortOrder: asset.sort_order, role: asset.role },
    afterValue: body,
  })

  return {
    assetId,
    requiredRank: body.requiredRank ?? asset.required_rank,
    sortOrder: body.sortOrder ?? asset.sort_order,
    role: body.role ?? asset.role,
  }
}

export async function deleteAdminMediaAsset(
  db: D1Database,
  r2: R2Bucket,
  userId: number,
  assetId: string,
): Promise<{ success: true }> {
  const asset = await db
    .prepare('SELECT id, gallery_id, r2_key, type FROM media_assets WHERE id = ?')
    .bind(assetId)
    .first<{
      id: string
      gallery_id: string
      r2_key: string | null
      type: string
    }>()
  if (!asset) {
    throw new AdminMediaError(404, '媒体资源不存在')
  }

  if (asset.r2_key && !isExternalMediaKey(asset.r2_key)) {
    if (!isExpectedGalleryMediaKey(asset.r2_key, asset.gallery_id, asset.id)) {
      throw new AdminMediaError(409, '媒体 R2 key 与当前图库/媒体不匹配，请先人工核查')
    }
    try {
      await r2.delete(asset.r2_key)
    } catch {
      // R2 删除失败不阻断数据库清理。
    }
  }

  await db.prepare('DELETE FROM media_assets WHERE id = ?').bind(assetId).run()

  const gallery = await db
    .prepare('SELECT cover_key FROM galleries WHERE id = ?')
    .bind(asset.gallery_id)
    .first<{ cover_key: string | null }>()
  if (gallery?.cover_key === asset.r2_key) {
    await db
      .prepare("UPDATE galleries SET cover_key = NULL, updated_at = datetime('now') WHERE id = ?")
      .bind(asset.gallery_id)
      .run()
  } else {
    await db
      .prepare("UPDATE galleries SET updated_at = datetime('now') WHERE id = ?")
      .bind(asset.gallery_id)
      .run()
  }

  await writeAuditLog(db, {
    adminId: userId,
    action: 'delete_media',
    targetType: 'media_asset',
    targetId: assetId,
    beforeValue: { galleryId: asset.gallery_id, type: asset.type, r2Key: asset.r2_key },
  })

  return { success: true }
}
