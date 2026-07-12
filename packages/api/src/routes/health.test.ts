import { describe, expect, it } from 'vitest'
import type { Bindings } from '../index'
import { healthRoutes } from './health'

const COMMIT = '18dc11e0b0e4797683d4551a93a1f22e53dc4628'

function createEnv(overrides: Partial<Bindings> = {}) {
  return {
    APP_ENV: 'dev',
    RELEASE_COMMIT: COMMIT,
    DB: {
      prepare() {
        return { first: async () => ({ ok: 1 }) }
      },
    },
    ...overrides,
  } as unknown as Bindings
}

describe('API 发布身份健康检查', () => {
  it('返回真实环境和 40 位发布 commit，且禁止缓存', async () => {
    const response = await healthRoutes.request('/', {}, createEnv())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({
      status: 'ok',
      db: 'ok',
      environment: 'dev',
      commit: COMMIT,
      errors: [],
    })
  })

  it.each([
    ['缺少 RELEASE_COMMIT', { RELEASE_COMMIT: undefined }, 'RELEASE_COMMIT_INVALID'],
    ['RELEASE_COMMIT 非 40 位 SHA', { RELEASE_COMMIT: '7c9a180' }, 'RELEASE_COMMIT_INVALID'],
    ['APP_ENV 非法', { APP_ENV: 'unknown' }, 'APP_ENV_INVALID'],
    ['D1 不可用', { DB: { prepare: () => ({ first: async () => { throw new Error('db unavailable') } }) } }, 'DB_UNHEALTHY'],
  ] as const)('%s 时显式返回 unhealthy', async (_label, overrides, errorCode) => {
    const response = await healthRoutes.request('/', {}, createEnv(overrides as Partial<Bindings>))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('unhealthy')
    expect(body.errors).toContain(errorCode)
    if (errorCode === 'RELEASE_COMMIT_INVALID') expect(body.commit).toBeNull()
  })
})
