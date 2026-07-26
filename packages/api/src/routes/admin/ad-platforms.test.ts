import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { PlatformConnectionError } from '../../services/ad-platform/connection-service'
import { adminAdPlatformRoutes } from './ad-platforms'

const mocks = vi.hoisted(() => ({
  getPlatformConnection: vi.fn(),
  listPlatformConnections: vi.fn(),
  savePlatformConnection: vi.fn(),
  testPlatformConnection: vi.fn(),
  auditRuns: [] as Array<{ sql: string; params: unknown[] }>,
}))

vi.mock('../../services/ad-platform/connection-service', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/ad-platform/connection-service')>(),
  getPlatformConnection: mocks.getPlatformConnection,
  listPlatformConnections: mocks.listPlatformConnections,
  savePlatformConnection: mocks.savePlatformConnection,
}))

vi.mock('../../services/ad-platform/connection-diagnostics', () => ({
  testPlatformConnection: mocks.testPlatformConnection,
}))

const env = {
  APP_ENV: 'production',
  SITE_URL: 'https://gallery.example.test',
  CORS_ORIGIN: 'https://gallery.example.test',
  DB: {
    prepare(sql: string) {
      let params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params = values
          return this
        },
        async run() {
          mocks.auditRuns.push({ sql, params })
          return { meta: { changes: 1 } }
        },
      }
    },
  },
} as unknown as Bindings

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auditRuns.length = 0
  mocks.listPlatformConnections.mockResolvedValue([])
  mocks.getPlatformConnection.mockResolvedValue(null)
  mocks.savePlatformConnection.mockImplementation(async (_env, command) => ({ ...command, connectionId: `conn_${command.provider}` }))
  mocks.testPlatformConnection.mockImplementation(async (_env, input) => ({
    provider: input.provider,
    ok: true,
    testedAt: '2026-07-26T00:00:00.000Z',
    testEventsSent: 2,
    externalEventIds: [],
    requestIds: [],
  }))
})

describe('通用广告平台连接路由', () => {
  it('列表、单个平台和不存在状态使用统一只读响应', async () => {
    mocks.listPlatformConnections.mockResolvedValueOnce([{ provider: 'meta' }])
    mocks.getPlatformConnection
      .mockResolvedValueOnce({ provider: 'meta', connectionId: 'conn_meta' })
      .mockResolvedValueOnce(null)

    const [list, found, missing, unsupported] = await Promise.all([
      request(createApp('admin'), '/platforms', { method: 'GET' }),
      request(createApp('admin'), '/platforms/meta', { method: 'GET' }),
      request(createApp('admin'), '/platforms/tiktok', { method: 'GET' }),
      request(createApp('admin'), '/platforms/unknown', { method: 'GET' }),
    ])

    expect(list.status).toBe(200)
    expect((await found.json()).data.connectionId).toBe('conn_meta')
    expect(missing.status).toBe(404)
    expect(unsupported.status).toBe(404)
    expect(list.headers.get('Cache-Control')).toBe('no-store')
  })

  it('连接读取错误按可恢复性返回稳定状态', async () => {
    mocks.listPlatformConnections.mockRejectedValueOnce(new PlatformConnectionError('AD_PLATFORM_CONNECTION_READ_FAILED'))
    mocks.getPlatformConnection.mockRejectedValueOnce(new PlatformConnectionError('AD_PLATFORM_CONNECTION_STATE_INVALID'))

    const [unavailable, conflict] = await Promise.all([
      request(createApp('admin'), '/platforms', { method: 'GET' }),
      request(createApp('admin'), '/platforms/meta', { method: 'GET' }),
    ])
    expect(unavailable.status).toBe(503)
    expect(conflict.status).toBe(409)
  })

  it.each([
    ['meta', { provider: 'meta', pixelId: '123456789012345' }, 'access_token'],
    ['tiktok', { provider: 'tiktok', pixelCode: 'ABCDEF123456' }, 'access_token'],
    ['google', { provider: 'google', tagId: 'AW-123456789', customerId: '1234567890', cloudProjectId: 'gallery-project' }, 'service_account_json'],
  ] as const)('%s 使用同一个通用保存命令', async (provider, publicConfig, credentialType) => {
    const response = await request(createApp('owner'), `/platforms/${provider}`, {
      method: 'PATCH',
      body: JSON.stringify(connectionBody(publicConfig, credentialType)),
    })

    expect(response.status).toBe(200)
    expect(mocks.savePlatformConnection).toHaveBeenCalledWith(env, expect.objectContaining({
      provider,
      publicConfig,
      actorId: 7,
      credential: { type: credentialType, plaintext: 'credential-value' },
    }))
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('连接测试同步返回结果，重复调用使用同一无状态入口', async () => {
    const app = createApp('owner')
    const first = await request(app, '/platforms/meta/test', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST90001' }),
    })
    const second = await request(app, '/platforms/meta/test', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST90001' }),
    })

    expect([first.status, second.status]).toEqual([200, 200])
    expect(mocks.testPlatformConnection).toHaveBeenNthCalledWith(1, env, { provider: 'meta', testEventCode: 'TEST90001' })
    expect(mocks.testPlatformConnection).toHaveBeenNthCalledWith(2, env, { provider: 'meta', testEventCode: 'TEST90001' })
    expect(mocks.auditRuns).toHaveLength(2)
    expect(mocks.auditRuns.every(item =>
      item.sql.includes('test_attribution_platform_connection')
      && item.params[1] === 7
      && item.params[2] === 'conn_meta'
      && item.params[3] === '{"provider":"meta"}',
    )).toBe(true)
  })

  it('连接测试允许省略临时测试码，并拒绝额外字段', async () => {
    const [test, badTest] = await Promise.all([
      request(createApp('owner'), '/platforms/google/test', { method: 'POST', body: '{}' }),
      request(createApp('owner'), '/platforms/meta/test', {
        method: 'POST', body: JSON.stringify({ testEventCode: '', extra: true }),
      }),
    ])

    expect(test.status).toBe(200)
    expect(badTest.status).toBe(400)
  })

  it.each([
    ['AD_PLATFORM_CONNECTION_TEST_INPUT_INVALID', 400],
    ['AD_PLATFORM_CONNECTION_INVALID', 409],
    ['UNEXPECTED_INTERNAL_DETAIL', 503],
  ] as const)('诊断错误 %s 映射为 %s', async (code, status) => {
    mocks.testPlatformConnection.mockRejectedValueOnce(new Error(code))
    const response = await request(createApp('owner'), '/platforms/meta/test', {
      method: 'POST', body: '{}',
    })
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain('UNEXPECTED_INTERNAL_DETAIL')
  })

  it('生产写操作要求 Owner 和受信任 Origin', async () => {
    const noOrigin = await createApp('owner').request('https://api.example.test/platforms/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token')),
    }, env)
    const nonOwner = await request(createApp('admin'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify(connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token')),
    })

    expect(noOrigin.status).toBe(403)
    expect(await noOrigin.json()).toMatchObject({ code: 'AD_PLATFORM_ORIGIN_FORBIDDEN' })
    expect(nonOwner.status).toBe(403)
    expect(mocks.savePlatformConnection).not.toHaveBeenCalled()
  })

  it('生产写操作拒绝 dev、非法 actor 和未知平台', async () => {
    const body = JSON.stringify(connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token'))
    const [development, invalidActor, unsupported] = await Promise.all([
      request(createApp('owner'), '/platforms/meta', { method: 'PATCH', body }, { ...env, APP_ENV: 'dev' } as Bindings),
      request(createApp('owner', 0), '/platforms/meta', { method: 'PATCH', body }),
      request(createApp('owner'), '/platforms/unknown', { method: 'PATCH', body }),
    ])
    expect(development.status).toBe(409)
    expect(invalidActor.status).toBe(403)
    expect(unsupported.status).toBe(404)
  })

  it('连接保存允许沿用现有凭证，并拒绝非法凭证结构', async () => {
    const withoutCredential = connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token')
    delete (withoutCredential as { credential?: unknown }).credential
    const valid = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH', body: JSON.stringify(withoutCredential),
    })
    const invalid = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify({
        ...connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token'),
        credential: { type: 'password', plaintext: '' },
      }),
    })

    expect(valid.status).toBe(200)
    expect(mocks.savePlatformConnection).toHaveBeenCalledWith(env, expect.not.objectContaining({ credential: expect.anything() }))
    expect(invalid.status).toBe(400)
  })

  it('限制请求体大小并拒绝额外字段', async () => {
    const oversized = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
    })
    const extraField = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify({
        ...connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token'),
        accessToken: 'must-not-be-accepted',
      }),
    })

    expect(oversized.status).toBe(413)
    expect(extraField.status).toBe(400)
    expect(JSON.stringify(await extraField.json())).not.toContain('must-not-be-accepted')
  })

  it('Content-Length、非对象 JSON 和损坏 JSON 都在服务调用前失败', async () => {
    const app = createApp('owner')
    const [declaredLarge, arrayBody, malformed] = await Promise.all([
      app.request('https://api.example.test/platforms/meta', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: 'https://gallery.example.test', 'Content-Length': '70000' },
        body: '{}',
      }, env),
      request(app, '/platforms/meta', { method: 'PATCH', body: '[]' }),
      request(app, '/platforms/meta', { method: 'PATCH', body: '{' }),
    ])

    expect(declaredLarge.status).toBe(413)
    expect(arrayBody.status).toBe(400)
    expect(malformed.status).toBe(400)
  })

  it('不向响应泄露未知内部错误或凭证内容', async () => {
    mocks.savePlatformConnection.mockRejectedValueOnce(new Error('credential-value: internal failure'))
    const response = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify(connectionBody({ provider: 'meta', pixelId: '123456789012345' }, 'access_token')),
    })
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).not.toContain('credential-value')
    expect(body).not.toContain('internal failure')
  })
})

function createApp(role: string | null, userId = 7) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? userId : null)
    c.set('userRole', role)
    await next()
  })
  app.route('/platforms', adminAdPlatformRoutes)
  return app
}

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit,
  bindings = env,
) {
  return app.request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://gallery.example.test',
      ...init.headers,
    },
  }, bindings)
}

function connectionBody(
  publicConfig: Record<string, string>,
  credentialType: 'access_token' | 'service_account_json',
) {
  const google = publicConfig.provider === 'google'
  return {
    enabled: true,
    browserEnabled: true,
    serverEnabled: true,
    publicConfig,
    eventBindings: google
      ? [
          { canonicalEvent: 'Contact', enabled: true, browserDestination: `${publicConfig.tagId}/CONTACT_LABEL`, serverDestination: '123456789' },
          { canonicalEvent: 'CompleteRegistration', enabled: true, browserDestination: `${publicConfig.tagId}/REGISTRATION_LABEL`, serverDestination: '987654321' },
        ]
      : [
          { canonicalEvent: 'Contact', enabled: true },
          { canonicalEvent: 'CompleteRegistration', enabled: true },
        ],
    credential: { type: credentialType, plaintext: 'credential-value' },
  }
}
