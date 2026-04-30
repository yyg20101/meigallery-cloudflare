import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'

export const adminTagRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminTagRoutes.get('/', async (c) => {
  return c.json({ data: [] })
})

adminTagRoutes.post('/', async (c) => {
  return c.json({ message: '创建标签待实现' }, 501)
})

adminTagRoutes.patch('/:id', async (c) => {
  return c.json({ message: '编辑标签待实现' }, 501)
})
