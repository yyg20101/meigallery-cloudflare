import { describe, expect, it } from 'vitest'
import { ATTRIBUTION_SERVICE_BINDING } from '@meigallery/shared/constants'
import { app, attributionServiceApp } from './index'
import type { AttributionBindings } from './env'

function createBindings(
  overrides: Partial<AttributionBindings> = {},
): AttributionBindings {
  const queue = {
    send: async () => undefined,
  } as unknown as AttributionBindings['META_QUEUE']
  return {
    APP_ENV: 'local',
    ATTRIBUTION_PUBLIC_ORIGINS: 'http://localhost:3000',
    ATTRIBUTION_COOKIE_DOMAIN: '',
    DB: {} as D1Database,
    ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT:
      'test-credential-master-key-with-32-bytes',
    ATTRIBUTION_SIGNING_KEY_CURRENT:
      'test-signing-key-current-with-32-bytes',
    ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT:
      'test-data-encryption-key-with-32-bytes',
    META_QUEUE: queue,
    TIKTOK_QUEUE: queue,
    GOOGLE_QUEUE: queue,
    ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW: {
      createBatch: async () => [],
    } as unknown as AttributionBindings[
      'ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW'
    ],
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

  it('公网默认入口不挂载内部 Service Binding 路由', async () => {
    const response = await app.request(
      '/internal/v1/registration-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      createBindings(),
    )

    expect(response.status).toBe(404)
  })

  it('命名 Service Binding 入口按固定 /internal/v1 前缀挂载', async () => {
    const response = await attributionServiceApp.request(
      '/internal/v1/registration-events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      createBindings(),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'ATTRIBUTION_REGISTRATION_EVENT_INVALID',
    })
  })

  it('公共网络直接访问管理路由始终返回 404', async () => {
    const response = await app.request(
      '/admin/attribution/connections',
      {
        headers: {
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID]: '1',
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE]: 'owner',
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID]:
            '019f931b-132e-77c2-b06d-9378e4f6d680',
        },
      },
      createBindings(),
    )

    expect(response.status).toBe(404)
  })

  it('命名入口只接受主 API 注入的可信 Owner 身份', async () => {
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        all: async () => ({ results: [] }),
      }),
    }
    const noActor = await attributionServiceApp.request(
      '/admin/attribution/connections',
      {},
      createBindings({ DB: db as unknown as D1Database }),
    )
    const adminActor = await attributionServiceApp.request(
      '/admin/attribution/connections',
      {
        headers: {
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID]: '2',
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE]: 'admin',
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID]:
            '019f931b-132e-77c2-b06d-9378e4f6d680',
        },
      },
      createBindings({ DB: db as unknown as D1Database }),
    )
    const ownerActor = await attributionServiceApp.request(
      '/admin/attribution/connections',
      {
        headers: {
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ID]: '1',
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.ACTOR_ROLE]: 'owner',
          [ATTRIBUTION_SERVICE_BINDING.HEADERS.REQUEST_ID]:
            '019f931b-132e-77c2-b06d-9378e4f6d680',
        },
      },
      createBindings({ DB: db as unknown as D1Database }),
    )

    expect(noActor.status).toBe(404)
    expect(adminActor.status).toBe(403)
    expect(ownerActor.status).toBe(200)
    expect(await ownerActor.json()).toEqual({ data: [] })
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
    ['生产环境 HTTP Origin', {
      APP_ENV: 'production' as const,
      ATTRIBUTION_PUBLIC_ORIGINS: 'http://example.com',
      ATTRIBUTION_COOKIE_DOMAIN: '.example.com',
    }],
    ['开发环境远程 HTTP Origin', {
      APP_ENV: 'dev' as const,
      ATTRIBUTION_PUBLIC_ORIGINS: 'http://dev.example.com',
      ATTRIBUTION_COOKIE_DOMAIN: '',
    }],
    ['空凭证主密钥', { ATTRIBUTION_CREDENTIAL_MASTER_KEY_CURRENT: ' ' }],
    ['空签名密钥', { ATTRIBUTION_SIGNING_KEY_CURRENT: ' ' }],
    ['过短签名密钥', { ATTRIBUTION_SIGNING_KEY_CURRENT: 'weak' }],
    ['空数据加密密钥', {
      ATTRIBUTION_DATA_ENCRYPTION_KEY_CURRENT: ' ',
    }],
    ['过短 previous 密钥', {
      ATTRIBUTION_SIGNING_KEY_PREVIOUS: 'weak',
    }],
    ['缺少 Meta Queue', {
      META_QUEUE: undefined,
    }],
    ['缺少 TikTok Queue', {
      TIKTOK_QUEUE: undefined,
    }],
    ['缺少 Google Queue', {
      GOOGLE_QUEUE: undefined,
    }],
    ['缺少候选验证 Workflow', {
      ATTRIBUTION_CANDIDATE_VALIDATION_WORKFLOW: undefined,
    }],
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
