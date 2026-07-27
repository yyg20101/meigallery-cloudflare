import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { recordRegistration } from '../services/conversions'
import { createAdAttributionContext, sealAdAttributionContext } from '../utils/ad-attribution-context'
import { loadAttributionCryptoKeys } from '../utils/attribution-crypto'
import { authRoutes } from './auth'

vi.mock('../services/conversions', () => ({
  recordRegistration: vi.fn(),
}))

const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const recordRegistrationMock = vi.mocked(recordRegistration)

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/auth', authRoutes)
  return app
}

describe('注册 API 权威创建 CompleteRegistration', () => {
  beforeEach(() => {
    recordRegistrationMock.mockReset()
    recordRegistrationMock.mockResolvedValue(registrationResult())
  })

  it('只使用签名来源上下文创建当前平台注册事件', async () => {
    const db = createRegisterDb()
    const response = await register(db, attribution(), await sourceCookie('meta'))
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(recordRegistrationMock).toHaveBeenCalledOnce()
    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 42,
      visitorId: 'visitor_registration_42',
      sessionId: 'session_registration_42',
      attributionContext: expect.objectContaining({
        provider: 'meta',
        source: 'click_id',
        identifiers: { fbclid: 'fb-click-registration' },
      }),
      attributionSource: 'context',
      adPlatformUserData: {
        clientIpAddress: '203.0.113.10',
        clientUserAgent: 'unit-test-browser',
      },
      hashedEmail: expect.stringMatching(/^[0-9a-f]{64}$/),
      metadata: { method: 'email' },
    }))
    expect(body.trackingInstructions).toEqual([
      expect.objectContaining({ provider: 'meta', canonicalEvent: 'CompleteRegistration' }),
    ])
    expect(body).not.toHaveProperty('capi')
    expect(body).not.toHaveProperty('emailHash')
  })

  it('没有签名来源时不选择平台', async () => {
    await register(createRegisterDb(), attribution())

    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      attributionContext: null,
      attributionSource: 'none',
    }))
    const input = recordRegistrationMock.mock.calls[0]![1]
    expect(input.adPlatformUserData).toBeUndefined()
    expect(input.hashedEmail).toBeUndefined()
  })

  it('忽略客户端伪造的 provider，只采用签名来源', async () => {
    await register(
      createRegisterDb(),
      { ...attribution(), provider: 'tiktok' },
      await sourceCookie('meta'),
    )

    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      attributionContext: expect.objectContaining({ provider: 'meta' }),
      attributionSource: 'context',
    }))
  })

  it('缺少客户端身份时使用服务端用户 ID 作为稳定 fallback', async () => {
    await register(createRegisterDb(), {})

    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 42,
      visitorId: 'registration_user_42',
      sessionId: 'registration_user_42',
    }))
  })

  it('转化写入失败不回滚用户或 session，并只记录脱敏错误', async () => {
    recordRegistrationMock.mockRejectedValueOnce(new Error('private-token|203.0.113.188'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = createRegisterDb()

    const response = await register(db, attribution(), await sourceCookie('meta'))
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(body.trackingInstructions).toEqual([])
    expect(db.calls.some(call => call.sql.includes('INSERT INTO users'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO sessions'))).toBe(true)
    expect(db.calls.some(call => /DELETE\s+FROM\s+(users|sessions)/i.test(call.sql))).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[auth.register] 注册转化事实写入失败',
      { userId: 42, code: 'REGISTRATION_CONVERSION_WRITE_FAILED' },
    )
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private-token')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('new@example.com')
  })
})

function attribution() {
  return {
    visitorId: 'visitor_registration_42',
    sessionId: 'session_registration_42',
    occurredAt: '2026-07-10T08:00:00.000Z',
    routeName: 'register',
    path: '/register',
    sourceChannel: 'ad',
    sourceName: 'facebook',
    trackingSourceSlug: 'facebook-registration',
    utmSource: 'facebook',
    utmMedium: 'paid_social',
    utmCampaign: 'registration',
    utmContent: 'hero',
  }
}

async function sourceCookie(provider: 'meta' | 'tiktok' | 'google') {
  const keys = await loadAttributionCryptoKeys({
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  })
  return sealAdAttributionContext(keys, createAdAttributionContext({
    provider,
    source: 'click_id',
    identifiers: provider === 'meta'
      ? { fbclid: 'fb-click-registration' }
      : provider === 'tiktok'
        ? { ttclid: 'tt-click-registration' }
        : { gclid: 'google-click-registration' },
  }))
}

async function register(
  db: ReturnType<typeof createRegisterDb>,
  attributionInput: Record<string, unknown>,
  cookie = '',
) {
  const bindings = {
    APP_ENV: 'local',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
    AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT: MASTER_KEY,
  } as unknown as Bindings
  return createApp().request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
      'User-Agent': 'unit-test-browser',
      ...(cookie ? { Cookie: `mei_ad_attribution=${cookie}` } : {}),
    },
    body: JSON.stringify({
      email: 'new@example.com',
      username: 'newuser',
      password: 'password123',
      attribution: attributionInput,
    }),
  }, bindings)
}

type PreparedCall = { sql: string; params: unknown[] }

function registrationResult() {
  return {
    id: 'conv_registration_42',
    actionType: 'complete_registration' as const,
    created: true,
    duplicateOf: '',
    trackingInstructions: [{
      provider: 'meta' as const,
      canonicalEvent: 'CompleteRegistration' as const,
      externalEventId: 'mg3_registration_42',
      descriptor: {
        provider: 'meta' as const,
        canonicalEvent: 'CompleteRegistration' as const,
        browserEventName: 'CompleteRegistration',
        browserDestination: 'meta_pixel',
        serverDestination: 'meta_capi',
      },
      payload: {},
    }],
  }
}

function createRegisterDb() {
  const calls: PreparedCall[] = []
  return {
    calls,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          return null as T | null
        },
        async run() {
          return sql.includes('INSERT INTO users')
            ? { meta: { last_row_id: 42, changes: 1 } }
            : { meta: { changes: 1 } }
        },
      }
    },
  }
}
