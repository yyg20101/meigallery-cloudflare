import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { rateLimiter, resetRateLimitStoreForTest } from './rate-limit'

describe('速率限制中间件', () => {
  beforeEach(() => {
    resetRateLimitStoreForTest()
  })

  it('按限流桶名称隔离不同接口计数', async () => {
    const app = new Hono()
    app.use('/auth/*', rateLimiter({ name: 'auth', keyBy: 'ip', limit: 1, windowMs: 60_000 }))
    app.use('/public/*', rateLimiter({ name: 'public-api', keyBy: 'ip', limit: 1, windowMs: 60_000 }))
    app.get('/auth/login', c => c.text('ok'))
    app.get('/public/galleries', c => c.text('ok'))

    const headers = { 'cf-connecting-ip': '203.0.113.10' }

    expect((await app.request('/auth/login', { headers })).status).toBe(200)
    expect((await app.request('/auth/login', { headers })).status).toBe(429)
    expect((await app.request('/public/galleries', { headers })).status).toBe(200)
  })

  it('按 userId 隔离用户级计数', async () => {
    const app = new Hono()
    app.use('/media/:user/*', async (c, next) => {
      c.set('userId', c.req.param('user'))
      await next()
    })
    app.use('/media/*', rateLimiter({ name: 'media-sign', keyBy: 'user', limit: 1, windowMs: 60_000 }))
    app.get('/media/:user/access', c => c.text('ok'))

    expect((await app.request('/media/1/access')).status).toBe(200)
    expect((await app.request('/media/1/access')).status).toBe(429)
    expect((await app.request('/media/2/access')).status).toBe(200)
  })

  it('按 session cookie 隔离管理员计数', async () => {
    const app = new Hono()
    app.use('/admin/*', rateLimiter({ name: 'admin-api', keyBy: 'session', limit: 1, windowMs: 60_000 }))
    app.get('/admin/dashboard', c => c.text('ok'))

    expect((await app.request('/admin/dashboard', { headers: { cookie: 'mei_session=session-a' } })).status).toBe(200)
    expect((await app.request('/admin/dashboard', { headers: { cookie: 'mei_session=session-a' } })).status).toBe(429)
    expect((await app.request('/admin/dashboard', { headers: { cookie: 'mei_session=session-b' } })).status).toBe(200)
  })
})
