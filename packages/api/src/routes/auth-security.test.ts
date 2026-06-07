import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { hashInviteCode } from '../services/invite-codes'
import { authRoutes } from './auth'

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/api/auth', authRoutes)
  return app
}

describe('认证接口生产安全配置', () => {
  it('生产环境缺少 Turnstile Secret 时拒绝登录', async () => {
    const res = await createApp().request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@example.com', password: 'password123' }),
    }, { APP_ENV: 'production', TURNSTILE_SECRET_KEY: '' } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.message).toContain('人机验证配置缺失')
  })

  it('注册成功后会绑定有效邀请码上下文', async () => {
    const activeHash = await hashInviteCode('ACTIVE1')
    const db = createRegisterDb(activeHash)
    const res = await createApp().request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'new@example.com',
        username: 'newuser',
        password: 'password123',
        inviteCode: 'ACTIVE1',
        analyticsVisitorId: 'visitor_abcdef',
        analyticsSessionId: 'session_abcdef',
        sourceChannel: 'Invite',
        landingPath: '/register?token=bad',
      }),
    }, { APP_ENV: 'local', DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toBe(42)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_visitors'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT INTO analytics_sessions'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('INSERT OR IGNORE INTO invite_registrations'))).toBe(true)
    expect(db.calls.some(call => call.sql.includes('UPDATE invite_codes SET used_count = used_count + 1'))).toBe(true)
    const registration = db.calls.find(call => call.sql.includes('INSERT OR IGNORE INTO invite_registrations'))
    expect(registration?.params).toContain('invite')
    expect(registration?.params).toContain('/')
  })
})

interface PreparedCall {
  sql: string
  params: unknown[]
}

function createRegisterDb(activeHash: string) {
  const calls: PreparedCall[] = []
  return {
    calls,
    prepare(sql: string) {
      const call: PreparedCall = { sql, params: [] }
      calls.push(call)
      return {
        bind(...values: unknown[]) {
          call.params = values
          return this
        },
        async first<T>() {
          if (sql.includes('site_settings')) return null as T | null
          if (sql.includes('SELECT id FROM users WHERE email = ?')) return null as T | null
          if (sql.includes('SELECT id FROM users WHERE username = ?')) return null as T | null
          if (sql.includes('FROM invite_codes')) {
            if (call.params[0] !== activeHash) return null as T | null
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
          if (sql.includes('INSERT INTO users')) {
            return { meta: { last_row_id: 42, changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
      }
    },
  }
}
