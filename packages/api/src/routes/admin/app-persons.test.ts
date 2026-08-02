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

describe('App 人物供给管理员路由', () => {
  it('父级后台权限阻止普通用户读取人物候选', async () => {
    const response = await createApp('user').request(
      '/api/admin/app/persons/not-a-person-id',
      {},
      { DB: {} } as unknown as Bindings,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'ADMIN_REQUIRED' })
  })

  it('管理员访问非法人物 ID 时返回稳定业务错误', async () => {
    const response = await createApp('admin').request(
      '/api/admin/app/persons/not-a-person-id',
      {},
      { DB: {} } as unknown as Bindings,
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      code: 'PERSON_NOT_FOUND',
      message: '人物候选不存在',
    })
  })

  it('创建接口在访问数据库前拒绝不完整输入', async () => {
    const response = await createApp('admin').request('/api/admin/app/persons', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceGalleryId: 'gal_1' }),
    }, { DB: {} } as unknown as Bindings)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
