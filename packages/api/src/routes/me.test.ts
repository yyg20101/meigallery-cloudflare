import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Bindings, Variables } from '../index'
import { hashPassword } from '../utils/password'
import { meRoutes } from './me'

function createApp(userId: number | null = 1) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('userRole', userId ? 'user' : null)
    await next()
  })
  app.route('/api/me', meRoutes)
  return app
}

function createDb(options: {
  passwordHash: string
  settingValue?: string | null
  existingEmailUser?: boolean
}) {
  const runs: Array<{ sql: string; params: unknown[] }> = []

  return {
    runs,
    prepare(sql: string) {
      const params: unknown[] = []
      return {
        bind(...values: unknown[]) {
          params.push(...values)
          return this
        },
        async first<T>() {
          if (sql.includes('SELECT password_hash, email FROM users WHERE id = ?')) {
            return { password_hash: options.passwordHash, email: 'old@example.com' } as T
          }
          if (sql.includes('SELECT id FROM users WHERE email = ? AND id != ?')) {
            return options.existingEmailUser ? { id: 2 } as T : null as T
          }
          if (sql.includes("SELECT value FROM site_settings WHERE key = 'email_verification_enabled'")) {
            return options.settingValue === undefined || options.settingValue === null
              ? null as T
              : { value: options.settingValue } as T
          }
          return null as T
        },
        async run() {
          runs.push({ sql, params: [...params] })
          return { success: true }
        },
      }
    },
  }
}

describe('用户个人信息 API', () => {
  it('邮箱验证开关历史值损坏时仍可按关闭状态修改邮箱', async () => {
    const passwordHash = await hashPassword('password123')
    const db = createDb({
      passwordHash,
      settingValue: '{"broken"',
    })

    const res = await createApp().request('/api/me/email', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        newEmail: 'new@example.com',
        password: 'password123',
      }),
    }, { DB: db } as unknown as Bindings)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.email).toBe('new@example.com')
    expect(db.runs).toHaveLength(1)
    expect(db.runs[0].sql).toContain('UPDATE users SET email = ?')
    expect(db.runs[0].params).toEqual(['new@example.com', 0, 1])
  })
})
