import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { adminRoutes } from './index'

function createApp(role: string | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 1 : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/admin', adminRoutes)
  return app
}

const db = {
  prepare: () => ({
    first: async () => ({ count: 0 }),
  }),
}

describe('后台父路由鉴权', () => {
  it('拒绝未登录用户访问后台概览', async () => {
    const res = await createApp(null).request('/api/admin/dashboard', {}, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(403)
  })

  it('允许管理员访问后台概览', async () => {
    const res = await createApp('admin').request('/api/admin/dashboard', {}, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
  })
})
