import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

export const healthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

healthRoutes.get('/', async (c) => {
  let dbStatus = 'unknown'

  try {
    const result = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>()
    dbStatus = result?.ok === 1 ? 'ok' : 'error'
  } catch {
    dbStatus = 'unavailable'
  }

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: dbStatus,
  })
})
