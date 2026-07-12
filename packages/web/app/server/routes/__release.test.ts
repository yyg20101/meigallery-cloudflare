import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setHeader = vi.fn()
const setResponseStatus = vi.fn()

beforeEach(() => {
  vi.resetModules()
  setHeader.mockReset()
  setResponseStatus.mockReset()
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('setHeader', setHeader)
  vi.stubGlobal('setResponseStatus', setResponseStatus)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Web 发布身份端点', () => {
  it('直接读取 Cloudflare env 并返回 no-store JSON', async () => {
    const { default: handler } = await import('./__release')
    const event = {
      context: {
        cloudflare: {
          env: {
            NUXT_PUBLIC_APP_ENV: 'dev',
            RELEASE_COMMIT: '18dc11e0b0e4797683d4551a93a1f22e53dc4628',
          },
        },
      },
    }

    const body = (handler as (input: unknown) => any)(event)

    expect(body).toMatchObject({
      status: 'ok',
      environment: 'dev',
      commit: '18dc11e0b0e4797683d4551a93a1f22e53dc4628',
      errors: [],
    })
    expect(setHeader).toHaveBeenCalledWith(event, 'Cache-Control', 'no-store')
    expect(setHeader).toHaveBeenCalledWith(event, 'Content-Type', 'application/json; charset=utf-8')
    expect(setResponseStatus).not.toHaveBeenCalled()
  })

  it.each([
    [{ NUXT_PUBLIC_APP_ENV: 'dev' }, 'RELEASE_COMMIT_INVALID'],
    [{ NUXT_PUBLIC_APP_ENV: 'dev', RELEASE_COMMIT: '7c9a180' }, 'RELEASE_COMMIT_INVALID'],
    [{ NUXT_PUBLIC_APP_ENV: 'staging', RELEASE_COMMIT: '18dc11e0b0e4797683d4551a93a1f22e53dc4628' }, 'NUXT_PUBLIC_APP_ENV_INVALID'],
  ])('binding 缺失或非法时返回 unhealthy', async (env, errorCode) => {
    const { default: handler } = await import('./__release')
    const event = { context: { cloudflare: { env } } }

    const body = (handler as (input: unknown) => any)(event)

    expect(body.status).toBe('unhealthy')
    expect(body.errors).toContain(errorCode)
    expect(setResponseStatus).toHaveBeenCalledWith(event, 503)
  })
})
