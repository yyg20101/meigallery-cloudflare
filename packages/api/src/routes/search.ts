import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const searchRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/search - 组合搜索
searchRoutes.get('/', async (c) => {
  // TODO: 实现搜索逻辑
  return c.json({ data: [], total: 0, page: 1, pageSize: 20 })
})
