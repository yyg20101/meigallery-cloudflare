import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'

export const adminImportRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminImportRoutes.post('/', async (c) => {
  return c.json({ message: '创建导入任务待实现' }, 501)
})

adminImportRoutes.get('/:id', async (c) => {
  return c.json({ message: '导入任务详情待实现' }, 501)
})
