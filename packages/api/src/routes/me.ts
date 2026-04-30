import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const meRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/me - 当前用户信息和会员状态
meRoutes.get('/', async (c) => {
  // TODO: 实现当前用户查询
  return c.json({ message: '当前用户信息待实现' }, 501)
})
