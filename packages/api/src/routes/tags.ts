import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const tagRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/tags - 标签列表（按类型分组）
tagRoutes.get('/', async (c) => {
  // TODO: 实现标签列表查询
  return c.json({ data: [] })
})
