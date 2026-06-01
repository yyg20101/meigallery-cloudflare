import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
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
