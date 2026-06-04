import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import { isExternalMediaKey, safeExternalMediaUrl } from '../../utils/cover-url'
import {
  AdminMediaError,
  deleteAdminMediaAsset,
  listAdminGalleryMedia,
  reorderAdminGalleryMedia,
  setAdminGalleryCoverFromAsset,
  setAdminGalleryCoverFromFile,
  updateAdminMediaAsset,
  uploadAdminGalleryMedia,
} from '../../services/admin-media'
import { errorJson } from '../../utils/api-error'
import { isExpectedGalleryCoverKey, isExpectedGalleryMediaKey } from '../../utils/media-keys'

export const adminMediaRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function handleAdminMediaError(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AdminMediaError) {
    return errorJson(c, error.status as Parameters<typeof errorJson>[1], error.message)
  }
  throw error
}

/**
 * GET /galleries/:galleryId/media - 获取图库所有媒体资源
 */
adminMediaRoutes.get('/galleries/:galleryId/media', async (c) => {
  try {
    const result = await listAdminGalleryMedia(c.env.DB, c.req.param('galleryId'))
    return c.json(result)
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * GET /galleries/:galleryId/cover - 管理员封面预览
 * 不要求图库已发布，便于编辑草稿图库时直接查看封面
 */
adminMediaRoutes.get('/galleries/:galleryId/cover', async (c) => {
  try {
    const galleryId = c.req.param('galleryId')
    const gallery = await c.env.DB
      .prepare('SELECT cover_key FROM galleries WHERE id = ?')
      .bind(galleryId)
      .first<{ cover_key: string | null }>()

    if (!gallery?.cover_key) {
      return c.json({ statusCode: 404, message: '封面不存在' }, 404)
    }

    if (isExternalMediaKey(gallery.cover_key)) {
      const safeUrl = safeExternalMediaUrl(gallery.cover_key)
      if (!safeUrl) {
        return c.json({ statusCode: 404, message: '封面不存在' }, 404)
      }
      return c.redirect(safeUrl, 302)
    }

    if (!isExpectedGalleryCoverKey(gallery.cover_key, galleryId)) {
      return c.json({ statusCode: 404, message: '封面不存在' }, 404)
    }

    const object = await c.env.R2.get(gallery.cover_key)
    if (!object) {
      return c.json({ statusCode: 404, message: '封面文件不存在' }, 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'private, max-age=600')
    headers.set('ETag', object.httpEtag)

    return new Response(object.body, { headers })
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * GET /media/:assetId/thumbnail - 管理员预览缩略图
 * 不要求图库已发布，便于编辑草稿图库时直接查看图片
 */
adminMediaRoutes.get('/media/:assetId/thumbnail', async (c) => {
  try {
    const assetId = c.req.param('assetId')
    const asset = await c.env.DB
      .prepare(`
        SELECT ma.gallery_id, ma.r2_key, ma.type, ma.upload_status
        FROM media_assets ma
        WHERE ma.id = ?
      `)
      .bind(assetId)
      .first<{ gallery_id: string; r2_key: string | null; type: string; upload_status: string }>()

    if (!asset || asset.type !== 'image' || asset.upload_status !== 'completed' || !asset.r2_key) {
      return c.json({ statusCode: 404, message: '资源不存在' }, 404)
    }
    if (!isExpectedGalleryMediaKey(asset.r2_key, asset.gallery_id, assetId)) {
      return c.json({ statusCode: 404, message: '文件不存在' }, 404)
    }

    const object = await c.env.R2.get(asset.r2_key)
    if (!object) {
      return c.json({ statusCode: 404, message: '文件不存在' }, 404)
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'private, max-age=600')
    headers.set('ETag', object.httpEtag)

    return new Response(object.body, { headers })
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * POST /galleries/:galleryId/media/upload - 图片上传（multipart/form-data）
 * 支持多文件，格式：JPG/PNG/WebP，单张 <= 10MB
 */
adminMediaRoutes.post('/galleries/:galleryId/media/upload', async (c) => {
  try {
    const formData = await c.req.formData()
    const files = formData.getAll('files') as unknown as File[]
    const result = await uploadAdminGalleryMedia(
      c.env.DB,
      c.env.R2,
      c.get('userId')!,
      c.req.param('galleryId'),
      files,
    )
    return c.json(result, 201)
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * PATCH /galleries/:galleryId/cover - 设置封面
 * 支持 JSON { assetId } 或 multipart/form-data { file }。
 */
adminMediaRoutes.patch('/galleries/:galleryId/cover', async (c) => {
  try {
    const galleryId = c.req.param('galleryId')
    const userId = c.get('userId')!
    const contentType = c.req.header('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      const result = await setAdminGalleryCoverFromFile(c.env.DB, c.env.R2, userId, galleryId, file)
      return c.json(result)
    }

    const body = await c.req.json<{ assetId?: string }>()
    const result = await setAdminGalleryCoverFromAsset(c.env.DB, userId, galleryId, body.assetId)
    return c.json(result)
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * POST /galleries/:galleryId/media/reorder - 批量更新排序
 */
adminMediaRoutes.post('/galleries/:galleryId/media/reorder', async (c) => {
  try {
    const body = await c.req.json<{ order?: Array<{ assetId: string; sortOrder: number }> }>()
    const result = await reorderAdminGalleryMedia(c.env.DB, c.get('userId')!, c.req.param('galleryId'), body.order)
    return c.json(result)
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * PATCH /media/:assetId - 修改媒体属性（会员等级、排序、角色）
 */
adminMediaRoutes.patch('/media/:assetId', async (c) => {
  try {
    const body = await c.req.json<{ requiredRank?: number; sortOrder?: number; role?: string }>()
    const result = await updateAdminMediaAsset(c.env.DB, c.get('userId')!, c.req.param('assetId'), body)
    return c.json(result)
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})

/**
 * DELETE /media/:assetId - 删除单个媒体（R2 + DB）
 */
adminMediaRoutes.delete('/media/:assetId', async (c) => {
  try {
    const result = await deleteAdminMediaAsset(c.env.DB, c.env.R2, c.get('userId')!, c.req.param('assetId'))
    return c.json(result)
  } catch (error) {
    return handleAdminMediaError(c, error)
  }
})
