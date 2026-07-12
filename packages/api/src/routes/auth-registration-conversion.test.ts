import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { recordRegistration } from '../services/conversions'
import { hashInviteCode } from '../services/invite-codes'
import { createMarketingConsentReceipt } from '../utils/marketing-consent-receipt'
import { authRoutes } from './auth'

vi.mock('../services/conversions', () => ({
  recordRegistration: vi.fn(),
}))

const recordRegistrationMock = vi.mocked(recordRegistration)

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/auth', authRoutes)
  return app
}

describe('注册 API 权威创建 CompleteRegistration', () => {
  beforeEach(() => {
    recordRegistrationMock.mockReset()
    recordRegistrationMock.mockResolvedValue({
      id: 'conv_registration_42',
      actionType: 'complete_registration',
      created: true,
      duplicateOf: '',
      trackingInstructions: [{
        deliveryId: 'cdlv_registration_42',
        eventName: 'CompleteRegistration',
        eventId: 'meta:CompleteRegistration:complete_registration:user:42',
        payload: { method: 'email' },
        receiptToken: 'receipt_registration_42',
      }],
    })
  })

  it('用户、邀请码和 session 成功后只调用一次 recordRegistration', async () => {
    const db = createRegisterDb(await hashInviteCode('ACTIVE1'))
    let authoritativeSensitiveInput: Record<string, unknown> | undefined
    recordRegistrationMock.mockImplementationOnce(async (_env, _input, context) => {
      authoritativeSensitiveInput = await context?.getRegistrationSensitiveInput?.()
      db.events.push('record_registration')
      return registrationResult()
    })
    const response = await register(db, {
      actionType: 'lead',
      userId: 999,
      inviteCode: 'ACTIVE1',
      attribution: grantedAttribution(),
    })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(db.calls.findIndex(call => call.sql.includes('INSERT INTO sessions'))).toBeGreaterThan(
      db.calls.findIndex(call => call.sql.includes('INSERT INTO users')),
    )
    expect(recordRegistrationMock).toHaveBeenCalledOnce()
    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 42,
      visitorId: 'visitor_registration_42',
      sessionId: 'session_registration_42',
      consentState: 'granted',
      metadata: { method: 'email' },
    }), expect.objectContaining({
      getMetaCapiUserData: expect.any(Function),
      getRegistrationSensitiveInput: expect.any(Function),
    }))
    const userInsert = db.calls.find(call => call.sql.includes('INSERT INTO users'))
    const metaExternalId = String(userInsert?.params[7])
    expect(userInsert?.sql).toContain('meta_external_id')
    expect(metaExternalId).toMatch(/^[0-9a-f]{32}$/)
    expect(authoritativeSensitiveInput).toEqual({
      email: 'new@example.com',
      metaExternalId,
    })
    expect(db.calls.some(call => (
      call.sql.includes('SELECT id, email, meta_external_id')
      && call.params[0] === 42
    ))).toBe(true)
    expect(recordRegistrationMock.mock.calls[0]?.[1]).not.toHaveProperty('actionType')
    expect(recordRegistrationMock.mock.calls[0]?.[1].userId).not.toBe(999)
    expect(db.events.indexOf('invite_registration')).toBeGreaterThan(db.events.indexOf('user_insert'))
    expect(db.events.indexOf('invite_counter_update')).toBeGreaterThan(db.events.indexOf('invite_registration'))
    expect(db.events.indexOf('session_insert')).toBeGreaterThan(db.events.indexOf('invite_counter_update'))
    expect(db.events.indexOf('record_registration')).toBeGreaterThan(db.events.indexOf('session_insert'))
    expect(body.trackingInstructions).toEqual([expect.objectContaining({ eventName: 'CompleteRegistration' })])
    expect(body).not.toHaveProperty('capi')
    expect(body).not.toHaveProperty('emailHash')
    expect(JSON.stringify(body)).not.toContain('external')
    expect(JSON.stringify(db.calls.filter(call => !call.sql.includes('INSERT INTO users')))).not.toContain(metaExternalId)
  })

  it('缺少客户端身份时使用服务端用户 ID 作为稳定 fallback', async () => {
    await register(createRegisterDb(), { attribution: { consentState: 'limited' } })

    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 42,
      visitorId: 'registration_user_42',
      sessionId: 'registration_user_42',
    }), expect.anything())
  })

  it('无营销授权仍创建第一方事实且响应不含 Pixel 指令', async () => {
    recordRegistrationMock.mockResolvedValueOnce({
      id: 'conv_registration_42',
      actionType: 'complete_registration',
      created: true,
      duplicateOf: '',
      trackingInstructions: [],
    })

    const db = createRegisterDb()
    const response = await register(db, {
      attribution: { ...grantedAttribution(), consentState: 'denied' },
    })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(recordRegistrationMock).toHaveBeenCalledOnce()
    expect(recordRegistrationMock.mock.calls[0]?.[1].consentState).toBe('denied')
    expect(db.calls.some(call => call.sql.includes('SELECT id, email, meta_external_id'))).toBe(false)
    expect(body.trackingInstructions).toEqual([])
  })

  it('注册伪造 granted body 但缺少 receipt 时降级为 limited 且不读取匹配字段', async () => {
    const db = createRegisterDb()

    await register(db, { attribution: grantedAttribution() }, false)

    expect(recordRegistrationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      consentState: 'limited',
    }), expect.anything())
    expect(db.calls.some(call => call.sql.includes('SELECT id, email, meta_external_id'))).toBe(false)
  })

  it('limited 注册不会提前读取权威匹配字段', async () => {
    const db = createRegisterDb()

    await register(db, { attribution: { ...grantedAttribution(), consentState: 'limited' } })

    expect(db.calls.some(call => call.sql.includes('SELECT id, email, meta_external_id'))).toBe(false)
  })

  it('邀请码绑定异常只记录稳定 code，不记录 Error 或注册敏感值', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = createRegisterDb(await hashInviteCode('ACTIVE1'), { failInviteRegistration: true })

    const response = await register(db, {
      inviteCode: 'ACTIVE1',
      attribution: {
        ...grantedAttribution(),
        browserIdentifiers: {
          fbp: 'fb.1.1700000000000.invite-private',
          clientIpAddress: '203.0.113.199',
          clientUserAgent: 'Invite Private Browser/9.9',
        },
      },
    })
    const metaExternalId = String(db.calls.find(call => call.sql.includes('INSERT INTO users'))?.params[7])
    const logs = JSON.stringify(consoleWarn.mock.calls)

    expect(response.status).toBe(201)
    expect(consoleWarn).toHaveBeenCalledWith('[auth.register] 邀请码注册绑定失败', {
      userId: 42,
      code: 'INVITE_REGISTRATION_BIND_FAILED',
    })
    for (const sensitive of [
      'new@example.com',
      metaExternalId,
      'ACTIVE1',
      'fb.1.1700000000000.invite-private',
      '203.0.113.199',
      'Invite Private Browser/9.9',
    ]) expect(logs).not.toContain(sensitive)
  })

  it('转化写入失败不回滚用户或 session，并只记录脱敏结构化错误', async () => {
    recordRegistrationMock.mockImplementationOnce(async (_env, _input, context) => {
      const sensitive = await context?.getRegistrationSensitiveInput?.()
      throw new Error(`${sensitive?.email}|${sensitive?.metaExternalId}|token-private|203.0.113.188|private-browser`)
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = createRegisterDb()

    const response = await register(db, {
      attribution: {
        ...grantedAttribution(),
        browserIdentifiers: { fbp: 'fb.1.private', clientUserAgent: 'private-browser' },
      },
    })
    const body = await response.json<Record<string, unknown>>()
    const metaExternalId = String(db.calls.find(call => call.sql.includes('INSERT INTO users'))?.params[7])

    expect(response.status).toBe(201)
    expect(body.trackingInstructions).toEqual([])
    expect(db.calls.some(call => call.sql.includes('INSERT INTO users'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO sessions'))).toBe(true)
    expect(db.calls.some(call => /DELETE\s+FROM\s+(users|sessions)/i.test(call.sql))).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[auth.register] 注册转化事实写入失败',
      { userId: 42, code: 'REGISTRATION_CONVERSION_WRITE_FAILED' },
    )
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('new@example.com')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(metaExternalId)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('password123')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('token-private')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('203.0.113.188')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('fb.1.private')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private-browser')
  })
})

function grantedAttribution() {
  return {
    visitorId: 'visitor_registration_42',
    sessionId: 'session_registration_42',
    occurredAt: '2026-07-10T08:00:00.000Z',
    routeName: 'register',
    path: '/register',
    sourceChannel: 'ad',
    sourceName: 'release-dev-fb',
    trackingSourceSlug: 'release-dev-fb',
    utmSource: 'release-dev-fb',
    utmMedium: 'paid_social',
    utmCampaign: 'registration',
    utmContent: 'hero',
    consentState: 'granted',
    browserIdentifiers: { fbp: 'fb.1.1700000000000.123456789' },
  }
}

async function register(
  db: ReturnType<typeof createRegisterDb>,
  extra: Record<string, unknown>,
  withTrustedReceipt = true,
) {
  const requestedConsent = (extra.attribution as { consentState?: unknown } | undefined)?.consentState
  const receipt = withTrustedReceipt && requestedConsent === 'granted'
    ? await createMarketingConsentReceipt('test-session-secret', 'granted')
    : ''
  return createApp().request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'unit-test-browser',
      ...(receipt ? { Cookie: `mei_marketing_consent_receipt=${receipt}` } : {}),
    },
    body: JSON.stringify({
      email: 'new@example.com',
      username: 'newuser',
      password: 'password123',
      ...extra,
    }),
  }, {
    APP_ENV: 'local',
    DB: db,
    SESSION_SECRET: 'test-session-secret',
  } as unknown as Bindings)
}

type PreparedCall = { sql: string; params: unknown[] }

function registrationResult() {
  return {
    id: 'conv_registration_42',
    actionType: 'complete_registration' as const,
    created: true,
    duplicateOf: '',
    trackingInstructions: [{
      deliveryId: 'cdlv_registration_42',
      eventName: 'CompleteRegistration' as const,
      eventId: 'meta:CompleteRegistration:complete_registration:user:42',
      payload: { method: 'email' },
      receiptToken: 'receipt_registration_42',
    }],
  }
}

function createRegisterDb(
  activeInviteHash?: string,
  options: { failInviteRegistration?: boolean } = {},
) {
  const calls: PreparedCall[] = []
  const events: string[] = []
  return {
    calls,
    events,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return {
        bind(...params: unknown[]) {
          call.params = params
          return this
        },
        async first<T>() {
          if (sql.includes('SELECT id, email, meta_external_id') && call.params[0] === 42) {
            const userInsert = calls.find(item => item.sql.includes('INSERT INTO users'))
            events.push('registration_sensitive_select')
            return {
              id: 42,
              email: String(userInsert?.params[0]),
              meta_external_id: String(userInsert?.params[7]),
            } as T
          }
          if (sql.includes('FROM invite_codes') && call.params[0] === activeInviteHash) {
            return {
              id: 'inv_1',
              name: '活动',
              channel: 'telegram',
              status: 'active',
              max_uses: 10,
              used_count: 0,
              expires_at: null,
            } as T
          }
          return null as T | null
        },
        async run() {
          if (options.failInviteRegistration && sql.includes('INSERT OR IGNORE INTO invite_registrations')) {
            throw new Error('new@example.com|ACTIVE1|203.0.113.199|Invite Private Browser/9.9')
          }
          if (sql.includes('INSERT INTO users')) events.push('user_insert')
          if (sql.includes('INSERT OR IGNORE INTO invite_registrations')) events.push('invite_registration')
          if (sql.includes('UPDATE invite_codes SET used_count')) events.push('invite_counter_update')
          if (sql.includes('INSERT INTO sessions')) events.push('session_insert')
          return sql.includes('INSERT INTO users')
            ? { meta: { last_row_id: 42, changes: 1 } }
            : { meta: { changes: 1 } }
        },
      }
    },
  }
}
