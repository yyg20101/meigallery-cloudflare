import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { appV2Routes } from './app-v2'

function createApp(db: unknown = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('appRequestId', 'req_app_test')
    await next()
  })
  app.route('/api/v2', appV2Routes)
  return { app, env: { DB: db, APP_ENV: 'development' } as unknown as Bindings }
}

describe('App API v2 路由契约', () => {
  it('bootstrap 默认关闭未配置的登录、消息、支付和系统推送能力', async () => {
    const { app, env } = createApp()
    const response = await app.fetch(
      new Request('https://api.test/api/v2/app/bootstrap'),
      env,
      {} as ExecutionContext,
    )
    const body = await response.json<{
      data: { capabilities: Record<string, boolean> }
      meta: { requestId: string; apiVersion: string; contractVersion: string }
    }>()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-contract-version')).toBe('1.2.0')
    expect(body.data.capabilities).toEqual({
      discovery: true,
      auth: false,
      messaging: false,
      payments: false,
      systemPush: false,
    })
    expect(body.meta).toMatchObject({
      requestId: 'req_app_test',
      apiVersion: '2',
      contractVersion: '1.2.0',
    })
  })

  it('非法排序和与筛选不匹配的游标以稳定错误码拒绝', async () => {
    const { app, env } = createApp()
    const invalidSort = await app.fetch(
      new Request('https://api.test/api/v2/discovery/feed?sort=random'),
      env,
      {} as ExecutionContext,
    )
    expect(await invalidSort.json()).toMatchObject({
      error: { code: 'INVALID_DISCOVERY_SORT', retryable: false },
    })

    const invalidCursor = await app.fetch(
      new Request('https://api.test/api/v2/discovery/feed?cursor=not-a-valid-cursor'),
      env,
      {} as ExecutionContext,
    )
    expect(await invalidCursor.json()).toMatchObject({
      error: { code: 'INVALID_CURSOR', retryable: false },
    })
  })

  it('非法或不可见人物统一返回安全的不存在响应', async () => {
    const { app, env } = createApp()
    const response = await app.fetch(
      new Request('https://api.test/api/v2/person-profiles/legacy-1'),
      env,
      {} as ExecutionContext,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'PROFILE_NOT_AVAILABLE', retryable: false },
    })
  })

  it('OpenAPI 同步公共发现与默认关闭的账号访问路径', () => {
    const contract = readFileSync(
      new URL('../../../../contracts/app-api-v2.openapi.yaml', import.meta.url),
      'utf8',
    )
    expect(contract).toContain('/api/v2/app/bootstrap:')
    expect(contract).toContain('/api/v2/discovery/feed:')
    expect(contract).toContain('/api/v2/discovery/regions:')
    expect(contract).toContain('/api/v2/person-profiles/{profileId}:')
    expect(contract).toContain('/api/v2/auth/email-challenges:')
    expect(contract).toContain('/api/v2/auth/turnstile:')
    expect(contract).toContain('/api/v2/auth/turnstile/result:')
    expect(contract).toContain('/api/v2/auth/register:')
    expect(contract).toContain('/api/v2/auth/login:')
    expect(contract).toContain('/api/v2/auth/refresh:')
    expect(contract).toContain('/api/v2/auth/logout:')
    expect(contract).toContain('/api/v2/me:')
    expect(contract).toContain('/api/v2/me/devices:')
  })
})
