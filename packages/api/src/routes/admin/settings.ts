import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'

export const adminSettingsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminSettingsRoutes.get('/', async (c) => {
  return c.json({ message: '站点设置待实现' }, 501)
})

adminSettingsRoutes.patch('/', async (c) => {
  return c.json({ message: '修改站点设置待实现' }, 501)
})
