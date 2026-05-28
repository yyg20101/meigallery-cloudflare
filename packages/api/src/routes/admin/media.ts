import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { requireAdmin } from '../../middleware/auth'
import { errorJson } from '../../utils/api-error'
import { writeAuditLog } from '../../utils/permission'
import { generateId } from '../../utils/db'

export const adminMediaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 所有媒体管理路由要求管理员权限
adminMediaRoutes.use('*', requireAdmin)

// ============================================================
// 图库范围的媒体路由
// ============================================================

/**
 * GET /galleries/:galleryId/media - 获取图库所有媒体资源
 */
adminMediaRoutes.get('/galleries/:galleryId/media', async (c) => {
  const db = c.env.DB
  const galleryId = c.req.param('galleryId')

  const gallery = await db
    .prepare('SELECT id FROM galleries WHERE id = ?')
    .bind(galleryId)
    .first()
  if (!gallery) return errorJson(c, 404, '图库不存在')

  const assets = await db
    .prepare(`
      SELECT id, gallery_id, type, storage, r2_key, stream_uid,
             required_rank, role, sort_order, upload_status, created_at
      FROM media_assets
      WHERE gallery_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `)
    .bind(galleryId)
    .all<{
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
    }>()

  const data = assets.results.map((a) => ({
    id: a.id,
    galleryId: a.gallery_id,
    type: a.type,
    storage: a.storage,
    r2Key: a.r2_key,
    streamUid: a.stream_uid,
    requiredRank: a.required_rank,
    role: a.role,
    sortOrder: a.sort_order,
    uploadStatus: a.upload_status,
    createdAt: a.created_at,
    // 缩略图 URL：R2 图片走代理，外部 URL 直通
    thumbnailUrl:
      a.type === 'image' && a.r2_key
        ? a.r2_key.startsWith('http')
          ? a.r2_key
          : `/api/media/${a.id}/thumbnail`
        : null,
  }))

  return c.json({ data })
})

/**
 * POST /galleries/:galleryId/media/upload - 图片上传（multipart/form-data）
 * 支持多文件，格式：JPG/PNG/WebP，单张 <= 10MB
 */
adminMediaRoutes.post('/galleries/:galleryId/media/upload', async (c) => {
  const db = c.env.DB
  const r2 = c.env.R2
  const galleryId = c.req.param('galleryId')
  const userId = c.get('userId')!

  const gallery = await db
    .prepare('SELECT id FROM galleries WHERE id = ?')
    .bind(galleryId)
    .first()
  if (!gallery) return errorJson(c, 404, '图库不存在')

  const formData = await c.req.formData()
  // Workers FormData 类型定义较严格，实际运行时 getAll 返回 File 对象
  const files = formData.getAll('files') as unknown as File[]

  if (files.length === 0) {
    return errorJson(c, 400, '请选择至少一个文件')
  }

  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
  const MAX_SIZE = 10 * 1024 * 1024 // 10MB

  // 获取当前最大 sort_order
  const maxOrder = await db
    .prepare('SELECT MAX(sort_order) as max_order FROM media_assets WHERE gallery_id = ?')
    .bind(galleryId)
    .first<{ max_order: number | null }>()
  let nextOrder = (maxOrder?.max_order ?? -1) + 1

  const uploaded: Array<{
    assetId: string
    r2Key: string
    thumbnailUrl: string
    sortOrder: number
  }> = []
  const failed: Array<{ filename: string; error: string }> = []

  for (const file of files) {
    try {
      if (!ALLOWED_TYPES.includes(file.type)) {
        failed.push({ filename: file.name, error: `不支持的文件格式: ${file.type}` })
        continue
      }
      if (file.size > MAX_SIZE) {
        failed.push({
          filename: file.name,
          error: `文件过大: ${(file.size / 1024 / 1024).toFixed(1)}MB，最大 10MB`,
        })
        continue
      }

      const assetId = generateId('ma')
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
      const r2Key = `originals/${galleryId}/${assetId}.${ext}`

      // 上传到 R2
      const arrayBuffer = await file.arrayBuffer()
      await r2.put(r2Key, arrayBuffer, {
        httpMetadata: { contentType: file.type },
      })

      // 创建 media_assets 记录
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
        thumbnailUrl: `/api/media/${assetId}/thumbnail`,
        sortOrder: nextOrder,
      })

      nextOrder++
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '上传失败'
      failed.push({ filename: file.name, error: msg })
    }
  }

  // 更新图库 updated_at
  await db
    .prepare("UPDATE galleries SET updated_at = datetime('now') WHERE id = ?")
    .bind(galleryId)
    .run()

  // 审计日志
  await writeAuditLog(db, {
    adminId: userId,
    action: 'upload_media',
    targetType: 'gallery',
    targetId: galleryId,
    afterValue: { uploadedCount: uploaded.length, failedCount: failed.length },
  })

  return c.json({ uploaded, failed }, 201)
})

/**
 * PATCH /galleries/:galleryId/cover - 设置封面
 * 支持两种方式：
 * 1. JSON { assetId } - 从已有媒体选择
 * 2. multipart/form-data { file } - 直接上传新封面
 */
adminMediaRoutes.patch('/galleries/:galleryId/cover', async (c) => {
  const db = c.env.DB
  const r2 = c.env.R2
  const galleryId = c.req.param('galleryId')
  const userId = c.get('userId')!

  const gallery = await db
    .prepare('SELECT id, cover_key FROM galleries WHERE id = ?')
    .bind(galleryId)
    .first<{ id: string; cover_key: string | null }>()
  if (!gallery) return errorJson(c, 404, '图库不存在')

  const contentType = c.req.header('content-type') || ''

  let newCoverKey: string

  if (contentType.includes('multipart/form-data')) {
    // 直接上传封面图
    const formData = await c.req.formData()
    const file = formData.get('file') as unknown as File | null
    if (!file) return errorJson(c, 400, '请选择封面文件')

    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
    if (!ALLOWED_TYPES.includes(file.type)) {
      return errorJson(c, 400, `不支持的文件格式: ${file.type}`)
    }
    if (file.size > 10 * 1024 * 1024) {
      return errorJson(c, 400, '文件过大，最大 10MB')
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    newCoverKey = `covers/${galleryId}.${ext}`

    const arrayBuffer = await file.arrayBuffer()
    await r2.put(newCoverKey, arrayBuffer, {
      httpMetadata: { contentType: file.type },
    })
  } else {
    // 从已有媒体选择封面
    const body = await c.req.json<{ assetId: string }>()
    if (!body.assetId) return errorJson(c, 400, 'assetId 为必填')

    const asset = await db
      .prepare('SELECT r2_key FROM media_assets WHERE id = ? AND gallery_id = ?')
      .bind(body.assetId, galleryId)
      .first<{ r2_key: string | null }>()
    if (!asset?.r2_key) return errorJson(c, 404, '媒体资源不存在或无 R2 文件')

    newCoverKey = asset.r2_key
  }

  await db
    .prepare("UPDATE galleries SET cover_key = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newCoverKey, galleryId)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'set_cover',
    targetType: 'gallery',
    targetId: galleryId,
    beforeValue: { coverKey: gallery.cover_key },
    afterValue: { coverKey: newCoverKey },
  })

  return c.json({
    coverKey: newCoverKey,
    coverUrl: newCoverKey.startsWith('http') ? newCoverKey : `/api/media/cover/${galleryId}`,
  })
})

/**
 * POST /galleries/:galleryId/media/reorder - 批量更新排序
 */
adminMediaRoutes.post('/galleries/:galleryId/media/reorder', async (c) => {
  const db = c.env.DB
  const galleryId = c.req.param('galleryId')
  const userId = c.get('userId')!

  const body = await c.req.json<{ order: Array<{ assetId: string; sortOrder: number }> }>()
  if (!body.order || body.order.length === 0) {
    return errorJson(c, 400, '排序数据为空')
  }

  // 批量更新 sort_order
  const stmt = db.prepare('UPDATE media_assets SET sort_order = ? WHERE id = ? AND gallery_id = ?')
  const batch = body.order.map((item) => stmt.bind(item.sortOrder, item.assetId, galleryId))
  await db.batch(batch)

  await db
    .prepare("UPDATE galleries SET updated_at = datetime('now') WHERE id = ?")
    .bind(galleryId)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'reorder_media',
    targetType: 'gallery',
    targetId: galleryId,
    afterValue: { count: body.order.length },
  })

  return c.json({ success: true })
})

// ============================================================
// 单个媒体资源路由
// ============================================================

/**
 * PATCH /media/:assetId - 修改媒体属性（VIP 等级、排序、角色）
 */
adminMediaRoutes.patch('/media/:assetId', async (c) => {
  const db = c.env.DB
  const assetId = c.req.param('assetId')
  const userId = c.get('userId')!

  const body = await c.req.json<{
    requiredRank?: number
    sortOrder?: number
    role?: string
  }>()

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
  if (!asset) return errorJson(c, 404, '媒体资源不存在')

  const updates: string[] = []
  const values: unknown[] = []

  if (body.requiredRank !== undefined) {
    if (![0, 10, 20].includes(body.requiredRank)) {
      return errorJson(c, 400, '无效的会员等级，允许值: 0, 10, 20')
    }
    updates.push('required_rank = ?')
    values.push(body.requiredRank)
  }
  if (body.sortOrder !== undefined) {
    updates.push('sort_order = ?')
    values.push(body.sortOrder)
  }
  if (body.role !== undefined) {
    if (!['content', 'cover', 'preview', 'full'].includes(body.role)) {
      return errorJson(c, 400, '无效的角色')
    }
    updates.push('role = ?')
    values.push(body.role)
  }

  if (updates.length === 0) return errorJson(c, 400, '无修改内容')

  values.push(assetId)
  await db
    .prepare(`UPDATE media_assets SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  await writeAuditLog(db, {
    adminId: userId,
    action: 'update_media',
    targetType: 'media_asset',
    targetId: assetId,
    beforeValue: { requiredRank: asset.required_rank, sortOrder: asset.sort_order, role: asset.role },
    afterValue: body,
  })

  return c.json({
    assetId,
    requiredRank: body.requiredRank ?? asset.required_rank,
    sortOrder: body.sortOrder ?? asset.sort_order,
    role: body.role ?? asset.role,
  })
})

/**
 * DELETE /media/:assetId - 删除单个媒体（R2 + DB）
 */
adminMediaRoutes.delete('/media/:assetId', async (c) => {
  const db = c.env.DB
  const r2 = c.env.R2
  const assetId = c.req.param('assetId')
  const userId = c.get('userId')!

  const asset = await db
    .prepare('SELECT id, gallery_id, r2_key, stream_uid, type FROM media_assets WHERE id = ?')
    .bind(assetId)
    .first<{
      id: string
      gallery_id: string
      r2_key: string | null
      stream_uid: string | null
      type: string
    }>()
  if (!asset) return errorJson(c, 404, '媒体资源不存在')

  // 删除 R2 对象（外部 URL 不删除）
  if (asset.r2_key && !asset.r2_key.startsWith('http')) {
    try {
      await r2.delete(asset.r2_key)
    } catch {
      // R2 删除失败不阻断
    }
  }

  // 删除 DB 记录
  await db.prepare('DELETE FROM media_assets WHERE id = ?').bind(assetId).run()

  // 如果删除的是封面使用的图片，清空 galleries.cover_key
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

  return c.json({ success: true })
})
