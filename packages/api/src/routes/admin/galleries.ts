import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'

export const adminGalleryRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminGalleryRoutes.get('/', async (c) => {
  return c.json({ data: [], total: 0, page: 1, pageSize: 20 })
})

adminGalleryRoutes.post('/', async (c) => {
  return c.json({ message: '创建图库待实现' }, 501)
})

adminGalleryRoutes.patch('/:id', async (c) => {
  return c.json({ message: '编辑图库待实现' }, 501)
})

adminGalleryRoutes.post('/:id/publish', async (c) => {
  return c.json({ message: '发布图库待实现' }, 501)
})

adminGalleryRoutes.post('/:id/unpublish', async (c) => {
  return c.json({ message: '下架图库待实现' }, 501)
})
