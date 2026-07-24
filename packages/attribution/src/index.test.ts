import { describe, expect, it } from 'vitest'
import app from './index'
import type { AttributionBindings } from './env'

function createBindings(
  overrides: Partial<AttributionBindings> = {},
): AttributionBindings {
  return {
    APP_ENV: 'local',
    ATTRIBUTION_PUBLIC_ORIGINS: 'http://localhost:3000',
    ATTRIBUTION_COOKIE_DOMAIN: '',
    DB: {} as D1Database,
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: 'test-key',
    ATTRIBUTION_SIGNING_KEY: 'test-signing-key',
    ...overrides,
  }
}

describe('attribution worker', () => {
  it('健康检查不依赖业务 API', async () => {
    const response = await app.request('/health', {}, createBindings())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      service: 'meigallery-attribution',
      status: 'ok',
      contractVersion: 1,
    })
  })

  it.each([
    ['空 Origin', { ATTRIBUTION_PUBLIC_ORIGINS: '' }],
    ['通配符 Origin', { ATTRIBUTION_PUBLIC_ORIGINS: '*' }],
    ['带路径 Origin', { ATTRIBUTION_PUBLIC_ORIGINS: 'https://example.com/path' }],
    ['生产环境空 Cookie domain', {
      APP_ENV: 'production' as const,
      ATTRIBUTION_PUBLIC_ORIGINS: 'https://example.com',
      ATTRIBUTION_COOKIE_DOMAIN: '',
    }],
    ['空凭证主密钥', { ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: ' ' }],
    ['空签名密钥', { ATTRIBUTION_SIGNING_KEY: ' ' }],
  ])('%s 时 fail closed', async (_label, overrides) => {
    const response = await app.request(
      '/health',
      {},
      createBindings(overrides),
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      service: 'meigallery-attribution',
      status: 'error',
      code: 'ATTRIBUTION_CONFIGURATION_INVALID',
      contractVersion: 1,
    })
  })
})
