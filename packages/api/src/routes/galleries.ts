import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const galleryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/galleries - 图库列表
galleryRoutes.get('/', async (c) => {
  // TODO: 实现图库列表查询
  return c.json({ data: [], total: 0, page: 1, pageSize: 20 })
})

// GET /api/galleries/:slug - 图库详情
galleryRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  // TODO: 实现图库详情查询
  return c.json({ message: `图库 ${slug} 详情待实现` }, 501)
})
