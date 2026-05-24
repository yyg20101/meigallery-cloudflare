import { describe, expect, it } from 'vitest'
import app from './index'
import type { Bindings } from './index'

function env(corsOrigin?: string) {
  return {
    APP_ENV: 'production',
    CORS_ORIGIN: corsOrigin,
    DB: {
      prepare() {
        return { first: async () => ({ ok: 1 }) }
      },
    },
  } as unknown as Bindings
}

describe('API CORS 安全配置', () => {
  it('生产环境未配置 CORS_ORIGIN 时不反射任意 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', {
      headers: { Origin: 'https://evil.example' },
    }), env(), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('支持多个明确允许的生产 Origin', async () => {
    const res = await app.fetch(new Request('https://api.test/api/health', {
      headers: { Origin: 'https://www.616618.xyz' },
    }), env('https://616618.xyz,https://www.616618.xyz'), {} as ExecutionContext)

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.616618.xyz')
  })
})
