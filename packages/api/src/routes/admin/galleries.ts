import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'
import {
  AdminGalleryError,
  archiveAdminGallery,
  createAdminGallery,
  getAdminGalleryDetail,
  listAdminGalleries,
  processAdminGalleryBatch,
  publishAdminGallery,
  unpublishAdminGallery,
  updateAdminGallery,
  type AdminGalleryBatchRequest,
  type AdminGalleryCreateInput,
  type AdminGalleryUpdateInput,
} from '../../services/admin-galleries'
import { errorJson } from '../../utils/api-error'

export const adminGalleryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function galleryErrorJson(c: Parameters<typeof errorJson>[0], error: unknown) {
  if (error instanceof AdminGalleryError) {
    return errorJson(c, error.status as Parameters<typeof errorJson>[1], error.message)
  }
  throw error
}

/**
 * POST /batch - 批量操作
 */
adminGalleryRoutes.post('/batch', async (c) => {
  try {
    const body = await c.req.json<AdminGalleryBatchRequest>()
    const result = await processAdminGalleryBatch(
      c.env.DB,
      c.env.R2,
      c.get('userId')!,
      c.get('userRole')!,
      body,
    )
    return c.json(result)
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})

/**
 * GET / - 管理员图库列表（支持状态筛选 + 搜索 + 标签过滤）
 */
adminGalleryRoutes.get('/', async (c) => {
  const result = await listAdminGalleries(c.env.DB, {
    page: c.req.query('page'),
    pageSize: c.req.query('pageSize'),
    status: c.req.query('status'),
    search: c.req.query('search'),
    tag: c.req.query('tag'),
    sort: c.req.query('sort'),
  })

  return c.json(result)
})

/**
 * GET /:id - 图库详情（含全部字段和标签）
 */
adminGalleryRoutes.get('/:id', async (c) => {
  try {
    const gallery = await getAdminGalleryDetail(c.env.DB, c.req.param('id'))
    return c.json({ data: gallery })
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})

/**
 * POST / - 创建图库
 */
adminGalleryRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json<AdminGalleryCreateInput>()
    const data = await createAdminGallery(c.env.DB, c.get('userId')!, c.get('userRole')!, body)
    return c.json({ data }, 201)
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})

/**
 * PATCH /:id - 更新图库
 */
adminGalleryRoutes.patch('/:id', async (c) => {
  try {
    const body = await c.req.json<AdminGalleryUpdateInput>()
    const data = await updateAdminGallery(c.env.DB, c.get('userId')!, c.req.param('id'), body)
    return c.json({ data })
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})

/**
 * POST /:id/publish - 发布图库
 */
adminGalleryRoutes.post('/:id/publish', async (c) => {
  try {
    const data = await publishAdminGallery(c.env.DB, c.get('userId')!, c.req.param('id'))
    return c.json({ data })
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})

/**
 * POST /:id/unpublish - 下架图库
 */
adminGalleryRoutes.post('/:id/unpublish', async (c) => {
  try {
    const data = await unpublishAdminGallery(c.env.DB, c.get('userId')!, c.req.param('id'))
    return c.json({ data })
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})

/**
 * DELETE /:id - 归档图库（软删除）
 */
adminGalleryRoutes.delete('/:id', async (c) => {
  try {
    const data = await archiveAdminGallery(c.env.DB, c.get('userId')!, c.req.param('id'))
    return c.json({ data })
  } catch (error) {
    return galleryErrorJson(c, error)
  }
})
