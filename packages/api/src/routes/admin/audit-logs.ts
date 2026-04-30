import { Hono } from 'hono'
import type { Bindings, Variables } from '../../index'

export const adminAuditRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminAuditRoutes.get('/', async (c) => {
  return c.json({ data: [], total: 0, page: 1, pageSize: 20 })
})
