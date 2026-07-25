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
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body).toMatchObject({
      statusCode: 403,
      message: '需要管理员权限',
      code: 'ADMIN_REQUIRED',
    })
  })

  it('允许管理员访问后台概览', async () => {
    const res = await createApp('admin').request('/api/admin/dashboard', {}, { DB: db } as unknown as Bindings)

    expect(res.status).toBe(200)
  })

  it.each([
    [null, 401, 0],
    ['admin', 403, 0],
    ['owner', 200, 1],
  ] as const)(
    '归因独立控制面在真实挂载下 role=%s 返回 %s',
    async (role, status, calls) => {
      let bindingCalls = 0
      const res = await createApp(role).request(
        '/api/admin/attribution-runtime/connections',
        {},
        {
          DB: db,
          ATTRIBUTION: {
            fetch: async () => {
              bindingCalls += 1
              return Response.json({ data: [] })
            },
          },
        } as unknown as Bindings,
      )

      expect(res.status).toBe(status)
      expect(bindingCalls).toBe(calls)
    },
  )
})
