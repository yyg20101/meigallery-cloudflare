import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings, Variables } from '../index'
import { recordRegistration } from '../services/conversions'
import { hashInviteCode } from '../services/invite-codes'
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
      pixelEvents: [{
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
    recordRegistrationMock.mockImplementationOnce(async () => {
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
    }), expect.objectContaining({ getMetaCapiUserData: expect.any(Function) }))
    expect(recordRegistrationMock.mock.calls[0]?.[1]).not.toHaveProperty('actionType')
    expect(recordRegistrationMock.mock.calls[0]?.[1].userId).not.toBe(999)
    expect(db.events.indexOf('invite_registration')).toBeGreaterThan(db.events.indexOf('user_insert'))
    expect(db.events.indexOf('invite_counter_update')).toBeGreaterThan(db.events.indexOf('invite_registration'))
    expect(db.events.indexOf('session_insert')).toBeGreaterThan(db.events.indexOf('invite_counter_update'))
    expect(db.events.indexOf('record_registration')).toBeGreaterThan(db.events.indexOf('session_insert'))
    expect(body.pixelEvents).toEqual([expect.objectContaining({ eventName: 'CompleteRegistration' })])
    expect(body).not.toHaveProperty('capi')
    expect(body).not.toHaveProperty('emailHash')
    expect(JSON.stringify(body)).not.toContain('external')
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
      pixelEvents: [],
    })

    const response = await register(createRegisterDb(), {
      attribution: { ...grantedAttribution(), consentState: 'denied' },
    })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(recordRegistrationMock).toHaveBeenCalledOnce()
    expect(recordRegistrationMock.mock.calls[0]?.[1].consentState).toBe('denied')
    expect(body.pixelEvents).toEqual([])
  })

  it('转化写入失败不回滚用户或 session，并只记录脱敏结构化错误', async () => {
    const sensitive = 'new@example.com|password123|fb.1.private|private-browser'
    recordRegistrationMock.mockRejectedValueOnce(new Error(sensitive))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = createRegisterDb()

    const response = await register(db, {
      attribution: {
        ...grantedAttribution(),
        browserIdentifiers: { fbp: 'fb.1.private', clientUserAgent: 'private-browser' },
      },
    })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(201)
    expect(body.pixelEvents).toEqual([])
    expect(db.calls.some(call => call.sql.includes('INSERT INTO users'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO sessions'))).toBe(true)
    expect(db.calls.some(call => /DELETE\s+FROM\s+(users|sessions)/i.test(call.sql))).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[auth.register] 注册转化事实写入失败',
      { userId: 42, code: 'REGISTRATION_CONVERSION_WRITE_FAILED' },
    )
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('new@example.com')
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('password123')
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

async function register(db: ReturnType<typeof createRegisterDb>, extra: Record<string, unknown>) {
  return createApp().request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'unit-test-browser' },
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
    pixelEvents: [{
      deliveryId: 'cdlv_registration_42',
      eventName: 'CompleteRegistration' as const,
      eventId: 'meta:CompleteRegistration:complete_registration:user:42',
      payload: { method: 'email' },
      receiptToken: 'receipt_registration_42',
    }],
  }
}

function createRegisterDb(activeInviteHash?: string) {
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
