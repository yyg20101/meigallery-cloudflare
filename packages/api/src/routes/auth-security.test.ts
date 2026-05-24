import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { authRoutes } from './auth'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/auth', authRoutes)
  return app
}

describe('认证接口生产安全配置', () => {
  it('生产环境缺少 Turnstile Secret 时拒绝登录', async () => {
    const res = await createApp().request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@example.com', password: 'password123' }),
    }, { APP_ENV: 'production', TURNSTILE_SECRET_KEY: '' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.message).toContain('人机验证配置缺失')
  })
})
