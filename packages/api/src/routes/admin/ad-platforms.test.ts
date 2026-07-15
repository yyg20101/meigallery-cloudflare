import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../../index'
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
      body: JSON.stringify({ testEventCode: 'TEST16752' }),
    })
    const second = await request(app, '/platforms/meta/verify', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST99999' }),
    })
    const restarted = await request(app, '/platforms/meta/reverify', {
      method: 'POST',
      body: JSON.stringify({ testEventCode: 'TEST25401' }),
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

function createApp(role: string | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', role ? 7 : null)
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
) {
  return app.request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://gallery.example.test',
      ...init.headers,
    },
  }, env)
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
