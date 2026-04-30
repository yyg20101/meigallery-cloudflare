import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'

export const adminUserRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminUserRoutes.get('/', async (c) => {
  return c.json({ data: [], total: 0, page: 1, pageSize: 20 })
})

adminUserRoutes.post('/:id/memberships', async (c) => {
  return c.json({ message: '发放会员待实现' }, 501)
})
