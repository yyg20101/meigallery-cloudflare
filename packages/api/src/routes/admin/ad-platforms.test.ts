import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
import { PlatformConnectionError } from '../../services/ad-platform/connection-service'
import { adminAdPlatformRoutes } from './ad-platforms'

const mocks = vi.hoisted(() => ({
  getPlatformConnection: vi.fn(),
  listPlatformConnections: vi.fn(),
  savePlatformConnection: vi.fn(),
  getPlatformVerification: vi.fn(),
  startPlatformVerification: vi.fn(),
  submitPlatformVerificationEvidence: vi.fn(),
}))

vi.mock('../../services/ad-platform/connection-service', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/ad-platform/connection-service')>(),
  getPlatformConnection: mocks.getPlatformConnection,
  listPlatformConnections: mocks.listPlatformConnections,
  savePlatformConnection: mocks.savePlatformConnection,
}))

vi.mock('../../workflows/ad-platform-verification', () => ({
  getPlatformVerification: mocks.getPlatformVerification,
  startPlatformVerification: mocks.startPlatformVerification,
  submitPlatformVerificationEvidence: mocks.submitPlatformVerificationEvidence,
}))

const env = {
  APP_ENV: 'production',
  SITE_URL: 'https://gallery.example.test',
  CORS_ORIGIN: 'https://gallery.example.test',
  DB: {},
} as unknown as Bindings

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listPlatformConnections.mockResolvedValue([])
  mocks.getPlatformConnection.mockResolvedValue(null)
  mocks.savePlatformConnection.mockImplementation(async (_env, command) => ({ ...command, connectionId: `conn_${command.provider}` }))
  mocks.startPlatformVerification.mockImplementation(async (_env, input) => ({ id: `verify:${input.provider}:1`, attempt: input.reverify ? 2 : 1 }))
  mocks.getPlatformVerification.mockResolvedValue(null)
  mocks.submitPlatformVerificationEvidence.mockResolvedValue({ id: 'verify:meta:1', status: 'awaiting_human_evidence' })
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
    ['meta', { provider: 'meta', pixelId: '1277657707436781' }, 'access_token'],
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

  it('重复验证与重新验证只通过通用 reverify 标志区分', async () => {
    const app = createApp('owner')
    const first = await request(app, '/platforms/meta/verify', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST90001' }),
    })
    const second = await request(app, '/platforms/meta/verify', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST99999' }),
    })
    const restarted = await request(app, '/platforms/meta/reverify', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST90002' }),
    })

    expect([first.status, second.status, restarted.status]).toEqual([202, 202, 202])
    expect(mocks.startPlatformVerification).toHaveBeenNthCalledWith(1, env, expect.objectContaining({ provider: 'meta', actorId: 7, reverify: false }))
    expect(mocks.startPlatformVerification).toHaveBeenNthCalledWith(2, env, expect.objectContaining({ provider: 'meta', actorId: 7, reverify: false }))
    expect(mocks.startPlatformVerification).toHaveBeenNthCalledWith(3, env, expect.objectContaining({ provider: 'meta', actorId: 7, reverify: true }))
  })

  it('人工证据带审计 actor 发送给所属 Workflow', async () => {
    const response = await request(createApp('owner'), '/platforms/meta/verifications/verify:meta:1/evidence', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true, reference: 'Events Manager 已确认' }),
    })

    expect(response.status).toBe(202)
    expect(mocks.submitPlatformVerificationEvidence).toHaveBeenCalledWith(env, {
      provider: 'meta',
      verificationId: 'verify:meta:1',
      actorId: 7,
      reference: 'Events Manager 已确认',
    })
  })

  it('验证状态支持读取最新记录和指定记录，并拒绝非法编号', async () => {
    mocks.getPlatformVerification
      .mockResolvedValueOnce({ id: 'verify:meta:latest' })
      .mockResolvedValueOnce({ id: 'verify:meta:1' })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('read failed'))

    const [latest, selected, missing, invalid, failed] = await Promise.all([
      request(createApp('admin'), '/platforms/meta/verification', { method: 'GET' }),
      request(createApp('admin'), '/platforms/meta/verifications/verify:meta:1', { method: 'GET' }),
      request(createApp('admin'), '/platforms/meta/verifications/verify:meta:2', { method: 'GET' }),
      request(createApp('admin'), '/platforms/meta/verifications/invalid!', { method: 'GET' }),
      request(createApp('admin'), '/platforms/google/verification', { method: 'GET' }),
    ])

    expect(latest.status).toBe(200)
    expect(selected.status).toBe(200)
    expect(missing.status).toBe(404)
    expect(invalid.status).toBe(400)
    expect(failed.status).toBe(503)
  })

  it('验证和人工证据允许省略临时字段，并拒绝额外或错误字段', async () => {
    const [verify, evidence, badVerify, badEvidence, badId] = await Promise.all([
      request(createApp('owner'), '/platforms/meta/verify', { method: 'POST', body: '{}' }),
      request(createApp('owner'), '/platforms/meta/verifications/verify:meta:1/evidence', {
        method: 'POST', body: JSON.stringify({ confirmed: true }),
      }),
      request(createApp('owner'), '/platforms/meta/verify', {
        method: 'POST', body: JSON.stringify({ testEventCode: '', extra: true }),
      }),
      request(createApp('owner'), '/platforms/meta/verifications/verify:meta:1/evidence', {
        method: 'POST', body: JSON.stringify({ confirmed: false }),
      }),
      request(createApp('owner'), '/platforms/meta/verifications/invalid!/evidence', {
        method: 'POST', body: JSON.stringify({ confirmed: true }),
      }),
    ])

    expect(verify.status).toBe(202)
    expect(evidence.status).toBe(202)
    expect(badVerify.status).toBe(400)
    expect(badEvidence.status).toBe(400)
    expect(badId.status).toBe(400)
  })

  it.each([
    ['AD_PLATFORM_VERIFICATION_NOT_FOUND', 404],
    ['AD_PLATFORM_VERIFICATION_INPUT_INVALID', 400],
    ['AD_PLATFORM_CONNECTION_INVALID', 409],
    ['UNEXPECTED_INTERNAL_DETAIL', 503],
  ] as const)('验证错误 %s 映射为 %s', async (code, status) => {
    mocks.startPlatformVerification.mockRejectedValueOnce(new Error(code))
    const response = await request(createApp('owner'), '/platforms/meta/verify', {
      method: 'POST', body: '{}',
    })
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain('UNEXPECTED_INTERNAL_DETAIL')
  })

  it('生产写操作要求 Owner 和受信任 Origin', async () => {
    const noOrigin = await createApp('owner').request('https://api.example.test/platforms/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token')),
    }, env)
    const nonOwner = await request(createApp('admin'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify(connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token')),
    })

    expect(noOrigin.status).toBe(403)
    expect(await noOrigin.json()).toMatchObject({ code: 'AD_PLATFORM_ORIGIN_FORBIDDEN' })
    expect(nonOwner.status).toBe(403)
    expect(mocks.savePlatformConnection).not.toHaveBeenCalled()
  })

  it('生产写操作拒绝 dev、非法 actor 和未知平台', async () => {
    const body = JSON.stringify(connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token'))
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
    const withoutCredential = connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token')
    delete (withoutCredential as { credential?: unknown }).credential
    const valid = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH', body: JSON.stringify(withoutCredential),
    })
    const invalid = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify({
        ...connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token'),
        credential: { type: 'password', plaintext: '' },
      }),
    })

    expect(valid.status).toBe(200)
    expect(mocks.savePlatformConnection).toHaveBeenCalledWith(env, expect.not.objectContaining({ credential: expect.anything() }))
    expect(invalid.status).toBe(400)
  })

  it('仅将 production Worker 中现有 Meta Secret 一次性迁移到通用凭证库', async () => {
    const migrationEnv = { ...env, META_CAPI_ACCESS_TOKEN: 'existing-worker-secret' } as Bindings
    mocks.savePlatformConnection.mockResolvedValueOnce({
      provider: 'meta', connectionId: 'conn_meta', credential: { configured: true },
    })
    const response = await request(createApp('owner'), '/platforms/meta/migrate-worker-secret', {
      method: 'POST',
      body: JSON.stringify({ pixelId: '1277657707436781' }),
    }, migrationEnv)

    expect(response.status).toBe(201)
    expect(mocks.savePlatformConnection).toHaveBeenCalledWith(migrationEnv, expect.objectContaining({
      provider: 'meta',
      enabled: true,
      mode: 'test',
      browserEnabled: true,
      serverEnabled: true,
      publicConfig: { provider: 'meta', pixelId: '1277657707436781' },
      credential: { type: 'access_token', plaintext: 'existing-worker-secret' },
      rolloutTargetPercentage: 0,
      actorId: 7,
    }))
    expect(await response.text()).not.toContain('existing-worker-secret')
  })

  it('Meta Secret 迁移拒绝重复执行、缺失 Secret 和非法输入', async () => {
    mocks.getPlatformConnection.mockResolvedValueOnce({ connectionId: 'conn_meta' })
    const app = createApp('owner')
    const completed = await request(app, '/platforms/meta/migrate-worker-secret', {
      method: 'POST', body: JSON.stringify({ pixelId: '1277657707436781' }),
    }, { ...env, META_CAPI_ACCESS_TOKEN: 'existing-worker-secret' } as Bindings)
    const missing = await request(app, '/platforms/meta/migrate-worker-secret', {
      method: 'POST', body: JSON.stringify({ pixelId: '1277657707436781' }),
    })
    const invalid = await request(app, '/platforms/meta/migrate-worker-secret', {
      method: 'POST', body: JSON.stringify({ pixelId: '1277657707436781', token: 'forbidden' }),
    }, { ...env, META_CAPI_ACCESS_TOKEN: 'existing-worker-secret' } as Bindings)

    expect(completed.status).toBe(409)
    expect(await completed.json()).toMatchObject({ code: 'AD_PLATFORM_SECRET_MIGRATION_ALREADY_COMPLETED' })
    expect(missing.status).toBe(409)
    expect(await missing.json()).toMatchObject({ code: 'AD_PLATFORM_SECRET_MIGRATION_SOURCE_UNAVAILABLE' })
    expect(invalid.status).toBe(400)
  })

  it('Meta Secret 迁移复用 production Owner 与受信 Origin 门禁', async () => {
    const migrationEnv = { ...env, META_CAPI_ACCESS_TOKEN: 'existing-worker-secret' } as Bindings
    const nonOwner = await request(createApp('admin'), '/platforms/meta/migrate-worker-secret', {
      method: 'POST', body: JSON.stringify({ pixelId: '1277657707436781' }),
    }, migrationEnv)
    const development = await request(createApp('owner'), '/platforms/meta/migrate-worker-secret', {
      method: 'POST', body: JSON.stringify({ pixelId: '1277657707436781' }),
    }, { ...migrationEnv, APP_ENV: 'dev' } as Bindings)
    const noOrigin = await createApp('owner').request('https://api.example.test/platforms/meta/migrate-worker-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pixelId: '1277657707436781' }),
    }, migrationEnv)

    expect(nonOwner.status).toBe(403)
    expect(development.status).toBe(409)
    expect(noOrigin.status).toBe(403)
    expect(mocks.savePlatformConnection).not.toHaveBeenCalled()
  })

  it('限制请求体大小并拒绝额外字段', async () => {
    const oversized = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
    })
    const extraField = await request(createApp('owner'), '/platforms/meta', {
      method: 'PATCH',
      body: JSON.stringify({
        ...connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token'),
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
      body: JSON.stringify(connectionBody({ provider: 'meta', pixelId: '1277657707436781' }, 'access_token')),
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
    mode: 'production',
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
    rolloutTargetPercentage: 0,
  }
}
